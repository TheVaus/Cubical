# Cubical — Layer 2: Editing

The first user-visible polish layer. L2 turns the L1 read-only editor surface into something a person can actually use: typing persists, the markdown looks like a document rather than source, frontmatter has a real editing UI, and the app respects light/dark theme.

L2 is the **first demo-able milestone** in the build order (`CLAUDE.md`). v1.0 still cuts at the end of L5.

> **Before starting any L2 session:** complete the L1 carry-over interactive smoke pass — open `cargo tauri dev`, open a vault containing one or more `.md` files, click a markdown file, confirm the editor renders, typing fires `onAstChange`, external edits surface via `vault:file-changed`. See `CLAUDE.md` "Project state" and `docs/layer-1-spec.md` §5 closing note. If any of those don't hold, file a bug against L1 before starting L2 proper.

---

## 1. Goals

By end of L2:

1. The editor writes to disk. Typing autosaves the buffer to the underlying `.md` file with the L0 atomic temp-and-rename helper. The file watcher's own-write event is suppressed via content-hash gating so the round-trip doesn't show up as an external edit.
2. Live Preview decorations are applied via Lezer to the CodeMirror state. The cursor line shows raw markdown; every other line shows decorated headings, emphasis (italic), strong (bold), inline code, fenced code blocks, bullet/ordered lists, blockquotes, and plain `[text](url)` links. Wiki-links, embeds, block refs, tables, and images stay raw — they are L3+ territory.
3. A Raw Source toggle exists. App-level default lives in the L0 `config` table (`editor.raw_source_default`); per-doc state is a transient in-memory override. Keyboard shortcut: `Cmd/Ctrl+E`.
4. A vault-local settings infrastructure (`get_setting` / `set_setting` IPC over the existing `config` table) is available for L2 and later layers.
5. Theming is real. The token surface in `ui/src/styles/tokens.css` is consumed by an `<html data-theme="...">` cascade. The dark token values are tuned. The CodeMirror theme is generated programmatically from the same tokens. OS `prefers-color-scheme` drives the default; the user override is read from / written to the settings infrastructure.
6. Frontmatter has an inline Properties UI above the editor pane. Rows for each top-level key, click-to-edit cells with type-specific inputs for `string`, `number`, `boolean`, `date` (ISO 8601), `list-of-strings`, `list-of-tags`. Unknown YAML types render as raw text. Nested mappings collapse to read-only JSON. Saves go through the same `write_file_text` path as body edits.

What's **not** in L2: a Settings page UI (the toggle button is the only L2 surface that writes a setting; the rest is read-on-startup); theme picker UI (L5); user-supplied themes under `<vault>/.cubical/themes/` (L5); high-contrast theme (L5); export sanitization (L5); a real 3-way merge UI for external-edit conflicts (L8 Time Machine); tabs / split-pane (post-L2); right-sidebar backlinks / unlinked mentions (L3); search panel (L4); wiki-link / embed / block-ref decorations (L3); tag autocomplete inside Properties tag-lists (L3 owns autocomplete).

---

## 2. Surfaces

### 2.1 Writable editor + autosave

`Editor.tsx` gains a write path. Behavior:

