> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)

# Cubical — Architecture: Foundation

## 1. Philosophy

Cubical is a Personal Knowledge Management application built on four commitments:

1. **The user's vault is sovereign.** It is plain markdown, fully portable, and survives the app being uninstalled, the company shutting down, or the user editing files in any external tool. The vault works without Cubical; Cubical only works because the vault works.
2. **Performance is a feature, not a polish item.** Every architectural choice is measured against latency at the keystroke, scroll, and search. "Fast enough" is not the bar. "Imperceptible" is. This commitment is held to a measured number, not an adjective — the bar below is the owner; `CLAUDE.md` links to it.

   **The bar.** A cold scan-and-index (`Vault::open` + full `scan`) of a synthetic fixture vault must stay under **13 s** at 10,000 notes and **1.5 s** at 1,000 notes. Measured medians on a 10-core M1 Pro at the time of writing: **6.6 s** and **0.69 s** — the ceilings are set at roughly 2x observed so they pass today and ratchet down, never up. Reproduce with `cargo run --release -p cubical-core --example scan_bench -- <fixture-dir> <note-count>`; the harness generates its own deterministic fixture. It deletes `.cubical/` before every run, so it refuses any directory that is non-empty and lacks its own `.scan-bench-fixture` marker — pointed at a real vault it would destroy exactly the non-derivable state named in commitment 1. Tantivy is ~a third of the budget and scales with core count, so a CI ceiling must be measured on the runner rather than inheriting this number.
3. **The app does not lock the user in.** No proprietary file formats for content. No required cloud account. No data inside Cubical that the user cannot export, inspect, or take elsewhere.
4. **Features are composable building blocks.** Most user-facing capabilities are independent, toggleable blocks the user stacks to taste — not a fused monolith. The user decides which parts of Cubical are switched on; the design pressure on every new feature is "can this be a block that turns off cleanly?"

These commitments produce hard rules that downstream decisions must respect:

- Plain `.md` files are the source of truth. Indexes, caches, CRDT logs, and snapshots are derived state — they can be deleted at any time and the vault remains intact, with **one exception**: the pending-rewrites queue lives in the index and is not re-derivable, which is why the durable rename journal (`.cubical/renames.jsonl`) exists. Deleting the index without replaying it strands referrer links — see [`../implementation/vault-core.md`](../implementation/vault-core.md). Durable user config (`config.toml`, `themes/`) is not derived state at all; the split is owned by [`vault.md`](vault.md) §3.
- The app must gracefully handle external modifications to the vault (renames in Finder, edits in vim, file additions by Dropbox sync) made while Cubical is closed.
- No legacy runtimes (Electron, Node) are part of the shipped product.
- Plugin code is hardware-sandboxed by default; capability grants are explicit and granular. The sandbox governs **third-party** code. First-party core features may use native capabilities — see §2.1.
- A feature toggle changes behaviour and derived state only — never the `.md` source of truth or the vault's portability. Switching a feature off leaves the vault byte-identical and simply drops that feature's derived state, which is rebuilt if it is switched back on.

**On composability (commitment 4) — scope and honesty.** A direction realized incrementally, and *most* features, not all. The always-on substrate — vault, canonical AST (`document-model.md`), index, IPC — is bedrock, not a toggle; blocks stack on top of it. Blocks form a **dependency graph**, not free stacking: a block can't be active while a block it depends on is off (backlinks need the link index; embeds need link resolution). The seed mechanism already exists — the Core Plugins registry + `.cubical/config.toml` `plugins.*` toggles (e.g. `dataview_enabled`) — graduating into the full plugin ABI ([`planned.md`](planned.md) §8). The cost to respect: every toggle multiplies the interaction and test surface, so tested **default sets** and known-good combinations matter more than raw togglability.

---

## 2. Stack

**Backend:** Tauri 2.x with a Rust core. Strict IPC allowlist; no broad filesystem or shell access from the webview. All heavy work — file I/O, parsing, indexing, CRDT operations, embeddings — runs on the Rust side.

**Frontend:** Solid + TypeScript + Vite. Solid is chosen for its fine-grained reactivity, near-zero runtime overhead, and clean interop with libraries that own their own DOM (CodeMirror, Pretext, future WebGPU canvases).

**Editor surface:** CodeMirror 6 + Lezer. CodeMirror handles input, selection, IME, accessibility, and decoration; Lezer provides incremental markdown parsing for Live Preview. The Lezer markdown grammar is the editor's parser.

