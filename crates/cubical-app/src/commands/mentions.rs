//! Pure async command handlers for `get_unlinked_mentions` and
//! `link_mention` (L3 Session I, spec §2.9 + §3.1).
//!
//! `get_unlinked_mentions` is read-only: scans every markdown file in
//! the vault (except the open note itself) for plain-text occurrences
//! of the open note's title + aliases. The scan is on-demand — no new
//! index table, per spec.
//!
//! `link_mention` rewrites one matched span in one source file into a
//! `[[Title]]` (or `[[Title|alias]]` when the alias casing differs
//! from the title). Atomic write with on-disk hash gate.

use cubical_core::vault::links::read_source_off_executor;
use cubical_core::vault::mentions::{find_mention_occurrences, MentionHit};

use crate::api::types::{
    GetUnlinkedMentionsRequest, GetUnlinkedMentionsResponse, LinkMentionRequest,
    LinkMentionResponse, Mention,
};
use crate::commands::snippet::build_snippet;
use crate::error::CubicalError;
use crate::state::AppState;

/// Maximum markdown files scanned per request. Acts as a safety fuse
/// against pathological vaults; the spec doesn't cap it, but a
/// surprised user with 200k files is better served by a partial answer
/// than a frozen UI. Documented in §9.14 alongside the perf notes.
const MAX_SCAN_FILES: usize = 50_000;

/// List every unlinked mention of the open note's title / aliases in
/// other markdown files, with a context snippet per hit.
pub async fn get_unlinked_mentions(
    state: &AppState,
    req: GetUnlinkedMentionsRequest,
) -> Result<GetUnlinkedMentionsResponse, CubicalError> {
    let (root, conn) = {
        let guard = state.vaults().read().await;
        let open = guard
            .get(&req.vault_id)
            .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
        (
            open.vault.root().to_path_buf(),
            open.vault.index().connection().clone(),
        )
    };

    // 1) Title from the basename (minus `.md`).
    let title = title_from_path(&req.path);
    if title.is_empty() {
        return Ok(GetUnlinkedMentionsResponse {
            mentions: Vec::new(),
        });
    }

    // 2) Aliases from the frontmatter index for this path.
    let aliases = aliases_for(&conn, &req.path).await?;

    // 3) Build the needle list — title plus any aliases, case-insensitively
    //    deduped, blanks dropped. Preserve original casing for display in
    //    `Mention.needle` (powers the alias-vs-title rewrite shape).
    let needles = build_needles(&title, &aliases);
    if needles.is_empty() {
        return Ok(GetUnlinkedMentionsResponse {
            mentions: Vec::new(),
        });
    }

    // 4) Snapshot the markdown candidate paths (excluding the open note).
    let candidates = list_markdown_candidates(&conn, &req.path).await?;

    // 5) For each candidate, read + scan. Hits accumulate; sort at end.
    let mut out: Vec<Mention> = Vec::new();
    let needle_refs: Vec<&str> = needles.iter().map(|s| s.as_str()).collect();
    for path in candidates.into_iter().take(MAX_SCAN_FILES) {
        let abs = root.join(&path);
        let Some(source) = read_source_off_executor(&abs).await else {
            continue; // unreadable file = no mentions
        };
        let hits = find_mention_occurrences(&source, &needle_refs);
        for MentionHit {
            needle_index,
            byte_offset,
            byte_len,
        } in hits
        {
            let context = build_snippet(&source, byte_offset);
            out.push(Mention {
                source_path: path.clone(),
                context,
                position: byte_offset,
                byte_len,
                needle: needles[needle_index].clone(),
            });
        }
    }

    out.sort_by(|a, b| {
        a.source_path
            .cmp(&b.source_path)
            .then(a.position.cmp(&b.position))
    });
    Ok(GetUnlinkedMentionsResponse { mentions: out })
}