- **Debounce:** 300ms idle after the most recent `docChanged` update (matches `docs/architecture/ui.md` §12 "auto-save debounce 300ms").
- **Flush triggers:** debounce timer fires; editor blurs; the active file changes (the previous file's pending write is awaited before the new file is read); the app is closing (the close-vault IPC awaits any in-flight save).
- **Per-file scoping:** each open document has its own pending timer + last-written-hash. L2 only ever opens one document at a time, but the structure must not preclude tabs (post-L2).
- **Cancel-on-external-edit:** none. When an external edit lands on a dirty buffer (see §2.7), the pending autosave is *paused* via the conflict banner; the user resolves.
- **Atomic write:** all writes go through `cubical-core`'s temp-and-rename helper (`docs/layer-0-spec.md` §4). Windows retry semantics inherited unchanged.
- **Audit log:** every successful autosave writes an `audit_log` row (category `autosave`, level `info`, detail `{ path, bytes }`).

Reads still go through `read_file_text`. Writes go through the new `write_file_text` IPC (§3).

### 2.2 Live Preview decorations

A new CM6 extension at `ui/src/editor/decorations.ts`. Decoration source is **Lezer, exclusively** (`syntaxTree(state)` from `@codemirror/language`). This is consistent with `docs/layer-1-spec.md` §3.1: §3.1 makes the in-process `onAstChange` callback path go through `ui/src/ast/normalize.ts` for consumers that want the canonical Rust-mirrored AST shape; decorations are a parallel consumer with different needs (byte-precise marker token positions which the canonical AST deliberately abstracts away). The two paths do not unify; the L1 parity contract is unaffected.

Decoration scope (covered nodes):

| Lezer node | Visible effect | Cursor-line behavior |
|---|---|---|
| `ATXHeading1` … `ATXHeading6` | Size + weight scaled per level; `HeaderMark` (`#`/`##`/…) hidden | Mark revealed; size/weight stays |
| `SetextHeading1`, `SetextHeading2` | Size + weight scaled; `HeaderMark` underline row hidden | Mark revealed |
| `Emphasis` | Italic; `EmphasisMark` (`*`/`_`) hidden | Marks revealed |
| `StrongEmphasis` | Bold; `EmphasisMark` (`**`/`__`) hidden | Marks revealed |
| `InlineCode` | Mono + `--c-bg-tertiary` background; `CodeMark` backticks hidden | Marks revealed |
| `FencedCode`, `CodeBlock` | Mono block, `--c-bg-secondary` background, padding; `CodeMark` fences hidden | Fences revealed |
| `BulletList`, `OrderedList`, `ListItem` | Indent + bullet glyph; `ListMark` hidden | Mark revealed |
| `Blockquote` | Left border (`--c-accent`), italic body; `QuoteMark` (`>`) hidden | Mark revealed |
| `Link` (standard `[text](url)`) | Underlined accent-colored span over `text`; `url` + brackets hidden | Full source revealed |

Out of scope for L2 (left raw, no decorations): tables, images, HTML blocks, thematic breaks (rendered raw as `---`), task list `[ ]`/`[x]` markers, footnotes, math, callouts, wiki-links `[[…]]`, embeds `![[…]]`, block IDs `^id`, tags `#tag`.

Implementation pattern:

- A `ViewPlugin` reads `syntaxTree(view.state)` and produces a `DecorationSet` per `update`.
- Active-line detection uses `view.state.selection.main.head` and `view.state.doc.lineAt(head).number`; decorations on the active line are dropped from the set so the raw source shows through.
- The plugin is one of several extensions composed into the `EditorState`; it sits after `markdown()` (Lezer parser provider) and before the theme.
- All visual values come from `var(--…)` CSS variables — never hardcoded.

### 2.3 Raw Source toggle

Per Q3 of the L2 brainstorm: app-level default + per-doc transient override.

- **Default source:** `editor.raw_source_default` setting (boolean, read on startup from §3.4 IPC). When unset, defaults to `false` (i.e. Live Preview is the out-of-the-box experience).
- **Per-doc override:** a Solid signal in `App.tsx` tied to the currently-selected file path. Resets on file selection change.
- **Toggle UI:** small `</>` button in the header next to the vault path; aria-label "Toggle raw source." Keyboard shortcut: `Cmd/Ctrl+E` registered through CM6's `keymap.of([{ key: "Mod-e", run: … }])`.
- **Effect:** when raw mode is active, the Live Preview decoration plugin is replaced with a no-op extension; Lezer parsing still runs (the syntax tree is still needed for `onAstChange`). Hidden marker spans become visible because no `Decoration.replace` ranges exist.
- **Setting writes:** the toggle button writes `editor.raw_source_default` when the user holds `Shift` while clicking (or invokes a context-menu action "Use raw as default"). A naked click only flips the per-doc override. This split keeps the L2 surface tiny: no separate Settings page is required to change defaults.

### 2.4 Properties UI (inline frontmatter editor)

A new component `ui/src/Properties.tsx` mounted above `Editor.tsx` in `App.tsx` whenever the selected file is markdown.

- **Empty state:** if the file has no frontmatter, the component renders a single muted `+ Add property` affordance. Clicking it inserts an empty `--- … ---` block at file start and opens the first row in edit mode.
- **Populated state:** one row per top-level YAML key, key on the left (mono, click-to-rename), value cell on the right with type-specific editing.
- **Value editors:**
  - `string` → text input.
  - `number` → text input with numeric inputmode; reject NaN on commit.
  - `boolean` → two-state toggle.
  - `date` → ISO 8601 (`YYYY-MM-DD`) text input with native `<input type="date">` styling; commits as YAML date scalar.
  - `list-of-strings` → chip row with `+` and per-chip `×`; chip text editable on click.
  - `list-of-tags` → same chip row but each chip renders with `#` prefix and `--c-accent` color. No autocomplete in L2 (L3 owns tag indexing and autocomplete).
  - Unknown scalar / nested mapping → raw read-only JSON dump. A "Open as raw" link opens the file with the raw toggle on so the user can hand-edit.
- **Type inference:** on read, infer type from the YAML scalar (`true`/`false` → boolean, ISO-date-shaped string → date, plain number → number, plain string → string, JSON array → list-of-strings unless the key is `tags`/`aliases` in which case list-of-tags, JSON object → nested mapping).
- **Type override:** a small chevron next to each row opens a type-pick menu (string / number / boolean / date / list-of-strings / list-of-tags). Changing the type re-encodes the value (best-effort coerce; falls back to a warning chip if coercion is lossy).
- **Save semantics:** every commit (blur on cell, Enter, list mutation) reserializes the entire frontmatter block, splices it into the source, and queues the same 300ms autosave used by the body editor. Properties edits are not a separate write path — they go through `write_file_text`.
- **Source-of-truth tension:** the editor's CM6 state is the authoritative buffer for the file's text. The Properties UI rebuilds its rows from the parsed `Frontmatter` whenever the buffer changes (debounced 100ms via `onAstChange`). User-typed frontmatter edits in raw mode flow back into the Properties UI on the next AST tick.

### 2.5 Themes

- **Token surface:** the existing `ui/src/styles/tokens.css` already defines `:root, [data-theme="light"]` and `[data-theme="dark"]` blocks (L0 §10 token-surface scaffold). L2 audits both, adds tokens needed by the decoration scope above (notably `--editor-active-line-bg`, `--editor-mark-fg-muted`), and tunes dark contrast.
- **Theme switch:** new helper `ui/src/styles/theme.ts` exposes `applyTheme(mode: "light" | "dark" | "system")`. It writes `document.documentElement.setAttribute("data-theme", resolved)`. The `"system"` resolution reads `window.matchMedia("(prefers-color-scheme: dark)")` and subscribes to changes.
- **Initial mode:** read `appearance.theme_mode` from settings (string: `light` | `dark` | `system`; default `system`).
- **CodeMirror theme:** new file `ui/src/editor/cm-theme.ts` builds a CM6 `Extension` programmatically by reading computed `var(--…)` values from `:root`. Re-built when `data-theme` changes (via `EditorView.dispatch` reconfiguring the theme compartment). One source of truth — when a user (later, L5) installs a custom theme that overrides tokens, both the Solid UI and the editor switch in lockstep.
- **No picker UI in L2.** Surface for changing the mode is a small button in the header (`☀ / ☾ / ⚙`) that cycles `light → dark → system`. Real picker / per-vault override / user themes / high-contrast all defer to L5.

### 2.6 Vault-local settings infrastructure

L2 needs persistent settings for the Raw-Source default and the theme mode. The L0 schema already created the `config` table (path `<vault>/.cubical/index.db`, `config(key TEXT PRIMARY KEY, value TEXT NOT NULL)`).

L2 adds two pure-handler-plus-shim Tauri commands (§3.4) reading and writing that table. Values are JSON-encoded so non-string types round-trip cleanly. L2 keys used:

| Key | Type | Default | Read by |
|---|---|---|---|
| `editor.raw_source_default` | boolean | `false` | App startup; raw toggle UI |
| `appearance.theme_mode` | string (`light`/`dark`/`system`) | `system` | App startup; theme button |

No schema migration is required — the table exists already. The settings layer is generic; later layers will add their own keys (`editor.autosave_debounce_ms`, `properties.show_unknown`, …) without re-touching this infrastructure.

### 2.7 External-edit conflict policy

When the file underneath the editor changes externally while the buffer is dirty:

1. **Detect.** The Editor records the `content_hash` of the file as of its last successful read or write (call this `seen_hash`). The `vault:file-changed` event carries the file's `new_content_hash` after the watcher refresh (§3.5 — new field on the existing event). If `new_content_hash != seen_hash` and the buffer is dirty, the conflict branch fires.
2. **Pause autosave.** The pending 300ms timer is cancelled. Any in-flight `write_file_text` finishes normally — its response updates `last_written_hash` so the watcher round-trip is still suppressed. A buffer change that lands while the banner is up does *not* restart the debounce.
3. **Banner UI.** A banner spans above the editor: "*This file was changed outside Cubical.* `[ Reload from disk ]` `[ Keep my edits ]`."
4. **Resolution.**
   - **Reload from disk:** discard buffer state, re-read via `read_file_text`, replace CM6 doc, update `seen_hash`. Conflict resolved.
   - **Keep my edits:** resume autosave on the next change; the next write will overwrite the external version. An `audit_log` row with category `external_edit_override` records the path, the external hash that was overwritten, and the timestamp.
5. **Buffer is clean (not dirty) at conflict-time:** no banner; the watcher refresh path silently reloads via `read_file_text` (existing L1 behavior).

No 3-way merge UI is in L2; that is `docs/architecture/document-model.md` L8 (Time Machine) territory.

### 2.8 Watcher feedback-loop suppression

Without suppression, every autosave would emit a `vault:file-changed` and round-trip back into the editor as an "external edit."

Mechanism: **content-hash gating in the event payload.**

- The `vault:file-changed` payload gains an optional field `new_content_hash: Option<String>`. Already computed inside `cubical-core::vault::watcher::apply_watch_event_to_db` for Created/Modified; just plumb it onto the emitted struct.
- The Editor records the hash returned by its most recent successful `write_file_text` response as `last_written_hash` (per open file).
- Inbound `vault:file-changed` events whose `new_content_hash` matches `last_written_hash` are dropped by the Editor before any external-edit logic runs.
- Concurrent writes from outside (different hash than what we wrote) are not suppressed; they flow into §2.7.

This survives debouncer timing, watcher retries, and ordering jitter. It does not require a per-write "ignore window" or sequence number.

---

## 3. IPC surface

All new commands follow the L0 §8 pure-handler + thin-shim pattern. Types live in `crates/cubical-app/src/api/types.rs`; pure handlers in `crates/cubical-app/src/commands/vault.rs`; Tauri shims in `crates/cubical-app/src/lib.rs`.

### 3.1 `write_file_text`

Coarse-grained "overwrite this markdown file's contents." Pure handler reads target path from `files` table (via `IndexConn`), runs the atomic temp-and-rename inside `tokio::task::spawn_blocking`, recomputes content_hash and mtime, updates the `files` row, returns the new hash so the Editor can populate `last_written_hash`.

```rust
struct WriteFileTextRequest {
    vault_id: String,
    path: String,        // vault-relative; must already exist + type_id == "markdown"
    content: String,
    expected_seen_hash: Option<String>,  // None = blind write; Some = conditional
}
struct WriteFileTextResponse {
    new_content_hash: String,
    new_mtime_unix: i64,
}
```

`expected_seen_hash` is **advisory** in L2 — if provided and it doesn't match the current on-disk hash, the handler still writes (preserving the user's "Keep my edits" choice) but emits an audit_log row at level `warn` with category `external_edit_override`. Hard rejection (returning a `Conflict` error) is deferred to L8 when the merge UI exists to act on it.

