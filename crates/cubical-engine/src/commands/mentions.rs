use cubical_ast::note_title;
use cubical_core::vault::links::read_source_off_executor;
use cubical_core::vault::mentions::{find_mention_occurrences, MentionHit};
use cubical_core::vault::pending::materialize_on_read;
use cubical_core::{atomic_write, sha256_bytes_hex};

use crate::api::types::{
    GetUnlinkedMentionsRequest, GetUnlinkedMentionsResponse, LinkMentionRequest,
    LinkMentionResponse, Mention,
};
use crate::commands::open::open_vault_cloned;
use crate::commands::snippet::build_snippet;
use crate::error::CubicalError;
use crate::state::AppState;

const MAX_SCAN_FILES: usize = 50_000;

pub async fn get_unlinked_mentions(
    state: &AppState,
    req: GetUnlinkedMentionsRequest,
) -> Result<GetUnlinkedMentionsResponse, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let root = vault.root().to_path_buf();
    let conn = vault.index().connection().clone();

    let title = note_title(&req.path).to_string();
    if title.is_empty() {
        return Ok(GetUnlinkedMentionsResponse {
            mentions: Vec::new(),
        });
    }

    let aliases = aliases_for(&conn, &req.path).await?;

    let needles = build_needles(&title, &aliases);
    if needles.is_empty() {
        return Ok(GetUnlinkedMentionsResponse {
            mentions: Vec::new(),
        });
    }

    let candidates = list_markdown_candidates(&conn, &req.path).await?;

    let mut out: Vec<Mention> = Vec::new();
    let needle_refs: Vec<&str> = needles.iter().map(|s| s.as_str()).collect();
    for path in candidates.into_iter().take(MAX_SCAN_FILES) {
        let abs = root.join(&path);
        let Some(on_disk) = read_source_off_executor(&abs).await else {
            continue;
        };
        let source = materialize_on_read(vault.index(), &path, &on_disk).await?;
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

pub async fn link_mention(
    state: &AppState,
    req: LinkMentionRequest,
) -> Result<LinkMentionResponse, CubicalError> {
    let vault = open_vault_cloned(state, &req.vault_id).await?;
    let conn = vault.index().connection().clone();
    let (source_path, abs) = crate::commands::paths::vault_file(&vault, &req.source_path)?;

    let pending_count = {
        let mut rows = conn
            .query(
                "SELECT COUNT(*) FROM pending_rewrites WHERE target_file = ?1",
                libsql::params![source_path.clone()],
            )
            .await?;
        let row = rows
            .next()
            .await?
            .ok_or_else(|| CubicalError::Db("pending count query returned no row".into()))?;
        row.get::<i64>(0)?
    };
    if pending_count > 0 {
        crate::commands::rename::flush_target_for_link_mention(state, &req.vault_id, &source_path)
            .await?;
    }

    let source = tokio::task::spawn_blocking({
        let abs = abs.clone();
        move || std::fs::read_to_string(&abs)
    })
    .await
    .map_err(|e| CubicalError::Io(format!("read task join error: {e}")))?
    .map_err(|e| CubicalError::Io(e.to_string()))?;

    let start = req.position as usize;
    let end = start.saturating_add(req.byte_len as usize);
    if end > source.len() {
        return Err(CubicalError::InvalidRequest(
            "mention span out of bounds (file changed since fetch)".into(),
        ));
    }
    if !source.is_char_boundary(start) || !source.is_char_boundary(end) {
        return Err(CubicalError::InvalidRequest(
            "mention span does not land on UTF-8 boundaries".into(),
        ));
    }

    let matched = &source[start..end];
    let title = req.target_title.trim();
    if title.is_empty() {
        return Err(CubicalError::InvalidRequest(
            "target_title must not be empty".into(),
        ));
    }

    if matched.chars().all(|c| !c.is_alphanumeric() && c != '_') {
        return Err(CubicalError::InvalidRequest(
            "mention span no longer contains a word".into(),
        ));
    }
    let prev_ok = matched_neighbor_ok(&source, start, true);
    let next_ok = matched_neighbor_ok(&source, end, false);
    if !prev_ok || !next_ok {
        return Err(CubicalError::InvalidRequest(
            "mention has moved (whole-word boundary lost)".into(),
        ));
    }

    let replacement = if matched.to_lowercase() == title.to_lowercase() {
        format!("[[{title}]]")
    } else {
        format!("[[{title}|{matched}]]")
    };

    let mut new_contents = String::with_capacity(source.len() + replacement.len());
    new_contents.push_str(&source[..start]);
    new_contents.push_str(&replacement);
    new_contents.push_str(&source[end..]);

    let new_bytes = new_contents.into_bytes();
    let new_hash = sha256_bytes_hex(&new_bytes);

    let abs_for_write = abs.clone();
    let bytes_for_write = new_bytes.clone();
    tokio::task::spawn_blocking(move || atomic_write(&abs_for_write, &bytes_for_write))
        .await
        .map_err(|e| CubicalError::Io(format!("write task join error: {e}")))??;

    {
        if let Err(e) = conn
            .execute(
                "UPDATE files SET content_hash = ?1, size_bytes = ?2 WHERE path = ?3",
                libsql::params![
                    new_hash.clone(),
                    new_bytes.len() as i64,
                    source_path.clone(),
                ],
            )
            .await
        {
            tracing::debug!(error = %e, "link_mention: files-row update failed (watcher will catch up)");
        }
    }

    Ok(LinkMentionResponse { new_hash })
}

fn matched_neighbor_ok(source: &str, byte_idx: usize, before: bool) -> bool {
    if before {
        match source[..byte_idx].chars().next_back() {
            None => true,
            Some(c) => !c.is_alphanumeric() && c != '_',
        }
    } else {
        match source[byte_idx..].chars().next() {
            None => true,
            Some(c) => !c.is_alphanumeric() && c != '_',
        }
    }
}

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

    #[tokio::test]
    async fn get_unlinked_mentions_materializes_candidate_source() {
        use cubical_index::{enqueue_pending, NewPendingRewrite, RewriteKind};

        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        seed_md(&vault, "Project.md", "see [[OldName]] for context\n").await;
        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "Project.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "OldName".into(),
                new_token: "Daily".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

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
    async fn link_mention_rewrites_span_and_returns_new_hash() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        let body = "I worked on the Daily today.\n";
        seed_md(&vault, "Project.md", body).await;

        let pos = body.find("Daily").unwrap() as u64;
        let resp = link_mention(
            &state,
            LinkMentionRequest {
                vault_id: "v1".into(),
                source_path: "Project.md".into(),
                position: pos,
                byte_len: 5,
                target_title: "Daily".into(),
            },
        )
        .await
        .expect("ok");

        let on_disk = std::fs::read_to_string(vault.root().join("Project.md")).unwrap();
        assert_eq!(on_disk, "I worked on the [[Daily]] today.\n");
        assert_eq!(
            resp.new_hash,
            cubical_core::sha256_bytes_hex(on_disk.as_bytes())
        );
    }

    #[tokio::test]
    async fn link_mention_emits_alias_form_when_target_differs_case_insensitively() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        let body = "The Journal entry tracks this.\n";
        seed_md(&vault, "Project.md", body).await;

        let pos = body.find("Journal").unwrap() as u64;
        link_mention(
            &state,
            LinkMentionRequest {
                vault_id: "v1".into(),
                source_path: "Project.md".into(),
                position: pos,
                byte_len: 7,
                target_title: "Daily".into(),
            },
        )
        .await
        .unwrap();
        let on_disk = std::fs::read_to_string(vault.root().join("Project.md")).unwrap();
        assert_eq!(on_disk, "The [[Daily|Journal]] entry tracks this.\n");
    }

    #[tokio::test]
    async fn link_mention_uses_bare_form_when_match_equals_title_case_insensitively() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        let body = "The daily check-in is done.\n";
        seed_md(&vault, "Project.md", body).await;

        let pos = body.find("daily").unwrap() as u64;
        link_mention(
            &state,
            LinkMentionRequest {
                vault_id: "v1".into(),
                source_path: "Project.md".into(),
                position: pos,
                byte_len: 5,
                target_title: "Daily".into(),
            },
        )
        .await
        .unwrap();
        let on_disk = std::fs::read_to_string(vault.root().join("Project.md")).unwrap();
        assert_eq!(on_disk, "The [[Daily]] check-in is done.\n");
    }

    #[tokio::test]
    async fn link_mention_handles_non_ascii_title_with_unicode_case_fold() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "CAFÉ.md", "body").await;
        let body = "see café for context\n";
        seed_md(&vault, "Project.md", body).await;
        let pos = body.find("café").unwrap() as u64;
        link_mention(
            &state,
            LinkMentionRequest {
                vault_id: "v1".into(),
                source_path: "Project.md".into(),
                position: pos,
                byte_len: "café".len() as u64,
                target_title: "CAFÉ".into(),
            },
        )
        .await
        .unwrap();
        let on_disk = std::fs::read_to_string(vault.root().join("Project.md")).unwrap();
        assert_eq!(on_disk, "see [[CAFÉ]] for context\n");
    }

    #[tokio::test]
    async fn link_mention_invalidrequest_when_span_no_longer_alphanumeric() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        seed_md(&vault, "Project.md", "                  short body\n").await;

        let err = link_mention(
            &state,
            LinkMentionRequest {
                vault_id: "v1".into(),
                source_path: "Project.md".into(),
                position: 0,
                byte_len: 5,
                target_title: "Daily".into(),
            },
        )
        .await
        .expect_err("expected InvalidRequest");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn link_mention_invalidrequest_when_span_out_of_bounds() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        seed_md(&vault, "Project.md", "tiny\n").await;

        let err = link_mention(
            &state,
            LinkMentionRequest {
                vault_id: "v1".into(),
                source_path: "Project.md".into(),
                position: 999,
                byte_len: 5,
                target_title: "Daily".into(),
            },
        )
        .await
        .expect_err("expected InvalidRequest");
        assert!(matches!(err, CubicalError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn link_mention_flushes_pending_rewrites_before_splicing() {
        use cubical_index::{enqueue_pending, pending_for_target, NewPendingRewrite, RewriteKind};

        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        let body = "see [[OldName]] and mention Daily here\n";
        seed_md(&vault, "Project.md", body).await;
        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "Project.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "OldName".into(),
                new_token: "Daily".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        let post_flush_body = "see [[Daily]] and mention Daily here\n";
        let pos = post_flush_body.find("mention Daily").unwrap() + "mention ".len();
        link_mention(
            &state,
            LinkMentionRequest {
                vault_id: "v1".into(),
                source_path: "Project.md".into(),
                position: pos as u64,
                byte_len: 5,
                target_title: "Daily".into(),
            },
        )
        .await
        .expect("ok");

        let on_disk = std::fs::read_to_string(vault.root().join("Project.md")).unwrap();
        assert_eq!(on_disk, "see [[Daily]] and mention [[Daily]] here\n");
        let remaining = pending_for_target(vault.index(), "Project.md")
            .await
            .unwrap();
        assert!(remaining.is_empty());
    }

    #[tokio::test]
    async fn link_mention_unknown_vault_errors() {
        let (_dir, _vault, state) = fresh("v1").await;
        let err = link_mention(
            &state,
            LinkMentionRequest {
                vault_id: "ghost".into(),
                source_path: "Project.md".into(),
                position: 0,
                byte_len: 5,
                target_title: "Daily".into(),
            },
        )
        .await
        .expect_err("expected VaultNotOpen");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }
}