/// Stub for now — implemented in Task 7. The signature lands here so
/// the commands module compiles.
pub async fn link_mention(
    _state: &AppState,
    _req: LinkMentionRequest,
) -> Result<LinkMentionResponse, CubicalError> {
    Err(CubicalError::InvalidRequest(
        "link_mention not yet implemented".into(),
    ))
}

/// Compute the canonical title for a vault-relative path — its basename
/// without the `.md` extension.
fn title_from_path(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    base.strip_suffix(".md").unwrap_or(base).to_string()
}

/// Build the deduped needle list. Title always wins for case; aliases
/// with the same lowercased form as the title (or as an earlier alias)
/// are dropped. Blank entries are dropped silently.
fn build_needles(title: &str, aliases: &[String]) -> Vec<String> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    let title_t = title.trim().to_string();
    if !title_t.is_empty() {
        seen.insert(title_t.to_lowercase());
        out.push(title_t);
    }
    for a in aliases {
        let t = a.trim();
        if t.is_empty() {
            continue;
        }
        let lk = t.to_lowercase();
        if seen.insert(lk) {
            out.push(t.to_string());
        }
    }
    out
}

/// Read the `frontmatter` row for `path` with key=`aliases` and decode
/// the JSON value into a list of strings. Non-list / non-string entries
/// are silently dropped (per "Decisions": "frontmatter aliases of wrong
/// shape silently dropped").
async fn aliases_for(conn: &libsql::Connection, path: &str) -> Result<Vec<String>, CubicalError> {
    let mut rows = conn
        .query(
            "SELECT value FROM frontmatter WHERE file_path = ?1 AND key = 'aliases'",
            libsql::params![path.to_string()],
        )
        .await?;
    let Some(row) = rows.next().await? else {
        return Ok(Vec::new());
    };
    let raw: String = row.get(0)?;
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(Vec::new());
    };
    match parsed {
        serde_json::Value::Array(items) => Ok(items
            .into_iter()
            .filter_map(|v| match v {
                serde_json::Value::String(s) => Some(s),
                _ => None,
            })
            .collect()),
        serde_json::Value::String(s) => Ok(vec![s]),
        _ => Ok(Vec::new()),
    }
}