Errors: `FileNotFound` (path untracked); `InvalidRequest` (path is binary or empty); `Io` (atomic write failed after retry).

### 3.2 `get_setting`

```rust
struct GetSettingRequest { vault_id: String, key: String }
struct GetSettingResponse { value: Option<serde_json::Value> }  // None = key missing
```

Reads `config.value` (TEXT NOT NULL), `serde_json::from_str` on the way out. JSON parse failure → `InvalidRequest`.

### 3.3 `set_setting`

```rust
struct SetSettingRequest { vault_id: String, key: String, value: serde_json::Value }
struct SetSettingResponse {}
```

Upserts `config(key, value)`. Always `serde_json::to_string` the value before storing. The Solid frontend's typed wrapper enforces a known-keys union type so we don't accidentally write `editor.raw_source_devault` (typo).

### 3.4 Settings keys typed in `ipc.ts`

```ts
export type Setting =
  | { key: "editor.raw_source_default"; value: boolean }
  | { key: "appearance.theme_mode"; value: "light" | "dark" | "system" };
```

`getSetting<K extends Setting["key"]>(key: K)` narrows the response to the right value type. New keys added in later layers extend this union.

### 3.5 Event payload extension — `vault:file-changed`

```ts
// Was:
// { vault_id, path, kind: "created"|"modified"|"removed"|"renamed", from_path?: string }
// L2 adds:
{ vault_id, path, kind, from_path?: string, new_content_hash?: string }
```

