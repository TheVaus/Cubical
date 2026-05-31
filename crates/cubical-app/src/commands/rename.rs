//! Rename IPC handlers (L3 Session J, spec §2.10).
//!
//! **Chain-3 stub.** Only the per-target flush helper used by
//! `link_mention` lives here today. The full `rename_file` /
//! `rename_tag` / `rename_block_id` / `flush_pending_rewrites` /
//! `flush_pending_rewrites_for_target` IPC handlers land in chain 4 —
//! they will reuse [`flush_target_for_link_mention`] (or a renamed
//! superset) as their per-target executor.
//!
//! See `docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`
//! "Flush + helpers" and "Read-path integration".

use cubical_core::vault::pending::apply_pending;
use cubical_core::{atomic_write, sha256_bytes_hex};
use cubical_index::{delete_pending_for_target, pending_for_target};

use crate::error::CubicalError;
use crate::state::AppState;

/// Flush every pending rewrite targeting `target_file`: materialize the
/// rewrites against the on-disk source, atomically write the result
/// back, and drop the matching rows from `pending_rewrites`. Used by
/// [`crate::commands::mentions::link_mention`] as a precondition so the
/// span-splice operates on the post-rewrite text.
///
/// No-op when no pending rows match `target_file` — the function still
/// fetches a fresh `IndexConn` query, but stops before the read/write
/// pair. Returns `Ok(())` either way.
///
/// **Chain-3 invariant:** the splice in `link_mention` happens AFTER
/// this returns, against a freshly-read on-disk source. Calling
/// `flush_target_for_link_mention` first means the splice-input no
/// longer disagrees with `materialize_on_read`'s view, closing the
/// "splice into materialized but write non-materialized" trap called
/// out in the design spec.
pub(crate) async fn flush_target_for_link_mention(
    state: &AppState,
    vault_id: &str,
    target_file: &str,
) -> Result<(), CubicalError> {
    let vault = {
        let guard = state.vaults().read().await;
        let open = guard
            .get(vault_id)
            .ok_or_else(|| CubicalError::VaultNotOpen(vault_id.to_string()))?;
        open.vault.clone()
    };

    let rows = pending_for_target(vault.index(), target_file).await?;
    if rows.is_empty() {
        return Ok(());
    }

    // Read the file's current on-disk bytes.
    let abs = vault.root().join(target_file);
    let abs_for_read = abs.clone();
    let on_disk = tokio::task::spawn_blocking(move || std::fs::read_to_string(&abs_for_read))
        .await
        .map_err(|e| CubicalError::Io(format!("flush read task join error: {e}")))?
        .map_err(|e| CubicalError::Io(e.to_string()))?;

    let materialized = apply_pending(&on_disk, &rows);
    if materialized == on_disk {
        // No-op rewrite (e.g. token never matched). Still drop the
        // pending rows: they're satisfied as far as this file is
        // concerned, just without a content change.
        delete_pending_for_target(vault.index(), target_file).await?;
        return Ok(());
    }

    let new_bytes = materialized.into_bytes();
    let new_hash = sha256_bytes_hex(&new_bytes);

    let abs_for_write = abs.clone();
    let bytes_for_write = new_bytes.clone();
    tokio::task::spawn_blocking(move || atomic_write(&abs_for_write, &bytes_for_write))
        .await
        .map_err(|e| CubicalError::Io(format!("flush write task join error: {e}")))??;

    // Drop pending rows for this target now that the file reflects them.
    delete_pending_for_target(vault.index(), target_file).await?;

    // Best-effort eager content_hash update; the watcher echo will heal
    // any race here. (Mirrors `link_mention` and `write_file_text`.)
    let _ = vault
        .index()
        .connection()
        .execute(
            "UPDATE files SET content_hash = ?1, size_bytes = ?2 WHERE path = ?3",
            libsql::params![new_hash, new_bytes.len() as i64, target_file.to_string()],
        )
        .await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use cubical_index::{enqueue_pending, NewPendingRewrite, RewriteKind};
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

    #[tokio::test]
    async fn flush_noop_when_no_pending_rows() {
        let (_dir, vault, state) = fresh("v1").await;
        std::fs::write(vault.root().join("A.md"), "body\n").unwrap();
        flush_target_for_link_mention(&state, "v1", "A.md")
            .await
            .expect("ok");
        // File untouched.
        let s = std::fs::read_to_string(vault.root().join("A.md")).unwrap();
        assert_eq!(s, "body\n");
    }

    #[tokio::test]
    async fn flush_writes_materialized_source_and_drops_rows() {
        let (_dir, vault, state) = fresh("v1").await;
        std::fs::write(vault.root().join("Project.md"), "see [[Daily]] today\n").unwrap();

        enqueue_pending(
            vault.index(),
            &[NewPendingRewrite {
                target_file: "Project.md".into(),
                rewrite_kind: RewriteKind::WikiLink,
                old_token: "Daily".into(),
                new_token: "Journal".into(),
                created_at: 0,
                rename_op_id: 1,
            }],
        )
        .await
        .unwrap();

        flush_target_for_link_mention(&state, "v1", "Project.md")
            .await
            .expect("ok");

        let s = std::fs::read_to_string(vault.root().join("Project.md")).unwrap();
        assert_eq!(s, "see [[Journal]] today\n");
        // Pending rows for Project.md are gone.
        let remaining = pending_for_target(vault.index(), "Project.md")
            .await
            .unwrap();
        assert!(remaining.is_empty());
    }
}
