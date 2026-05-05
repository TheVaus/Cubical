# Recommended `.gitignore` for a Cubical vault

Most users will git-init their vault. The `.cubical/index.db` is rebuildable from the markdown — committing it would be churn-heavy. The `.cubical/config.toml` is *not* gitignored, since users may want vault-local config under version control.

Drop this snippet into `<vault>/.gitignore`:

```gitignore
# Cubical-managed derived state — rebuildable from .md files
.cubical/index.db
.cubical/index.db-wal
.cubical/index.db-shm
.cubical/cubical.log
.cubical/recovery/        # appears at L7 (sync) — pre-merge snapshots
```

## What about `.assets/`?

Most PKM users want assets (images, PDFs) tracked in git so the vault stays self-contained. If you have very large binaries you'd rather not commit, you can add `.assets/` to your vault's `.gitignore`, but the recommended default is to keep them tracked.