`new_content_hash` is set for `kind: "created"` and `kind: "modified"`; absent for `removed` / `renamed`. Required by §2.8 suppression and §2.7 detection. Rust side: `cubical-core` already computes the hash inside the watcher path; the emit helper in `crates/cubical-app/src/events.rs` gains the field.

---

## 4. Frontend structure

New files (none shipped pre-L2):

```
ui/src/
├── App.tsx                       # gains Properties slot, theme button, raw toggle button, conflict banner host
├── Editor.tsx                    # gains write path, decorations extension, theme compartment, conflict-banner glue
├── editor/
│   ├── decorations.ts            # Lezer-driven CM6 ViewPlugin (§2.2)
│   └── cm-theme.ts               # programmatic CM6 theme reading tokens (§2.5)
├── Properties.tsx                # inline frontmatter editor (§2.4)
├── properties/
│   ├── StringCell.tsx
│   ├── NumberCell.tsx
│   ├── BooleanCell.tsx
│   ├── DateCell.tsx
│   ├── StringListCell.tsx
│   ├── TagListCell.tsx
│   ├── RawCell.tsx               # fallback for unknown / nested-mapping types
│   ├── inferType.ts              # YAML scalar → cell-kind
│   └── serializeFrontmatter.ts   # canonical YAML output (round-trippable)
├── styles/
│   ├── tokens.css                # audited + dark values tuned; new tokens for editor surface
│   └── theme.ts                  # applyTheme + system-preference subscription
└── api/
    └── ipc.ts                    # adds writeFileText, getSetting, setSetting, types for them
```

