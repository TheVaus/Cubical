use std::collections::BTreeMap;
use std::fs;

use cubical_core::vault::settings::SettingsMap;
use cubical_core::Vault;
use cubical_engine::api::types::{
    DataviewQueryRequest, DataviewResult, GetUnlinkedMentionsRequest, GraphFilter,
    GraphSnapshotRequest, LinkAutocompleteRequest, QueryTagPageRequest,
};
use cubical_engine::commands::autocomplete::link_autocomplete;
use cubical_engine::commands::dataview::dataview_query;
use cubical_engine::commands::graph::graph_snapshot;
use cubical_engine::commands::mentions::get_unlinked_mentions;
use cubical_engine::commands::tags::query_tag_page;
use cubical_engine::state::{AppState, OpenVault, ScanStatusBackend};
use cubical_index::{replace_tags_for_file, TagRow, TagSource};
use tempfile::{tempdir, TempDir};
use tokio_util::sync::CancellationToken;

const PATHS: [&str; 7] = [
    "notes.md",
    "notes.txt",
    "a.b.md",
    "no-extension",
    ".hidden",
    "folder/note.md",
    "assets/diagram.png",
];

const TAG: &str = "cases";

async fn vault_with_cases() -> (TempDir, AppState) {
    let dir = tempdir().expect("tempdir");
    for rel in PATHS {
        let abs = dir.path().join(rel);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(&abs, "body\n").expect("write");
    }

    let vault = Vault::open(dir.path()).await.expect("open vault");
    for rel in PATHS {
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO files (
                     path, type_id, size_bytes, mtime_unix, content_hash,
                     inode, last_seen, created_at, updated_at
                 ) VALUES (?1, 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                libsql::params![rel],
            )
            .await
            .expect("seed files row");
        replace_tags_for_file(
            vault.index(),
            rel,
            &[TagRow {
                tag_path: TAG.into(),
                source: TagSource::Inline,
            }],
        )
        .await
        .expect("seed tag row");
    }

    let state = AppState::new();
    state.vaults().write().await.insert(
        "v1".to_string(),
        OpenVault::new(
            vault,
            CancellationToken::new(),
            ScanStatusBackend::Complete,
            None,
            SettingsMap::new(),
        ),
    );
    (dir, state)
}

async fn titles_by_feature(state: &AppState) -> BTreeMap<&'static str, BTreeMap<String, String>> {
    let mut out: BTreeMap<&'static str, BTreeMap<String, String>> = BTreeMap::new();

    let tag_page = query_tag_page(
        state,
        QueryTagPageRequest {
            vault_id: "v1".into(),
            tag_path: TAG.into(),
        },
    )
    .await
    .expect("tag page");
    out.insert(
        "tag page",
        tag_page
            .files
            .into_iter()
            .map(|f| (f.path, f.title))
            .collect(),
    );

    let candidates = link_autocomplete(
        state,
        LinkAutocompleteRequest {
            vault_id: "v1".into(),
            query: String::new(),
        },
    )
    .await
    .expect("autocomplete");
    out.insert(
        "link autocomplete",
        candidates
            .candidates
            .into_iter()
            .map(|c| (c.path, c.title))
            .collect(),
    );

    let dataview = dataview_query(
        state,
        DataviewQueryRequest {
            vault_id: "v1".into(),
            source: "LIST".into(),
        },
    )
    .await
    .expect("dataview");
    let DataviewResult::List { notes } = dataview else {
        panic!("expected a LIST result");
    };
    out.insert(
        "dataview",
        notes.into_iter().map(|n| (n.path, n.title)).collect(),
    );

    let snapshot = graph_snapshot(
        state,
        GraphSnapshotRequest {
            vault_id: "v1".into(),
            filter: GraphFilter::default(),
        },
    )
    .await
    .expect("graph snapshot");
    out.insert(
        "graph",
        snapshot
            .nodes
            .into_iter()
            .map(|n| (n.key, n.label))
            .collect(),
    );

    out.insert(
        "search index",
        PATHS
            .iter()
            .map(|p| {
                (
                    (*p).to_string(),
                    cubical_search::doc::project(p, "body\n", 0, 5).title,
                )
            })
            .collect(),
    );

    out
}

#[tokio::test]
async fn every_feature_derives_the_same_title_for_the_same_path() {
    let (_dir, state) = vault_with_cases().await;
    let by_feature = titles_by_feature(&state).await;

    for path in PATHS {
        let expected = cubical_ast::note_title(path);
        for (feature, titles) in &by_feature {
            let got = titles
                .get(path)
                .unwrap_or_else(|| panic!("{feature} produced no title for {path}"));
            assert_eq!(
                got, expected,
                "{feature} titles {path} as {got}, not {expected}"
            );
        }
    }
}

#[tokio::test]
async fn unlinked_mentions_search_for_the_same_title() {
    for path in PATHS {
        let expected = cubical_ast::note_title(path);
        let (dir, state) = vault_with_cases().await;
        fs::write(
            dir.path().join("probe.md"),
            format!("A line naming {expected} once.\n"),
        )
        .expect("probe");
        {
            let guard = state.vaults().read().await;
            let vault = guard.get("v1").expect("open vault").vault.clone();
            vault
                .index()
                .connection()
                .execute(
                    "INSERT INTO files (
                         path, type_id, size_bytes, mtime_unix, content_hash,
                         inode, last_seen, created_at, updated_at
                     ) VALUES ('probe.md', 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                    (),
                )
                .await
                .expect("seed probe row");
        }

        let resp = get_unlinked_mentions(
            &state,
            GetUnlinkedMentionsRequest {
                vault_id: "v1".into(),
                path: path.into(),
            },
        )
        .await
        .expect("mentions");

        let hit = resp
            .mentions
            .iter()
            .find(|m| m.source_path == "probe.md")
            .unwrap_or_else(|| panic!("no mention of {expected} found for {path}"));
        assert_eq!(hit.needle, expected, "mention needle for {path}");
    }
}
