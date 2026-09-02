use std::path::Path;
use std::sync::Arc;

use cubical_core::vault::relpath::contained_join;
use cubical_query::{Query, Relation, Source};
use cubical_table::TableCache;

use crate::api::types::{DataviewQueryRequest, DataviewResult};
use crate::commands::open::open_vault_cloned_for;
use crate::error::CubicalError;
use crate::plugins::Feature;
use crate::state::AppState;

fn extension_of(path: &str) -> Option<&str> {
    let name = path.rsplit('/').next()?;
    let dot = name.rfind('.')?;
    if dot == 0 {
        return None;
    }
    Some(&name[dot + 1..])
}

fn names_a_data_file(path: &str) -> bool {
    extension_of(path).is_some_and(cubical_table::supports_extension)
}

fn split_sheet(raw: &str) -> (&str, Option<&str>) {
    match raw.rsplit_once('#') {
        Some((path, sheet)) if !sheet.is_empty() && names_a_data_file(path) => (path, Some(sheet)),
        _ => (raw, None),
    }
}

fn data_file_source(query: &Query) -> Option<(&str, Option<&str>)> {
    match &query.source {
        Some(Source::Path(raw)) => {
            let (path, sheet) = split_sheet(raw);
            names_a_data_file(path).then_some((path, sheet))
        }
        _ => None,
    }
}

async fn run_over_data_file(
    cache: Arc<TableCache>,
    abs: std::path::PathBuf,
    sheet: Option<String>,
    query: Query,
) -> DataviewResult {
    let done = tokio::task::spawn_blocking(move || {
        cache
            .load(&abs, sheet.as_deref())
            .map(|table| cubical_query::run_table(&table, &query))
            .map_err(|e| e.to_string())
    })
    .await;
    match done {
        Ok(Ok(result)) => result.into(),
        Ok(Err(message)) => DataviewResult::Error { message },
        Err(e) => DataviewResult::Error {
            message: format!("reading the data file failed: {e}"),
        },
    }
}