Existing files modified:

- `crates/cubical-app/src/api/types.rs` — new request/response structs.
- `crates/cubical-app/src/commands/vault.rs` — new pure handlers.
- `crates/cubical-app/src/lib.rs` — new `#[tauri::command]` shims.
- `crates/cubical-app/src/events.rs` — `VaultFileChangedPayload` gains `new_content_hash`.
- `crates/cubical-core/src/vault/watcher.rs` — emit the hash on the event side (already computed for the DB write).
- `crates/cubical-core/src/vault/frontmatter.rs` — refresh continues unchanged; properties UI relies on it.

No new Rust crates. No changes to the crate dependency graph.

---

## 5. Architecture deviations introduced or anticipated

Captured here so they're reviewable as architecture decisions rather than buried in commits.

1. **`write_file_text` is the universal write path.** Both body edits and Properties edits go through one IPC. This contradicts an alternative (`update_frontmatter` as a structured-edit IPC) that was explicitly considered and rejected during L2 brainstorming (Q1-A vs Q1-C). Reason: keeps Rust's write side small and lets the frontend stay the only place that understands frontmatter serialization until plugins (L6) demand a Rust-side reserializer.

2. **Decorations bypass the canonical AST.** L1 §3.1 made `cubical_ast::Document` the canonical shape, with the TS normalizer providing parity for in-process consumers. L2 introduces a third path: a CM6 `ViewPlugin` reading `syntaxTree(state)` directly. Marker token positions are required for decorations and the canonical AST deliberately omits them. The parity contract is not weakened — decorations are a parallel consumer, not a replacement.

