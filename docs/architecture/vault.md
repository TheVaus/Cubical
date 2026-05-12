> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)
>
> *Covers §3 (vault), §4 (file identity), §9 (binary assets). Remaining sections live in sibling files — see [README.md](README.md).*

# Cubical — Architecture: Vault

## 3. The vault

A vault is a directory on disk. The user picks it; Cubical does not own the location.

```
<vault>/
├── any/folder/structure/the/user/wants/
│   ├── note-a.md
│   ├── note-b.md
│   └── ...
├── .assets/                 # deduplicated binary assets
│   ├── ab/cd/abcd1234...png
│   └── ...
└── .cubical/
    ├── index.db             # libSQL: metadata, links, CRDT logs (post-L7), snapshots (post-L7)
    ├── config.toml          # vault-local config (overrides global)
    ├── themes/              # user-installed CSS themes (L5+)
    └── recovery/            # pre-merge buffer snapshots (L7+)
```

The `.cubical/` directory is the only state Cubical owns inside the vault. Everything in it is rebuildable from the markdown — deleting `.cubical/` and reopening the vault produces a fully functional vault again, just without history.

`.assets/` holds binary assets (images, PDFs) deduplicated by content hash. Deduplication is **per-vault only** — cross-vault deduplication or global asset folders are explicitly rejected because they break vault portability.

---

## 4. File identity

File identity is the absolute anchor for cross-references (wiki-links, block refs, backlinks). Cubical's identity model evolves across the build:

- **Layers 0–6 (v1.0): path-based identity.** No UUIDs are written into user files. The vault Cubical opens is the vault the user wrote, byte-for-byte. Renames are detected via the file watcher and reconciled through the [Pending Rewrites Cache](document-model.md#57-pending-rewrites-cache). Renames that happen while the app is closed fall back to inode + content-hash heuristics.
- **Layer 7 (sync): frontmatter UUIDs introduced.** When the user opts into sync, Cubical mints a `cubical_id: <uuid>` key in each file's YAML frontmatter as part of onboarding. The OS "last modified" timestamp is captured before each write and restored after. Files without frontmatter get one created. This is the single batch-write moment in a vault's lifetime; it is framed to the user as "enabling sync" rather than "Cubical mangling your files on first open."

Path is mutable across both phases; the UUID (post-L7) is stable forever.

### 4.1 Why frontmatter, not EOF comment

Earlier drafts proposed an EOF HTML comment of the form `<!-- ... Cubical ID: ... -->`. That approach is retired. Frontmatter is the conventional metadata zone, users already accept that tools edit YAML, and it sits where structured queries (Dataview-style) can read it without special handling. EOF comments would have been more visually intrusive at the bottom of the document — the reading territory — and easier to delete by accident.

### 4.2 Export sanitization

Before any export — PDF, HTML, copy-to-clipboard-as-markdown — the `cubical_id` frontmatter key is stripped from the in-memory buffer. The exported artifact carries no Cubical-specific metadata. Pre-L7 there is nothing to strip. This is a hard requirement: leaking UUIDs in shared documents is a privacy risk.

### 4.3 External edits

When `notify` reports a `.md` file modified externally (vim, Dropbox, another Cubical instance pre-sync), Cubical:

1. Reads the new file content.
2. If the file is currently open with unsaved local edits, the prior buffer state is written to `.cubical/recovery/<timestamp>-<filename>` as a safety snapshot (this is the user's escape hatch). The user is prompted with a 3-way merge UI (their unsaved buffer vs. the external content vs. the prior known state).
3. If the file is not open or has no unsaved changes, the new content is accepted silently and the file's index entry is updated.
4. The file's `last_known_content_hash` and `mtime` are refreshed.

Pre-L7, no CRDT is involved — the external edit replaces the in-memory state. Post-L7, the diff is treated as a single CRDT operation authored by `filesystem` with the current timestamp and merged through Loro. Recovery snapshots are kept for a configurable retention window (default: 30 days). (See [`planned.md` — Sync](planned.md).)

---

## 9. Binary assets

Assets dropped into a note are:

1. SHA-256 hashed.
2. Stored at `.assets/<first-2-chars>/<next-2-chars>/<full-hash>.<ext>`.
3. Referenced from the note via a path-relative link.

If the same asset is dropped again (same hash), no copy is made — the existing file is linked.

A background Rust task generates WebP thumbnails for images. The UI lazy-loads thumbnails and swaps to full-resolution as a viewport-entry approaches. This keeps memory low even for image-heavy notes.

Cross-vault deduplication is **explicitly rejected.** It breaks portability — you cannot zip up a vault and send it to someone if half the assets live in a global folder elsewhere.