**Text measurement and virtualization:** Pretext (Cheng Lou). Used as the measurement layer beneath the editor's virtualized scroller and beneath any large-list UI (file explorer, search results). Pretext is *not* the editor — it does not handle input. Its role is height calculation and line layout for non-DOM-bound layout decisions.

**Math typesetting:** KaTeX. Chosen over MathJax because it renders synchronously — a block renderer returns a DOM node, so an async typesetter would force a two-phase widget — and because it ships as a self-contained bundle with its own fonts, which keeps the no-network rule intact: nothing is fetched at render time. It is a display-time concern only; `$$…$$` and ```math` blocks stay literal text in the `.md` file.

**Canonical AST:** A Markdown AST defined in the `cubical-ast` Rust crate. Lezer trees produced in the editor are normalized into canonical AST on the Rust side. Every system outside the editor — indexer, link resolver, backlink computer, exporter, plugin host — consumes canonical AST. This guarantees one document interpretation across the whole system, eliminating the class of bug where different parsers see different documents.

**Metadata and index storage:** libSQL (a SQLite fork). Single file at `<vault>/.cubical/index.db`. Holds file metadata, link index, block-reference index, CRDT operation logs, Time Machine snapshots, and (later) vector embeddings. The libSQL choice over plain SQLite is for the embedded server / network mode option later, and for native vector support; for the core flow, libSQL is used as a standard embedded database.

**Full-text search:** Tantivy. Rust-native, BM25-ranked, with stemming and typo tolerance. Indexes the canonical AST, not the raw markdown — which means search understands document structure (heading-only search, code-block exclusion, etc.).

**CRDT engine:** Loro. Rust-native, supports movable trees natively (relevant for the file tree and outliner moves), has a rich-text model closer to Peritext than Yjs's. The CRDT layer is abstracted behind a Rust trait so swapping is theoretically possible — though a swap is not planned.

**Graph rendering (Layer 9, post-v1.0):** WebGPU. Bypasses WebGL limits to keep 60fps on 100k-node graphs. Justified by real-world vault scale at this size; WebGL would degrade on pan/zoom. For v1 desktop targets (WebView2, WKWebView, WebKitGTK) WebGPU is sufficiently supported.

**Local AI:** Out of core scope. AI capability is delegated to the plugin ecosystem rather than baked into the app. libSQL's vector storage option remains available to plugins as a capability if a plugin author wants to ship embeddings + RAG.

### 2.1 Native capabilities in first-party features

The plugin sandbox exists to contain **untrusted third-party code**. It says nothing about Cubical's own compiled features: sandboxing a core feature toggle against the binary it ships inside is meaningless. So the rule is narrower than "everything is sandboxed", and deliberately so — the general reading would otherwise be read as "core features are exempt", which would later justify a core feature doing anything at all.

**The rule.** First-party core features may use native capabilities. But any core feature whose *purpose* is to grant an unsandboxed capability to arbitrary external code must satisfy all three of:

1. **Opt-in and default-off.** A `plugins.*` toggle the user must deliberately switch on.
2. **Unable to compromise vault integrity when abused.** The vault must converge on whatever state the external code leaves behind — the feature may not be load-bearing for correctness. See §2.2.
3. **Auditable.** Effects on the vault land in `audit_log` like any other mutation.

The motivating case is the embedded terminal, which spawns real child processes (`claude`, `python`, `git`) that are *at least* as untrusted as any community plugin — a community plugin has at least passed through the WASI ABI, while `npx some-tool` has passed through nothing. The terminal is therefore not an exception to the sandbox rule; it is a gateway, and the three conditions above are what replace the sandbox for gateways.

This refines, and does not weaken, the **Backend** webview constraint above: the webview never gains shell or broad filesystem access. Rust owns the PTY and the child process; the webview receives an opaque byte stream and sends keystrokes. The capability is granted to the *child process*, by the Rust core, at the user's explicit request.

### 2.2 Convergence over interception

Cubical cannot intercept filesystem mutations made by external processes — an AI CLI's file write is an `open`/`write` syscall, and interposing on it would require OS-level machinery (FUSE, DYLD interposition) that contradicts portability and the no-external-services rule. Attempting it would also be a lie: correctness would silently depend on interception that any `python` script trivially bypasses.

The commitment is therefore **convergence, not interception**: the engine must converge on whatever the filesystem becomes, regardless of who changed it. This is already most of the way true — the index is derived state (commitment 1) and the watcher rebuilds it. Where a raw filesystem operation destroys *semantics* the index cannot re-derive — a move that leaves every `[[wikilink]]` dangling — the watcher recovers the semantics where it can and surfaces the residue to the user where it cannot. Silent rot is the one unacceptable outcome.