async fn data_file_result(
    cache: Arc<TableCache>,
    root: &Path,
    path: &str,
    sheet: Option<&str>,
    query: &Query,
) -> Option<DataviewResult> {
    let abs = match contained_join(root, path) {
        Ok((_, abs)) => abs,
        Err(e) => {
            return Some(DataviewResult::Error {
                message: e.to_string(),
            })
        }
    };
    if abs.is_dir() {
        return None;
    }
    if !abs.is_file() {
        return Some(DataviewResult::Error {
            message: format!("no such file in this vault: {path}"),
        });
    }
    Some(run_over_data_file(cache, abs, sheet.map(str::to_string), query.clone()).await)
}

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

    if let Some((path, sheet)) = data_file_source(&query) {
        if let Some(result) =
            data_file_result(state.tables(), vault.root(), path, sheet, &query).await
        {
            return Ok(result);
        }
    }

    match cubical_query::run(Relation::Index(vault.index()), &query).await {
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

    const SALES_CSV: &str = "region,amount,note\nEU,120,\"has, comma\"\nUS,80,plain\nAPAC,300,\n";

    async fn state_with_data_file(rel: &str, body: &str) -> (TempDir, AppState) {
        let dir = tempdir().unwrap();
        let target = dir.path().join(rel);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, body).unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            "v1".to_string(),
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

    #[tokio::test]
    async fn a_csv_table_projects_its_own_columns_with_no_file_column() {
        let (_d, state) = state_with_data_file("data/sales.csv", SALES_CSV).await;
        match run_query(
            &state,
            "v1",
            r#"TABLE region, amount FROM "data/sales.csv" WHERE amount >= 100 SORT amount DESC"#,
        )
        .await
        {
            DataviewResult::Table {
                columns,
                rows,
                row_label,
            } => {
                assert_eq!(row_label, None);
                assert_eq!(columns, vec!["region".to_string(), "amount".to_string()]);
                let regions: Vec<_> = rows.iter().map(|r| r.cells[0].as_str()).collect();
                assert_eq!(regions, vec!["APAC", "EU"]);
                assert!(rows.iter().all(|r| r.note.is_none()));
            }
            other => panic!("expected a table, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_csv_list_uses_the_first_column_and_links_nothing() {
        let (_d, state) = state_with_data_file("data/sales.csv", SALES_CSV).await;
        match run_query(&state, "v1", r#"LIST FROM "data/sales.csv""#).await {
            DataviewResult::List { items } => {
                let texts: Vec<_> = items.iter().map(|i| i.text.as_str()).collect();
                assert_eq!(texts, vec!["EU", "US", "APAC"]);
                assert!(items.iter().all(|i| i.note.is_none()));
            }
            other => panic!("expected a list, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_csv_count_counts_matching_rows() {
        let (_d, state) = state_with_data_file("data/sales.csv", SALES_CSV).await;
        match run_query(
            &state,
            "v1",
            r#"COUNT FROM "data/sales.csv" WHERE amount >= 100"#,
        )
        .await
        {
            DataviewResult::Count { count } => assert_eq!(count, 2),
            other => panic!("expected a count, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_quoted_field_containing_the_delimiter_stays_one_cell() {
        let (_d, state) = state_with_data_file("data/sales.csv", SALES_CSV).await;
        match run_query(&state, "v1", r#"TABLE note FROM "data/sales.csv""#).await {
            DataviewResult::Table { rows, .. } => {
                assert_eq!(rows[0].cells, vec!["has, comma".to_string()]);
            }
            other => panic!("expected a table, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_missing_data_file_reports_it_in_the_block() {
        let (_d, state) = state_with_data_file("data/sales.csv", SALES_CSV).await;
        match run_query(&state, "v1", r#"LIST FROM "data/ghost.csv""#).await {
            DataviewResult::Error { message } => assert!(message.contains("data/ghost.csv")),
            other => panic!("expected an error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_folder_named_like_a_data_file_is_still_a_folder_query() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("archive.csv")).unwrap();
        fs::write(dir.path().join("archive.csv/inside.md"), ALPHA).unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let (tx, mut rx) = mpsc::channel::<ScanProgress>(64);
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
        scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");
        drain.await.unwrap();
        let state = AppState::new();
        state.vaults().write().await.insert(
            "v1".to_string(),
            OpenVault::new(
                vault,
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                cubical_core::vault::settings::SettingsMap::new(),
            ),
        );

        match run_query(&state, "v1", r#"LIST FROM "archive.csv""#).await {
            DataviewResult::List { items } => {
                let paths: Vec<_> = items
                    .iter()
                    .filter_map(|i| i.note.as_ref().map(|n| n.path.as_str()))
                    .collect();
                assert_eq!(paths, vec!["archive.csv/inside.md"]);
            }
            other => panic!("expected a folder listing, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_path_outside_the_vault_is_refused() {
        let (_d, state) = state_with_data_file("data/sales.csv", SALES_CSV).await;
        match run_query(&state, "v1", r#"LIST FROM "../escape.csv""#).await {
            DataviewResult::Error { message } => assert!(!message.is_empty()),
            other => panic!("expected an error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_quoted_folder_is_still_a_folder_query() {
        let (_d, state) = scanned_state("v1", &[("alpha.md", ALPHA)]).await;
        match run_query(&state, "v1", r#"LIST FROM "nowhere""#).await {
            DataviewResult::List { items } => assert!(items.is_empty()),
            other => panic!("expected a list, got {other:?}"),
        }
    }

    async fn state_with_workbook(rel: &str) -> (TempDir, AppState) {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../cubical-table/tests/fixtures/workbook.xlsx");
        let dir = tempdir().unwrap();
        let target = dir.path().join(rel);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::copy(&fixture, &target).expect("copy the workbook fixture");
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            "v1".to_string(),
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

    #[tokio::test]
    async fn a_workbook_reads_its_first_sheet_including_a_formulas_cached_value() {
        let (_d, state) = state_with_workbook("data/book.xlsx").await;
        match run_query(
            &state,
            "v1",
            r#"TABLE name, qty FROM "data/book.xlsx" WHERE qty >= 2"#,
        )
        .await
        {
            DataviewResult::Table { rows, .. } => {
                let names: Vec<_> = rows.iter().map(|r| r.cells[0].as_str()).collect();
                assert_eq!(names, vec!["Alpha", "Total"]);
                assert_eq!(rows[0].cells[1], "2");
                assert_eq!(rows[1].cells[1], "3.5");
            }
            other => panic!("expected a table, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_sheet_fragment_selects_that_sheet() {
        let (_d, state) = state_with_workbook("data/book.xlsx").await;
        match run_query(&state, "v1", r#"LIST FROM "data/book.xlsx#Q2""#).await {
            DataviewResult::List { items } => {
                let texts: Vec<_> = items.iter().map(|i| i.text.as_str()).collect();
                assert_eq!(texts, vec!["Oslo"]);
            }
            other => panic!("expected a list, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_unknown_sheet_names_the_sheets_that_exist() {
        let (_d, state) = state_with_workbook("data/book.xlsx").await;
        match run_query(&state, "v1", r#"LIST FROM "data/book.xlsx#Q5""#).await {
            DataviewResult::Error { message } => {
                assert!(message.contains("Q5"), "{message}");
                assert!(message.contains("Q1"), "{message}");
            }
            other => panic!("expected an error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_spreadsheet_date_reads_as_an_iso_string() {
        let (_d, state) = state_with_workbook("data/book.xlsx").await;
        match run_query(
            &state,
            "v1",
            r#"TABLE due FROM "data/book.xlsx#Q1" WHERE name = "Alpha""#,
        )
        .await
        {
            DataviewResult::Table { rows, .. } => {
                assert_eq!(rows.len(), 1);
                assert!(rows[0].cells[0].starts_with("2024-01-15"), "{:?}", rows[0]);
            }
            other => panic!("expected a table, got {other:?}"),
        }
    }

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
            DataviewResult::Table {
                columns,
                rows,
                row_label,
            } => {
                assert_eq!(row_label.as_deref(), Some("File"));
                assert_eq!(columns, vec!["status".to_string(), "due_date".to_string()]);
                let paths: Vec<_> = rows
                    .iter()
                    .filter_map(|row| row.note.as_ref().map(|n| n.path.as_str()))
                    .collect();
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
            DataviewResult::List { items } => {
                let paths: Vec<_> = items
                    .iter()
                    .filter_map(|i| i.note.as_ref().map(|n| n.path.as_str()))
                    .collect();
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