3. **External-edit conflict policy is buffer-vs-disk only.** No 3-way merge in L2; that is L8 Time Machine territory. The audit_log row written on "Keep my edits" is the breadcrumb that lets L8 reconstruct what was overwritten.

4. **Watcher event payload extended with content-hash.** Already computed inside `apply_watch_event_to_db`; L2 plumbs it onto the emitted `vault:file-changed` struct (§3.5). Non-breaking for existing consumers (optional field).

5. **Theme `system` resolution lives in the frontend.** Rust does not know whether the user is in light or dark mode; it just stores the `"light" | "dark" | "system"` string. `theme.ts` resolves it via `matchMedia` and subscribes to changes. Plugins (L6) that want to render in a Cubical-appropriate theme will receive resolved-mode information via the plugin host API.

No `docs/architecture/` files are modified by L2. If any of the above turns out to be a load-bearing architectural call (most likely #2 — decorations bypassing canonical AST), promote it to `docs/architecture/document-model.md` at the L2-close step.

---

## 6. Definition of done

- [ ] L1 carry-over interactive smoke pass completed at Session A kickoff (open vault, click `.md`, see editor, type, see `onAstChange`, external edit propagates). Filed as bug against L1 if any step failed.
- [ ] `cargo test --workspace` green (baseline 92 Rust tests + new tests for `write_file_text`, settings IPC, watcher hash plumbing).
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean.
- [ ] `cargo fmt --check` clean.
- [ ] `npm run build` clean.
- [ ] `npm test` (vitest) green (baseline 23 + new tests for `inferType`, `serializeFrontmatter`, properties round-trip, theme system-preference resolution).
- [ ] `write_file_text` round-trip: edit doc, autosave fires after 300ms idle, file on disk matches buffer byte-for-byte (verified via SHA-256), `last_written_hash` matches the returned response, no `vault:file-changed` round-trip is observed by the editor.
- [ ] Decoration parity smoke: a doc containing one of each in-scope Lezer node type renders with the cursor on a non-matching line; visual inspection confirms each decoration. Cursor on a decorated line reveals the marker.
- [ ] Raw-source toggle: clicking `</>` flips the current doc only. `Cmd/Ctrl+E` keybind has the same effect. Reopening the app with no setting written defaults to Live Preview. Writing the default (Shift-click) and restarting opens new docs in Raw.
- [ ] Theme cycle: header button cycles `system → light → dark → system`. OS theme change during `system` mode flips the UI without reload. CM6 colors track UI colors in all three states.
- [ ] Properties UI: opening a doc with `title: foo`, `tags: [a, b]`, `created: 2026-05-13`, `archived: false`, `count: 7`, `nested: { x: 1 }` renders six rows with correct cell types; editing each commits via autosave; the on-disk frontmatter round-trips losslessly. Adding a new `string` property writes a valid `---` frontmatter block to a previously-frontmatter-less file.
- [ ] External-edit conflict banner: with a dirty buffer, modify the same file externally — banner appears, both Reload and Keep mine work; Keep mine writes an `external_edit_override` audit_log row.
- [ ] No hardcoded colors / fonts / spacings appear in any L2 component. (Manual grep; lint rule deferred to L5.)
- [ ] Interactive smoke pass against `cargo tauri dev` recorded in §8 (the closeout session). All six surfaces exercised by hand.
- [ ] `l2` git tag applied only after all of the above.

---

## 7. Out of scope

L2 explicitly does **not** ship the following. Each item links to the layer that owns it.

- **Settings page UI.** Only the toggle button (raw default) and the theme button (theme mode) are L2 settings-write surfaces. A real Settings page is L5.
- **Theme picker UX, user themes (`<vault>/.cubical/themes/`), high-contrast theme, font overrides.** L5.
- **Export sanitization rules.** L5.
- **Wiki-links `[[…]]`, embeds `![[…]]`, block refs `^id`, tag autocomplete, tag indexing, backlinks, unlinked mentions.** L3.
- **Search (Tantivy, Dataview-style queries, search panel, Omni-Bar).** L4.
- **Tabs, split-pane, file-tree hierarchy.** Post-L2 (no specific layer assigned yet).
- **Right sidebar (backlinks, unlinked mentions).** L3.
- **3-way merge UI for external-edit conflicts.** L8 Time Machine.
- **Property editors for nested mappings, anchors/aliases, or YAML tags.** Render as raw read-only JSON; full editing is a post-L2 polish job.
- **Asset / image rendering in Live Preview.** Asset path resolution + caching is L3+ work that depends on the link index.
- **Tables, footnotes, math, callouts, mermaid in Live Preview.** Not in the canonical AST per L1 §2; out of v1 scope per `docs/architecture/document-model.md` §5.5.
- **`update_frontmatter` structured-edit IPC.** Considered and rejected (§5 #1).
- **Rust-side reserializer for frontmatter.** Frontend owns serialization until plugins (L6) need a parallel one.

---

## 8. Session slicing

Six sessions. Each session is independently verifiable; the closeout session is its own session per user direction so smoke + tag are not bundled under feature implementation.

### Session A — Writable editor + Live Preview decorations

- **Scope:** `write_file_text` IPC (Rust pure handler + Tauri shim); autosave in `Editor.tsx` (300ms debounce, blur flush, file-change flush, app-quit flush); Lezer-driven decorations CM6 plugin at `ui/src/editor/decorations.ts` covering the §2.2 table; external-edit detection scaffolding (records `seen_hash` + `last_written_hash`); conflict banner UI hooked up to the detection signal.
- **Key files:** `crates/cubical-app/src/{api/types.rs, commands/vault.rs, lib.rs}`, `crates/cubical-app/src/events.rs` (add `new_content_hash` to `VaultFileChangedPayload`), `crates/cubical-core/src/vault/watcher.rs` (plumb hash), `ui/src/Editor.tsx`, `ui/src/editor/decorations.ts`, `ui/src/api/ipc.ts`, `ui/src/App.tsx` (conflict banner mount point).
- **DoD bullets:**
  - `write_file_text` happy + error paths covered by Rust tests.
  - Autosave round-trip: buffer dirty → 300ms idle → file on disk matches; `vault:file-changed` round-trip suppressed via hash gating; the watcher event still reaches the rest of the app (file list refresh, audit log).
  - Decoration plugin renders headings / emph / strong / inline-code / fenced-code / lists / blockquotes / plain links. Cursor on a decorated line reveals the source.
  - External-edit conflict banner appears with a dirty buffer; Reload + Keep mine both work; audit_log row on Keep mine.
- **Prereqs:** L1 carry-over smoke pass.

### Session B — Vault-local settings infrastructure

- **Scope:** `get_setting` / `set_setting` IPC (Rust pure handlers + shims); typed `ipc.ts` wrappers with the `Setting` discriminated union; no UI changes yet.
- **Key files:** `crates/cubical-app/src/{api/types.rs, commands/vault.rs, lib.rs}`, `ui/src/api/ipc.ts`.
- **DoD bullets:**
  - Round-trip a boolean, a string, a numeric, and a `null` value through `set_setting` → `get_setting`. Reopen the vault; values persist.
  - Reading an absent key returns `value: None`.
  - JSON parse failure on a corrupt value returns `InvalidRequest` (not a panic).
  - Rust + TypeScript types are kept in lockstep (typed `Setting` union in `ipc.ts`).
- **Prereqs:** Session A.

### Session C — Theme mechanism + CM6 theme generator

- **Scope:** audit `tokens.css` (tune dark values, add `--editor-active-line-bg`, `--editor-mark-fg-muted`, any others surfaced by Session A's decoration work); new `ui/src/styles/theme.ts` (`applyTheme`, system-preference subscribe); new `ui/src/editor/cm-theme.ts` (CM6 `Extension` reading computed CSS vars; rebuild on theme change via CM6 compartment); theme button in `App.tsx` header cycling `light → dark → system`; reads/writes `appearance.theme_mode` via Session B's IPC; OS-preference detection.
- **Key files:** `ui/src/styles/tokens.css`, `ui/src/styles/theme.ts`, `ui/src/editor/cm-theme.ts`, `ui/src/Editor.tsx` (theme compartment), `ui/src/App.tsx` (theme button).
- **DoD bullets:**
  - `data-theme="light"` and `data-theme="dark"` both render Session A's decorations with adequate contrast (verified manually).
  - `system` mode flips on OS theme change without reload.
  - `appearance.theme_mode` persists across app restart.
  - CM6 theme tracks UI theme — no visual divergence between editor and surrounding chrome.
- **Prereqs:** Sessions A + B.

### Session D — Raw Source toggle

- **Scope:** `</>` button in `App.tsx` header; `Cmd/Ctrl+E` CM6 keymap; Solid signal for per-doc transient override (resets on file selection change); Shift-click writes `editor.raw_source_default`; Editor swaps decoration extension via CM6 compartment when raw mode toggles.
- **Key files:** `ui/src/App.tsx`, `ui/src/Editor.tsx` (decoration compartment).
- **DoD bullets:**
  - Naked click flips the current doc; Shift-click sets the default; restart honors the default.
  - `Cmd/Ctrl+E` keybind works while the editor has focus.
  - Switching files resets the per-doc override to match the current default.
- **Prereqs:** Sessions A + B (and C is nice-to-have so the toggle looks right in dark).

### Session E — Properties UI

- **Scope:** `Properties.tsx` + the `properties/` subdir (six cell components + `inferType` + `serializeFrontmatter`); mount above the Editor in `App.tsx` for markdown files; type inference from parsed `Frontmatter`; type override menu; commit through the shared autosave queue.
- **Key files:** `ui/src/Properties.tsx`, `ui/src/properties/*`, `ui/src/App.tsx`, `ui/src/Editor.tsx` (debounced `onAstChange` for Properties refresh).
- **DoD bullets:**
  - Six-row demo doc renders with correct cell types; each edit round-trips.
  - Adding a property to a frontmatter-less file inserts a valid `---` block.
  - Unknown / nested values render raw and are read-only.
  - Properties refresh is driven by `onAstChange` — raw-mode edits to frontmatter flow back without flicker.
- **Prereqs:** Sessions A + C.

### Session F — Interactive smoke + L2 closeout

- **Scope:** no new code. Interactive `cargo tauri dev` pass exercising all six surfaces against a vault containing diverse `.md` files (with and without frontmatter, with each in-scope Lezer node type, with one file simulating an external edit during a dirty buffer). Record observed values in §9.6 below. Rewrite `CLAUDE.md` "Project state" block to reflect L2 closed. Apply the `l2` git tag.
- **Key files:** `docs/layer-2-spec.md` (§9 fill-in), `CLAUDE.md` (state rewrite).
- **DoD bullets:**
  - Every §6 DoD checkbox ticked.
  - §9.6 smoke pass recorded with timestamps + observed hashes / latencies.
  - `l2` tag applied on the closeout commit.
- **Prereqs:** Sessions A through E.

---

## 9. What was built

*[Filled in per session as L2 lands.]*

### 9.1 Session A — Writable editor + Live Preview decorations

*Pending.*

### 9.2 Session B — Settings infrastructure

*Pending.*

### 9.3 Session C — Theme mechanism + CM6 theme generator

*Pending.*

### 9.4 Session D — Raw Source toggle

*Pending.*

### 9.5 Session E — Properties UI

*Pending.*

### 9.6 Session F — Interactive smoke + L2 closeout

*Pending.*