/// Every markdown `files.path` except `exclude_path`, in stable order.
async fn list_markdown_candidates(
    conn: &libsql::Connection,
    exclude_path: &str,
) -> Result<Vec<String>, CubicalError> {
    let mut rows = conn
        .query(
            "SELECT path FROM files WHERE type_id = 'markdown' AND path != ?1 ORDER BY path",
            libsql::params![exclude_path.to_string()],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let s: String = row.get(0)?;
        out.push(s);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    async fn fresh(vault_id: &str) -> (TempDir, Vault, AppState) {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.into(),
            OpenVault {
                vault: vault.clone(),
                cancel: CancellationToken::new(),
                scan_status: ScanStatusBackend::Complete,
                watcher: None,
            },
        );
        (dir, vault, state)
    }

    async fn seed_md(vault: &Vault, rel: &str, body: &str) {
        let abs = vault.root().join(rel);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&abs, body).unwrap();
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO files (path, type_id, size_bytes, mtime_unix, content_hash, inode, last_seen, created_at, updated_at) VALUES (?1, 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                libsql::params![rel],
            )
            .await
            .unwrap();
    }

    async fn seed_frontmatter(vault: &Vault, rel: &str, key: &str, json_value: &str) {
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO frontmatter (file_path, key, value) VALUES (?1, ?2, ?3)",
                libsql::params![rel, key, json_value],
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn empty_vault_returns_no_mentions() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        let resp = get_unlinked_mentions(
            &state,
            GetUnlinkedMentionsRequest {
                vault_id: "v1".into(),
                path: "Daily.md".into(),
            },
        )
        .await
        .unwrap();
        assert!(resp.mentions.is_empty());
        let _ = vault;
    }

    #[tokio::test]
    async fn finds_title_mention_in_other_file() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        seed_md(&vault, "Project.md", "I worked on the Daily today.\n").await;
        let resp = get_unlinked_mentions(
            &state,
            GetUnlinkedMentionsRequest {
                vault_id: "v1".into(),
                path: "Daily.md".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(resp.mentions.len(), 1);
        assert_eq!(resp.mentions[0].source_path, "Project.md");
        assert_eq!(resp.mentions[0].needle, "Daily");
        let _ = vault;
    }

    #[tokio::test]
    async fn excludes_already_linked_occurrence() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        seed_md(&vault, "Project.md", "see [[Daily]] for context\n").await;
        let resp = get_unlinked_mentions(
            &state,
            GetUnlinkedMentionsRequest {
                vault_id: "v1".into(),
                path: "Daily.md".into(),
            },
        )
        .await
        .unwrap();
        assert!(resp.mentions.is_empty(), "{:?}", resp.mentions);
        let _ = vault;
    }

    #[tokio::test]
    async fn excludes_match_inside_code_block() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        seed_md(&vault, "Project.md", "```\nDaily inside fence\n```\n").await;
        let resp = get_unlinked_mentions(
            &state,
            GetUnlinkedMentionsRequest {
                vault_id: "v1".into(),
                path: "Daily.md".into(),
            },
        )
        .await
        .unwrap();
        assert!(resp.mentions.is_empty());
        let _ = vault;
    }

    #[tokio::test]
    async fn alias_match_uses_alias_as_needle() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        seed_frontmatter(&vault, "Daily.md", "aliases", r#"["diary","journal"]"#).await;
        seed_md(&vault, "Project.md", "The Journal entry tracks this.\n").await;
        let resp = get_unlinked_mentions(
            &state,
            GetUnlinkedMentionsRequest {
                vault_id: "v1".into(),
                path: "Daily.md".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(resp.mentions.len(), 1);
        assert_eq!(resp.mentions[0].needle, "journal");
        let _ = vault;
    }

    #[tokio::test]
    async fn open_note_self_is_excluded() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "I am the Daily, talking about Daily.\n").await;
        let resp = get_unlinked_mentions(
            &state,
            GetUnlinkedMentionsRequest {
                vault_id: "v1".into(),
                path: "Daily.md".into(),
            },
        )
        .await
        .unwrap();
        assert!(resp.mentions.is_empty());
        let _ = vault;
    }

    #[tokio::test]
    async fn stable_ordering_by_path_then_position() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        seed_md(&vault, "B.md", "Daily here\n").await;
        seed_md(&vault, "A.md", "first Daily\nsecond Daily\n").await;
        let resp = get_unlinked_mentions(
            &state,
            GetUnlinkedMentionsRequest {
                vault_id: "v1".into(),
                path: "Daily.md".into(),
            },
        )
        .await
        .unwrap();
        let paths: Vec<&str> = resp
            .mentions
            .iter()
            .map(|m| m.source_path.as_str())
            .collect();
        assert_eq!(paths, vec!["A.md", "A.md", "B.md"]);
        assert!(resp.mentions[0].position < resp.mentions[1].position);
        let _ = vault;
    }

    #[tokio::test]
    async fn frontmatter_aliases_of_wrong_shape_are_dropped() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        // Non-list aliases (a YAML scalar number) — silently dropped.
        seed_frontmatter(&vault, "Daily.md", "aliases", "42").await;
        seed_md(&vault, "Other.md", "Daily mention here\n").await;
        let resp = get_unlinked_mentions(
            &state,
            GetUnlinkedMentionsRequest {
                vault_id: "v1".into(),
                path: "Daily.md".into(),
            },
        )
        .await
        .unwrap();
        // Title still matches.
        assert_eq!(resp.mentions.len(), 1);
        let _ = vault;
    }

    #[tokio::test]
    async fn unknown_vault_errors() {
        let (_dir, _vault, state) = fresh("v1").await;
        let err = get_unlinked_mentions(
            &state,
            GetUnlinkedMentionsRequest {
                vault_id: "ghost".into(),
                path: "Daily.md".into(),
            },
        )
        .await
        .expect_err("expected VaultNotOpen");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }
}
