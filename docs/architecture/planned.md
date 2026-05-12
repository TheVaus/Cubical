> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)

# Cubical — Architecture: Planned Layers

## 7. Sync

Sync ships at **Layer 7**. Pre-L7, Cubical is single-device; the `cubical-sync` crate exists as a planned interface (`trait CrdtBackend`) but has no implementation. Pre-L7 file reconciliation across external edits uses the simpler hash + mtime model described in `vault.md` §4.3.

### 7.1 Loro

Loro is the CRDT engine that lands at L7. The vault's file tree is a Loro movable tree; each note's content is a Loro text. The `(file_uuid, block_id)` pairs (introduced at L7 onboarding alongside frontmatter UUIDs) are stable identifiers across the CRDT.

The CRDT layer is abstracted behind `trait CrdtBackend` with Loro as the only implementation. The trait exists so the *boundary* is clean, not because a swap is planned. Code outside `cubical-sync` calls the trait, not Loro directly.

### 7.2 Operation logs

Per-note operation logs in libSQL, keyed by `file_uuid`. Each row is an operation with author, timestamp, and serialized payload. Operation log tables (`crdt_operations`, `crdt_snapshots`) are reserved in the schema but not created until L7.

Log growth is bounded by periodic snapshot + compaction:

1. When a note's log exceeds N operations or M bytes (tunable), a snapshot of the materialized state is taken.
2. Operations older than the snapshot are pruned, except for those needed to reconcile with peers that haven't yet seen the snapshot.

### 7.3 Network

Layer 7. WebRTC P2P for direct device-to-device sync; optional E2EE relay for store-and-forward when peers are not simultaneously online. The relay is a thin server that holds encrypted blobs only — it cannot read user content.

### 7.4 Two-tier asset pipeline

Text and CRDT operations sync over WebSockets at high priority. Binary assets sync on background queues with their own bandwidth controls. Implemented in L7.

---

## 8. Plugins

### 8.1 ABI

WASM with WASI sandboxing. The host (Cubical) and plugin share a typed ABI for: reading the canonical AST of a file, querying libSQL via a constrained query interface, registering UI surfaces, subscribing to vault events.

The ABI is versioned with integers (`abi_version: 1`, `abi_version: 2`, …). Each plugin's manifest declares `target_abi_version`. **Cubical at runtime ABI version `N` accepts plugins targeting `N`, `N-1`, or `N-2`.** Older plugins fail to load with a clear migration message: *"This plugin targets ABI v3; Cubical supports v4–v6. Please ask the plugin author for an update."* When ABI `N+1` ships, plugins targeting `N-2` are dropped — authors get a full version cycle to migrate before their plugin breaks.

The host implementation uses version-aware code paths sharing common types — *not* generic translation shims. E.g., if v1 had `read_file(path)` and v2 has `read_file(path, opts)`, the v1 path supplies default opts when calling the unified impl. This is honest about what cross-version compat actually costs and gives plugin authors a predictable migration cadence.

### 8.2 Source languages

The native target language is Rust. AssemblyScript, Zig, Go (TinyGo), and C are also supported by virtue of WASI being the target.

JavaScript and TypeScript are first-class source languages, supported via Javy (or QuickJS-WASM, depending on tooling maturity at Layer 6 time). A JS plugin compiles to a QuickJS interpreter running inside WASM. The plugin pays an interpreter overhead (roughly 2–5x slower than native WASM) but retains full sandboxing and the same WASI ABI. The overhead is invisible for the typical plugin shape (event handlers + capability calls; no heavy CPU work); plugins that genuinely need native-WASM speed can target Rust. This is the unlock that gives Cubical an ecosystem at launch — JS-literate developers can contribute without learning Rust.

### 8.3 Permissions

Granular, explicit, per-plugin. The user grants:

- Read access to specific folders or the whole vault
- Write access to specific folders or the whole vault
- Network access (denied by default)
- Specific Cubical capabilities (run search, query metadata, etc.)

A plugin cannot escalate. The permission UI shows what each plugin currently has and lets the user revoke.

### 8.4 Concurrency

Plugins run in Lane 3 (Web Workers) for v1. They can spin up their own background work without blocking the main thread.

### 8.5 Memory pipeline

Where the host and plugin share memory regions for large data (canonical AST traversal, query results), zero-copy is the design intent. Practically, this requires careful ABI design — the WASM linear memory model permits it, but the ergonomics depend on tooling. Layer 6 will determine the exact mechanism.

### 8.6 File access

Plugins reading vault files **must go through the Cubical capability** (`vault.read_file(path)`), not raw WASI fs. This guarantees plugins see materialized content (with [Pending Rewrites](document-model.md#57-pending-rewrites-cache) applied) rather than stale on-disk text. WASI fs is denied by default in the permission model; granting it is an explicit, granular choice the user makes per plugin.

### 8.7 Themes

Plugins may distribute one or more themes via the manifest's `themes` field. Plugin themes plug into the same CSS token surface as built-in and user themes (§11.4 in `ui.md`), so they are first-class — not a separate code path.

---

## 10. Time Machine

A snapshot of the vault's tracked-file state, stored in libSQL. **Layer 8, post-v1.0.**

**Trigger: sync-clean state.** A snapshot is taken when there are zero pending CRDT operations and zero unsaved buffers — i.e., the vault is fully reconciled, in flight on neither side. This is intentionally *not* a periodic timer. Pre-L7 there is no CRDT layer to be clean *relative to*, so Time Machine is dormant. Post-L7 it fires at meaningful boundaries — moments when the user has, in effect, "committed" to a vault state.

Snapshots are content-addressed by hash, so unchanged files don't bloat the database. A snapshot row is `(timestamp, file_uuid, content_hash, content_blob_id)`; the actual content lives in a deduplicated blob table.

The user-facing surface (version-history UI, "restore to this version," 3-way merge UI for in-flight conflicts) is L8 work.

**Pre-L7 safety substrate.** Before L7 ships, the safety net for external edits is the simpler `.cubical/recovery/` directory described in `vault.md` §4.3 — a temp-file written before each external-edit reconciliation, retained for a configurable window (default 30 days). This is not a full Time Machine; it has no UI and no version-pick semantics. It exists so users always have a one-click path back to the prior buffer state if a merge result is undesirable.

---

## 14. Open architectural questions

These are deliberately deferred to the layer where they become live decisions, not because they are unimportant.

- Exact canonical AST schema → finalized in Layer 1.
- Exact CRDT operation log compaction parameters → tuned during Layer 7.
- Exact Tauri command surface → grown organically per layer; reviewed for coarseness at each layer transition.
- Plugin ABI specifics → finalized in Layer 6, by which time we have real consumers (the core Cubical features themselves) to design against.
- WebGPU graph rendering data structures → Layer 9.
- **Encryption at rest** for `.cubical/index.db` and `.cubical/recovery/`. Reserved as a future concern; the architecture should not preclude it.
- **i18n strategy.** A UI string layer will be reserved in the frontend; real translations are post-v1.0.
- **License / business model.** MIT placeholder during alpha; revisited before public beta cut at L5.
- **Backup / corruption recovery story** for `.cubical/index.db`. Mostly documentation rather than architecture, but the trade-offs (rebuild from .md vs. provide a built-in backup tool) deserve a section before L5.
- **Sync details** — WebRTC NAT traversal, STUN/TURN, relay hosting model, key management. Own conversation when L7 becomes live.

When one of these becomes live, it gets its own section here, written before any code.
