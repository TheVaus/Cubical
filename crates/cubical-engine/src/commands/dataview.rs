use crate::api::types::{DataviewQueryRequest, DataviewResult};
use crate::commands::open::open_vault_cloned_for;
use crate::error::CubicalError;
use crate::plugins::Feature;
use crate::state::AppState;

pub async fn dataview_query(
    state: &AppState,
    req: DataviewQueryRequest,
) -> Result<DataviewResult, CubicalError> {
    let vault = open_vault_cloned_for(state, &req.vault_id, Feature::Dataview).await?;

    let query = match cubical_query::parse(&req.source) {
        Ok(q) => q,
        Err(e) => {
            return Ok(DataviewResult::Error {
                message: e.to_string(),
            })
        }
    };
    match cubical_query::run(vault.index(), &query).await {
        Ok(result) => Ok(result.into()),
        Err(e) => Ok(DataviewResult::Error {
            message: e.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AppState, OpenVault, ScanStatusBackend};
    use cubical_core::{scan, ScanProgress, Vault};
    use std::fs;
    use tempfile::{tempdir, TempDir};
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    async fn fresh_state_with_vault(vault_id: &str) -> (TempDir, Vault, AppState) {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault::new(
                vault.clone(),
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );
        (dir, vault, state)
    }

    async fn scanned_state(vault_id: &str, files: &[(&str, &str)]) -> (TempDir, AppState) {
        let dir = tempdir().unwrap();
        for (rel, body) in files {
            fs::write(dir.path().join(rel), body).unwrap();
        }
        let vault = Vault::open(dir.path()).await.expect("open");
        let (tx, mut rx) = mpsc::channel::<ScanProgress>(64);
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");
        drain.await.unwrap();
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault::new(
                vault,
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );
        (dir, state)
    }

    const ALPHA: &str = "---\nstatus: in-progress\npriority: 3\ndue_date: \"2026-07-10\"\ntags: [project]\n---\n# Alpha\n";
    const BETA: &str =
        "---\nstatus: done\npriority: 1\ndue_date: \"2026-06-01\"\ntags: [project]\n---\n# Beta\n";
    const GAMMA: &str = "---\nstatus: in-progress\npriority: 2\ndue_date: \"2026-08-15\"\ntags: [project]\n---\n# Gamma\n";

    async fn switch(state: &AppState, vault_id: &str, key: &str, on: bool) {
        let settings = crate::commands::open::with_open_vault(state, vault_id, |open| {
            std::sync::Arc::clone(&open.settings)
        })
        .await
        .expect("vault open");
        settings
            .write()
            .await
            .insert(key.to_string(), serde_json::json!(on));
    }

    async fn run_query(state: &AppState, vault_id: &str, source: &str) -> DataviewResult {
        dataview_query(
            state,
            DataviewQueryRequest {
                vault_id: vault_id.into(),
                source: source.into(),
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn end_to_end_table_from_tag_where_sort() {
        let (_d, state) = scanned_state(
            "v1",
            &[("alpha.md", ALPHA), ("beta.md", BETA), ("gamma.md", GAMMA)],
        )
        .await;
        let r = run_query(
            &state,
            "v1",
            r#"TABLE status, due_date FROM #project WHERE status = "in-progress" SORT due_date ASC"#,
        )
        .await;
        match r {
            DataviewResult::Table { columns, rows } => {
                assert_eq!(columns, vec!["status".to_string(), "due_date".to_string()]);
                let paths: Vec<_> = rows.iter().map(|row| row.note.path.as_str()).collect();
                assert_eq!(paths, vec!["alpha.md", "gamma.md"]);
                assert_eq!(
                    rows[0].cells,
                    vec!["in-progress".to_string(), "2026-07-10".to_string()]
                );
            }
            other => panic!("expected table, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn end_to_end_list_numeric_where() {
        let (_d, state) = scanned_state(
            "v1",
            &[("alpha.md", ALPHA), ("beta.md", BETA), ("gamma.md", GAMMA)],
        )
        .await;
        match run_query(&state, "v1", "LIST WHERE priority >= 2").await {
            DataviewResult::List { notes } => {
                let paths: Vec<_> = notes.iter().map(|n| n.path.as_str()).collect();
                assert_eq!(paths, vec!["alpha.md", "gamma.md"]);
            }
            other => panic!("expected list, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn end_to_end_count_and_bad_query() {
        let (_d, state) = scanned_state(
            "v1",
            &[("alpha.md", ALPHA), ("beta.md", BETA), ("gamma.md", GAMMA)],
        )
        .await;
        match run_query(&state, "v1", r#"COUNT WHERE status = "done""#).await {
            DataviewResult::Count { count } => assert_eq!(count, 1),
            other => panic!("expected count, got {other:?}"),
        }
        match run_query(&state, "v1", "TABLE oops WHERE").await {
            DataviewResult::Error { message } => assert!(!message.is_empty()),
            other => panic!("expected error, got {other:?}"),
        }
    }

    async fn seed(vault: &Vault, path: &str, status_json: &str) {
        let c = vault.index().connection();
        c.execute(
            "INSERT INTO files (path, type_id, size_bytes, mtime_unix, content_hash, \
             inode, last_seen, created_at, updated_at) VALUES (?1,'markdown',0,0,'',NULL,0,0,0)",
            libsql::params![path],
        )
        .await
        .unwrap();
        c.execute(
            "INSERT INTO frontmatter (file_path, key, value) VALUES (?1,'status',?2)",
            libsql::params![path, status_json],
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn count_matches() {
        let (_d, vault, state) = fresh_state_with_vault("v1").await;
        seed(&vault, "a.md", "\"in-progress\"").await;
        seed(&vault, "b.md", "\"done\"").await;
        let req = DataviewQueryRequest {
            vault_id: "v1".into(),
            source: r#"COUNT WHERE status = "in-progress""#.into(),
        };
        match dataview_query(&state, req).await.unwrap() {
            DataviewResult::Count { count } => assert_eq!(count, 1),
            other => panic!("expected count, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn bad_query_returns_error_variant_not_err() {
        let (_d, _vault, state) = fresh_state_with_vault("v1").await;
        let req = DataviewQueryRequest {
            vault_id: "v1".into(),
            source: "FETCH stuff".into(),
        };
        match dataview_query(&state, req).await.unwrap() {
            DataviewResult::Error { message } => assert!(!message.is_empty()),
            other => panic!("expected error variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unknown_vault_errors() {
        let (_d, _vault, state) = fresh_state_with_vault("v1").await;
        let req = DataviewQueryRequest {
            vault_id: "ghost".into(),
            source: "LIST".into(),
        };
        let err = dataview_query(&state, req)
            .await
            .expect_err("vault-not-open");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }

    #[tokio::test]
    async fn a_query_is_refused_while_the_query_plugin_is_off() {
        let (_d, state) = scanned_state("v1", &[("alpha.md", ALPHA)]).await;
        switch(&state, "v1", "plugins.dataview_enabled", false).await;

        let err = dataview_query(
            &state,
            DataviewQueryRequest {
                vault_id: "v1".into(),
                source: "LIST FROM #project".into(),
            },
        )
        .await
        .expect_err("a switched-off plugin must not be served");

        assert!(matches!(err, CubicalError::FeatureDisabled(id) if id == "dataview"));
    }

    #[tokio::test]
    async fn a_query_runs_again_once_the_plugin_is_switched_back_on() {
        let (_d, state) = scanned_state("v1", &[("alpha.md", ALPHA)]).await;
        switch(&state, "v1", "plugins.dataview_enabled", false).await;
        switch(&state, "v1", "plugins.dataview_enabled", true).await;

        let r = run_query(&state, "v1", "LIST FROM #project").await;
        assert!(matches!(r, DataviewResult::List { .. }));
    }
}
