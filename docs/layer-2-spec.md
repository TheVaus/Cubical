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

6. **Raw-source toggle button lives in the header chrome strip, not next to the vault path.** §2.3 specified the `</>` button "in the header next to the vault path." The vault path actually renders inside the content section (a mono `<p>` above the file list / editor split), while Session D established the header's right side as the chrome-button strip (theme cycle button). Session E placed the `</>` button there, next to the theme button, rather than next to the vault path. Reason: co-locating the two app-chrome toggles is more discoverable and consistent than splitting them; the vault-path line is content, not chrome. Cosmetic — no behavioral impact.

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
- [ ] Interactive smoke pass against `cargo tauri dev` recorded in §9.7 (the closeout session). All six L2 surfaces exercised by hand.
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

Seven sessions. Each session has one feature surface and is independently verifiable; the closeout session is its own session per user direction so smoke + tag are not bundled under feature implementation. The seam between Session A (write-path) and Session B (decorations) was chosen deliberately — those two share no state, and the conflict banner stays bundled with the write-path because it is what makes autosave safe.

### Session A — Writable editor (write-path + safety)

The full write-path story together, because every piece touches the same two pieces of state (`seen_hash` and `last_written_hash`).

- **Scope:** `write_file_text` IPC (Rust pure handler + Tauri shim); autosave in `Editor.tsx` (300ms debounce, blur flush, file-change flush, app-quit flush); `new_content_hash` plumbed onto the `vault:file-changed` event payload; hash-gating suppression in the Editor so the editor doesn't see its own writes; external-edit detection via `seen_hash` mismatch; conflict banner UI ("Reload from disk" / "Keep my edits") with the `external_edit_override` audit_log row on Keep mine.
- **Key files:** `crates/cubical-app/src/{api/types.rs, commands/vault.rs, lib.rs}`, `crates/cubical-app/src/events.rs` (add `new_content_hash` to `VaultFileChangedPayload`), `crates/cubical-core/src/vault/watcher.rs` (emit the already-computed hash), `ui/src/Editor.tsx`, `ui/src/api/ipc.ts`, `ui/src/App.tsx` (conflict banner mount point above the Editor slot).
- **DoD bullets:**
  - `write_file_text` happy + error paths covered by Rust tests (markdown-only gate, atomic round-trip, hash returned).
  - Autosave round-trip: buffer dirty → 300ms idle → file on disk matches buffer byte-for-byte (verified via SHA-256); `vault:file-changed` round-trip suppressed via hash gating; file list / audit log still see the event.
  - Editor blur flushes any pending write before the focus actually moves.
  - File-selection change flushes the previous file's pending write before loading the new file.
  - External-edit conflict banner appears with a dirty buffer; **Reload** discards the buffer and re-reads; **Keep mine** resumes autosave and the next write overwrites the external version; `audit_log` row category `external_edit_override` recorded on Keep mine with the overwritten hash.
  - Clean-buffer external edit silently reloads (no banner).
- **Prereqs:** L1 carry-over interactive smoke pass.

### Session B — Live Preview decorations

Pure CodeMirror / Lezer work. No write-path entanglement; verifiable on a read-only buffer.

- **Scope:** Lezer-driven CM6 `ViewPlugin` at `ui/src/editor/decorations.ts` covering the §2.2 table (ATX + Setext headings, emphasis, strong, inline code, fenced + indented code blocks, bullet + ordered lists, blockquotes, plain `[text](url)` links); active-line detection via `view.state.doc.lineAt(selection.main.head)`; decorations on the active line dropped so raw markdown shows through; the plugin sits in a CM6 `Compartment` so Session E (raw toggle) can swap it for a no-op extension. All visual values consume CSS vars; no hardcoded colors.
- **Key files:** `ui/src/editor/decorations.ts` (new), `ui/src/Editor.tsx` (compose the plugin + compartment into the `EditorState`), `ui/src/styles/tokens.css` (any new tokens that surface — `--editor-active-line-bg`, `--editor-mark-fg-muted`).
- **DoD bullets:**
  - A demo doc containing one of each in-scope node type renders with the decoration applied on non-cursor lines.
  - Cursor on a decorated line reveals the raw markdown (markers + url + brackets visible).
  - Tables, images, wiki-links, embeds, block IDs, tags, task-list markers all stay raw — no accidental decoration.
  - Visual smoke pass against `cargo tauri dev` recorded as part of the session notes.
- **Prereqs:** Session A (the conflict banner / write path must be in place so visual smoke can exercise the editor end-to-end without losing edits).

### Session C — Vault-local settings infrastructure

- **Scope:** `get_setting` / `set_setting` IPC (Rust pure handlers + shims); typed `ipc.ts` wrappers with the `Setting` discriminated union; no UI changes yet.
- **Key files:** `crates/cubical-app/src/{api/types.rs, commands/vault.rs, lib.rs}`, `ui/src/api/ipc.ts`.
- **DoD bullets:**
  - Round-trip a boolean, a string, a numeric, and a `null` value through `set_setting` → `get_setting`. Reopen the vault; values persist.
  - Reading an absent key returns `value: None`.
  - JSON parse failure on a corrupt value returns `InvalidRequest` (not a panic).
  - Rust + TypeScript types are kept in lockstep (typed `Setting` union in `ipc.ts`).
- **Prereqs:** Session A (the IPC pattern needs Session A's typing precedent to mirror; no functional dep).

### Session D — Theme mechanism + CM6 theme generator

- **Scope:** audit `tokens.css` (tune dark values, add any new editor-surface tokens not added by Session B); new `ui/src/styles/theme.ts` (`applyTheme`, system-preference subscription via `matchMedia`); new `ui/src/editor/cm-theme.ts` (CM6 `Extension` reading computed CSS vars; rebuild on theme change via the editor's theme compartment); theme button in `App.tsx` header cycling `light → dark → system`; reads/writes `appearance.theme_mode` via Session C's IPC.
- **Key files:** `ui/src/styles/tokens.css`, `ui/src/styles/theme.ts` (new), `ui/src/editor/cm-theme.ts` (new), `ui/src/Editor.tsx` (theme compartment), `ui/src/App.tsx` (theme button).
- **DoD bullets:**
  - `data-theme="light"` and `data-theme="dark"` both render Session B's decorations with adequate contrast (verified manually).
  - `system` mode flips on OS theme change without reload.
  - `appearance.theme_mode` persists across app restart.
  - CM6 theme tracks UI theme — no visual divergence between editor and surrounding chrome.
- **Prereqs:** Sessions B + C (B's decorations need theme tokens; C's settings store the mode).

### Session E — Raw Source toggle

- **Scope:** `</>` button in `App.tsx` header; `Cmd/Ctrl+E` CM6 keymap; Solid signal for per-doc transient override (resets on file selection change); Shift-click writes `editor.raw_source_default` via Session C's IPC; Editor swaps the Session B decoration plugin for a no-op extension via the CM6 compartment when raw mode toggles.
- **Key files:** `ui/src/App.tsx`, `ui/src/Editor.tsx` (decoration compartment).
- **DoD bullets:**
  - Naked click flips the current doc; Shift-click sets the default; restart honors the default.
  - `Cmd/Ctrl+E` keybind works while the editor has focus.
  - Switching files resets the per-doc override to match the current default.
  - Lezer parsing keeps running in raw mode (`onAstChange` still fires) so Properties UI in Session F stays live.
- **Prereqs:** Sessions B + C (B's compartment is what we swap; C's settings hold the default). D is nice-to-have so the toggle button looks right in dark, but not blocking.

### Session F — Properties UI

- **Scope:** `Properties.tsx` + the `properties/` subdir (six cell components + `inferType` + `serializeFrontmatter`); mount above the Editor in `App.tsx` for markdown files; type inference from parsed `Frontmatter`; type override menu; commit through the shared autosave queue introduced in Session A.
- **Key files:** `ui/src/Properties.tsx` (new), `ui/src/properties/*` (new), `ui/src/App.tsx`, `ui/src/Editor.tsx` (debounced `onAstChange` for Properties refresh).
- **DoD bullets:**
  - Six-row demo doc renders with correct cell types; each edit round-trips.
  - Adding a property to a frontmatter-less file inserts a valid `---` block at file start.
  - Unknown / nested values render raw and are read-only.
  - Properties refresh is driven by `onAstChange` — raw-mode edits to frontmatter flow back without flicker.
- **Prereqs:** Sessions A + D (A's `write_file_text` is the commit path; D's theme tokens style the cells). C indirectly via D.

### Session G — Interactive smoke + L2 closeout

- **Scope:** no new code. Interactive `cargo tauri dev` pass exercising all six L2 surfaces (write+autosave, decorations, settings, theme, raw toggle, properties) against a vault containing diverse `.md` files (with and without frontmatter, with each in-scope Lezer node type, with one file simulating an external edit during a dirty buffer). Record observed values (latencies, hashes, audit_log row IDs) in §9.7. Rewrite `CLAUDE.md` "Project state" block to reflect L2 closed. Apply the `l2` git tag.
- **Key files:** `docs/layer-2-spec.md` (§9 fill-in), `CLAUDE.md` (state rewrite).
- **DoD bullets:**
  - Every §6 DoD checkbox ticked.
  - §9.7 smoke pass recorded with timestamps + observed hashes / latencies.
  - `l2` tag applied on the closeout commit.
- **Prereqs:** Sessions A through F.

---

## 9. What was built

*[Filled in per session as L2 lands.]*

### 9.1 Session A — Writable editor (write-path + safety)

#### Atomic write helper (load-bearing prerequisite)

L0 §4 documented the temp-file + fsync + rename procedure but didn't actually land a callable. L2 Session A could not honor "all writes go through `cubical-core`'s temp-and-rename helper" without first implementing it. New module [`crates/cubical-core/src/vault/atomic.rs`](../crates/cubical-core/src/vault/atomic.rs) exposes `pub fn atomic_write(target: &Path, content: &[u8]) -> Result<(), VaultError>` — sync, called via `tokio::task::spawn_blocking` so `fsync` doesn't stall the runtime. Windows retry is wired in (50ms / 200ms / 800ms backoff) but only triggered by `is_transient_rename_error`, which is `false` on POSIX (no retry path runs on macOS/Linux).

#### Watcher exclude filter (load-bearing prerequisite)

The watcher (and scan) `is_excluded` filters skipped dot-prefixed directories but not the `.cubical-tmp` suffix used by `atomic_write`. Every autosave was leaking three watcher events (create + modify of the temp file, modify of the target) and the temp path was being upserted into the `files` table before the rename. Both filters in [`crates/cubical-core/src/vault/watcher.rs::is_excluded`](../crates/cubical-core/src/vault/watcher.rs) and [`crates/cubical-core/src/vault/scan.rs`](../crates/cubical-core/src/vault/scan.rs) now drop files whose extension is `cubical-tmp`. After the fix, each autosave produces exactly one `Modified <target>` event in the logs.

#### Rust IPC

`write_file_text` lands in [`crates/cubical-app/src/commands/vault.rs`](../crates/cubical-app/src/commands/vault.rs) following the §8 pure-handler / thin-shim pattern.

- Looks up the path in `files`, rejects non-`markdown` with `InvalidRequest`, captures the on-disk hash.
- Computes the post-write hash from the buffer bytes (`cubical_core::sha256_bytes_hex` — newly exposed helper that mirrors the file-streaming `sha256_file_hex` digest without re-reading disk).
- Runs `atomic_write` inside `spawn_blocking`.
- Pre-write audit row: when `expected_seen_hash` is `Some` and doesn't match the captured on-disk hash, inserts a `level='warn', category='external_edit_override'` row with detail `{path, expected, actual}`. Spec §3.1 keeps `expected_seen_hash` advisory in L2 — the write proceeds. Hard rejection lands in L8 alongside the merge UI.
- Post-write: updates the `files` row with new size, mtime, hash; inserts a `level='info', category='autosave'` row with detail `{path, bytes, new_content_hash}`.
- Returns `{new_content_hash, new_mtime_unix}` so the editor can populate `last_written_hash` for §2.8 hash-gating.

Wire types in [`crates/cubical-app/src/api/types.rs`](../crates/cubical-app/src/api/types.rs); Tauri shim in [`crates/cubical-app/src/lib.rs`](../crates/cubical-app/src/lib.rs); `invoke_handler` updated.

#### Watcher payload extension

`VaultFileChanged` gains `new_content_hash: Option<String>` (`#[serde(skip_serializing_if = "Option::is_none")]`). `apply_watch_event_to_db` returns `Option<String>` instead of `()`; `handle_watch_event` threads the hash into `file_changed_payload`. The hash is set for `Created` and `Modified` (when the disk read succeeded), `None` for `Removed`/`Renamed`. The shape is invariant on event kind — `file_changed_payload` drops any inbound hash on `Removed`/`Renamed` regardless of caller intent.

#### Frontend wire layer

[`ui/src/api/ipc.ts`](../ui/src/api/ipc.ts) gains `writeFileText` + its request/response types, and the `VaultFileChanged` event payload now carries `new_content_hash?: string`. Solid's `exactOptionalPropertyTypes` requires building the request object conditionally — `expected_seen_hash` is omitted when `null`, not set to `undefined`.

#### Editor refactor

[`ui/src/Editor.tsx`](../ui/src/Editor.tsx) gains three callback props and one imperative-ref escape hatch, keeping autosave coordination in `App.tsx`:

- `onContentChange(content)` fires raw on every `docChanged` so the parent's 300ms debounce can be shared with blur / file-change flushes.
- `onBlur()` fires when CM6's `focusChangeEffect` reports focus loss.
- `ref({ getContent, replaceContent })` lets the parent flush (read the current buffer for the IPC) and reload (replace the doc on "Reload from disk" without fighting the next `value` prop tick).

The Lezer-backed 150ms `onAstChange` from L1 is untouched.

#### App-level autosave + conflict orchestration

[`ui/src/App.tsx`](../ui/src/App.tsx) owns per-file `seenHash` / `lastWrittenHash` / `dirty` and the 300ms autosave timer. Flush triggers (§2.1):

- Idle debounce — the typical path.
- Blur — `Editor.onBlur` → `flushAutosave()`.
- File-selection change — `handleSelectFile` awaits `flushAutosave()` before reading the next file.
- App-quit — `beforeunload` cancels the debounce and fires `performWrite()` synchronously (best-effort, the webview tear-down may race).

`flushAutosave` chains serially via a `pendingWrite: Promise<void>` so two flushes don't race — the second's `expected_seen_hash` sees the first's hash update. `performWrite` only clears `dirty` if the buffer still matches what was written (handles keystrokes during the IPC await).

Hash-gating in the `vault:file-changed` listener: incoming events whose `new_content_hash === lastWrittenHash` are dropped before any conflict logic runs. Surviving events branch on `dirty`:

- Dirty buffer → `setConflictExternalHash(incoming)`, cancel pending debounce, banner appears.
- Clean buffer → silent re-read via `readFileText`, `replaceContent`, `seenHash = incoming`.

#### Conflict banner

Mounted above the Editor when `conflictExternalHash() !== null`. Two buttons:

- **Reload from disk** → `readFileText` + `editorApi.replaceContent` + reset hashes + clear `dirty` + clear banner.
- **Keep my edits** → just clear the banner; autosave resumes; the next `performWrite` carries the stale `seenHash` as `expected_seen_hash`, the Rust handler detects the mismatch, and writes the `external_edit_override` audit_log row.

Styled with existing tokens (`--c-bg-secondary`, `--c-border-subtle`, `--c-accent`) with a `--c-warning` fallback so the warn aesthetic is consistent if/when D adds that token.

#### Audit verification

Smoke pass on macOS at session close:

```sql
SELECT level, category, message FROM audit_log
WHERE category IN ('autosave', 'external_edit_override') ORDER BY id;
-- info | autosave                | autosave welcome.md
-- info | autosave                | autosave note.md
-- warn | external_edit_override  | override external edit on welcome.md
-- info | autosave                | autosave welcome.md
```

#### Test counts (cumulative)

**Rust:** cubical-ast 26 + 1 parity_fixtures · cubical-core 49 (was 42; +6 atomic_write tests, +1 watcher temp-file filter test) · cubical-index 6 · cubical-app 29 (was 17; +8 write_file_text tests, +4 watcher hash-plumbing/payload tests) = **111 Rust tests across the workspace, all green**.

**UI:** 23 vitest tests (unchanged — Session A is plumbing, no new TS units).

#### Interactive smoke (recorded)

Against `cargo tauri dev` with `/Users/user/Developer/sandbox/cubical-demo`:

- Type → wait → switch file → switch back: edits persist (`Yes` on the autosave round-trip check).
- Editor doesn't reset on its own watcher event (own-write suppression working — observed cursor doesn't jump during continuous typing through autosave boundaries).
- Conflict banner appears when the external append lands during the 300ms-dirty window. Both buttons confirmed working: "Reload from disk" replaces the buffer with disk contents; "Keep my edits" preserves the buffer and lets autosave overwrite.
- Watcher log: one `kind=Modified path=<file>` event per autosave (down from three pre–temp-file-filter).

Race-on-banner caveat: with manual terminal `printf`, the 300ms debounce is usually faster than typing-then-running-the-command, so the autosave fires first and the next external append goes through the clean-buffer silent-reload path. Spec-correct, but it makes the banner harder to reach in manual testing than in the Rust unit test (which forces the mismatch by manipulating `content_hash` directly).

#### Architectural notes

- **`expected_seen_hash` is advisory until L8.** The `write_file_text` handler unconditionally proceeds when `expected_seen_hash` is set and mismatched, writing the `external_edit_override` audit row as a breadcrumb. L8's 3-way merge UI is the only viable consumer of a hard `Conflict` rejection; until then, the user's "Keep my edits" choice from §2.7 is the source of truth.
- **`atomic_write` is sync by design.** It returns from `spawn_blocking` so `fsync` doesn't stall the runtime. Making it `async fn` would force every L1+ caller into the same call pattern; keeping it sync lets non-async tools (future plugin host, headless exporters) call it directly.
- **Frontend owns autosave timing.** Putting the 300ms debounce in `Editor.tsx` would force file-change and blur flushes through callbacks anyway; putting it in `App.tsx` keeps timer ownership next to the IPC call and the per-file hash bookkeeping. Editor.tsx still owns the AST debounce (150ms) — different consumers, different cadence.

### 9.2 Session B — Live Preview decorations

Session B complete — see the `feat(ui): Lezer-driven Live Preview decorations` commit. Full write-up is Session G's closeout job. Summary: `ui/src/editor/decorations.ts` ships a Lezer-driven CM6 `ViewPlugin` covering the §2.2 table; composed into `Editor.tsx` via a `Compartment` (the seam Session E reconfigures); two editor tokens added to `tokens.css`. 14 new vitest cases.

### 9.3 Session C — Vault-local settings infrastructure

Two pure-handler-plus-shim Tauri commands over the L0 `config` table
(`key TEXT PRIMARY KEY, value TEXT NOT NULL`). No schema migration —
the table has existed since L0 migration `001_initial.sql`.

#### Rust IPC

`get_setting` / `set_setting` land in
[`crates/cubical-app/src/commands/vault.rs`](../crates/cubical-app/src/commands/vault.rs)
following the §8 pure-handler / thin-shim pattern.

- `get_setting` reads `config.value` for the key. Absent key →
  `value: None`; a stored JSON `null` → `value: Some(Value::Null)` (the
  two are deliberately distinct). A row whose value is not valid JSON
  is surfaced as `InvalidRequest` — never a panic.
- `set_setting` upserts via `INSERT … ON CONFLICT(key) DO UPDATE`,
  always `serde_json::to_string`-encoding the value first so non-string
  types round-trip. An existing key is overwritten.

Wire types in [`crates/cubical-app/src/api/types.rs`](../crates/cubical-app/src/api/types.rs)
(`GetSettingRequest`/`Response`, `SetSettingRequest`/`Response`);
Tauri shims in [`crates/cubical-app/src/lib.rs`](../crates/cubical-app/src/lib.rs);
`invoke_handler` updated.

#### Frontend wire layer

[`ui/src/api/ipc.ts`](../ui/src/api/ipc.ts) gains the typed `Setting`
discriminated union (§3.4) plus a `SettingValue<K>` helper. `getSetting`
and `setSetting` are generic over the key, so a misspelled or
wrong-typed key fails to compile. `getSetting` is `async` (not a
`.then()` chain) — TypeScript cannot narrow the `SettingValue<K>`
conditional type through `Promise.prototype.then`'s `PromiseLike`
union, but `await` sidesteps that.

#### Test counts (cumulative)

**Rust:** cubical-ast 26 + 1 parity · cubical-core 49 · cubical-index 6 ·
cubical-app 39 (was 29; +10 settings tests: boolean/string/number/null
round-trips, absent-key `None`, corrupt-JSON `InvalidRequest`, upsert
overwrite, unknown-vault for both handlers, and a close-then-reopen
test proving values survive on disk in `index.db`) = **121 Rust tests
across the workspace, all green**.

**UI:** 37 vitest tests (unchanged — the typed wrapper is plumbing;
the `Setting` union is verified by `tsc --noEmit`, consistent with
Session A adding `writeFileText` without new TS units).

#### Architectural notes

- **No UI this session.** The raw-source toggle (E) and theme button
  (D) are the consumers; C ships only the plumbing.
- **`config` is generic; the typed union lives only in TS.** Rust
  stores any key / any JSON value. `ipc.ts`'s `Setting` union is the
  frontend's typed view — later layers extend the union without
  touching Rust.

### 9.4 Session D — Theme mechanism + CM6 theme generator

Session D complete — see the `feat(ui): light/dark theming + CM6 theme generator` commit series. Full write-up is Session G's closeout job. Summary: `tokens.css` audited + dark values tuned, `--editor-caret`/`--editor-selection-bg` added; `ui/src/styles/theme.ts` ships `applyTheme` + the pure `resolveTheme` + a `matchMedia` subscription; `ui/src/editor/cm-theme.ts` builds the CM6 chrome theme from computed tokens; `Editor.tsx` carries a theme `Compartment` alongside Session B's decoration compartment; `App.tsx` gains the `system→light→dark` header cycle button persisting `appearance.theme_mode`. 4 new vitest cases (theme-resolution).

### 9.5 Session E — Raw Source toggle

Frontend-only — no Rust, no new IPC. Consumes Session C's
`getSetting`/`setSetting` and reconfigures Session B's decoration
`Compartment`.

#### Effective-state resolver

[`ui/src/editor/rawSource.ts`](../ui/src/editor/rawSource.ts) ships the
pure `resolveRawState(override: boolean | null, appDefault: boolean)`.
The toggle has two layers of state:

- **App default** — `editor.raw_source_default`, seeded on vault open;
  absent key → `false` (Live Preview out of the box).
- **Per-doc override** — a transient in-memory choice; `null` means
  "defer to the default." It resets to `null` on every file-selection
  change, so a freshly opened file always starts from the app default,
  never the previous file's override.

`resolveRawState` collapses the two (`override ?? appDefault`). Unit
tested in [`rawSource.test.ts`](../ui/src/editor/rawSource.test.ts) —
4 cases: default fallback, override-true-over-false-default,
override-false-over-true-default, and the reset-to-null case proving a
fresh file resolves to the default.

#### `App.tsx`

`rawDefault` (signal) + `rawOverride` (signal, `boolean | null`) feed
the `effectiveRaw` memo. A `</>` button joins the header chrome strip
next to Session D's theme button (`aria-label="Toggle raw source"`,
`aria-pressed` bound to `effectiveRaw()`, accent styling when raw is
on):

- **Naked click** → `toggleRawSource()` flips the per-doc override
  against the current effective state. No setting written.
- **Shift-click** → `setRawAsDefault()` persists
  `editor.raw_source_default` via `setSetting` and clears the per-doc
  override so the new default takes effect immediately for the open
  document.

`handleSelectFile` resets the override to `null`; vault open both
resets the override and seeds `rawDefault` from the stored setting.

#### `Editor.tsx`

Two new props: `rawSource: boolean` and `onToggleRawSource?: () =>
void`. The decoration `Compartment` (Session B's seam) is initialized
to `[]` when `rawSource` is true and reconfigured by a `createEffect`
on `props.rawSource` — raw mode swaps the Live Preview plugin for a
no-op so the hidden marker spans reappear. Lezer parsing is untouched,
so `onAstChange` keeps firing in raw mode (Session F's Properties UI
stays live). A `Cmd/Ctrl+E` (`Mod-e`) entry leads the CM6 `keymap`,
calling `onToggleRawSource` (same effect as the button's naked click).

#### Deviation

§5 #6: the `</>` button sits in the header chrome strip next to the
theme button, not next to the vault path as §2.3 worded it. Cosmetic.

#### Test counts (cumulative)

**Rust:** unchanged — 121 tests (Session E is frontend-only).

**UI:** 50 vitest tests (was 46; +4 `resolveRawState` cases).

#### Verification

- `npm run typecheck`, `npm run build`, `npx vitest run` — all clean
  (50/50 green).
- `cargo tauri dev` — Rust + Vite compile clean, app boots.
- Browser smoke (`localhost:5173`, pre-vault state): `</>` button
  renders next to the theme button; naked click flips it to the accent
  raw-on state; no console errors.
- Editor decoration swap, `Cmd/Ctrl+E`, file-switch override reset, and
  Shift-click persistence need the native app + an open vault — left to
  the Session G interactive closeout.

### 9.6 Session F — Properties UI

Frontend-only — no Rust, no new IPC. Properties commits ride Session A's
autosave path; the frontend owns frontmatter serialization (spec §5 #1).

#### Brainstorming decisions

Four open §2.4 design questions were settled before implementation:

- **(a) Round-trip fidelity.** `parseFrontmatterYaml` uses the `yaml`
  package's plain `parse()`, which drops comments, anchors, and aliases
  at parse time — reserializing from `entries` cannot reproduce them.
  Decision: `hasUnmodelableYaml` (in
  [`serializeFrontmatter.ts`](../ui/src/properties/serializeFrontmatter.ts))
  inspects the raw frontmatter text via `yaml`'s `parseDocument`/`visit`;
  if comments, anchors, aliases, or a parse error are present the whole
  Properties panel renders **read-only** with a banner + raw dump +
  "Open as raw". The serializer therefore only ever runs on fully
  modelable frontmatter — the entries→`stringify` round-trip is provably
  lossless. Per-row nested/unknown values still render raw read-only.
- **(b) Lossy type-coercion.** `coerceValue`
  ([`coerce.ts`](../ui/src/properties/coerce.ts)) always yields a
  *valid* value of the target kind (number-parse failure → `0`, bad
  date → `""`, bad boolean → `false`), so cell-kind and value never
  disagree. When the conversion loses information the row shows a
  **non-dismissable** warning chip carrying the pre-coercion value;
  one click reverts both type and value. The chip persists until the
  row is next edited — it is the only on-disk-safety net for a lossy
  change in an autosave-first app.
- **(c) Write-path integration.** Surgical, not whole-doc. A new
  `EditorApi.replaceRange(from, to, text)` replaces only the frontmatter
  span, leaving the body cursor put (whole-doc `replaceContent` jumps it
  to EOF). The `replaceRange` dispatch surfaces as an ordinary
  `docChanged` → `onContentChange` → Session A `dirty`/`scheduleAutosave`
  — Properties never calls `writeFileText` itself.
- **(d) Raw-mode-vs-Properties race.** Rows are keyed by key-name (a
  `<For>` over a stable key-string array), so an `onAstChange` tick does
  not remount rows. Every cell holds a focus-guarded local draft and,
  while focused, ignores incoming `value` prop changes. Raw-mode
  frontmatter edits flow back through unfocused cells with no flicker;
  an in-progress Properties edit is never clobbered.

#### Deviation — `aliases` is not a tag list

Spec §2.4 and the Session F task brief both said a string array under
`aliases` should render as `list-of-tags` (`#`-prefixed, accent). The
locked architecture (`document-model.md` §5.6) only ever defines `tags:`
as a tag source — `aliases` are alternate note *names*, not tags, and
L3 would wrongly autocomplete them against the tag index. Confirmed with
the operator: **only `tags` → `list-of-tags`; `aliases` → plain
`list-of-strings` chips.** `inferType`'s `TAG_LIST_KEYS` set holds
`tags` alone.

#### What was built

New `ui/src/properties/`:

- `inferType.ts` — pure `(key, value) → CellKind`
  (`string`/`number`/`boolean`/`date`/`list-of-strings`/`list-of-tags`/`raw`).
- `serializeFrontmatter.ts` — `serializeFrontmatter` (entries → `---`
  block), `spliceFrontmatter` (block → source helper), `hasUnmodelableYaml`.
- `coerce.ts` — `coerceValue` for the type-override menu (decision (b)).
- Seven cell components: `StringCell`, `NumberCell`, `BooleanCell`,
  `DateCell`, `StringListCell`, `TagListCell`, `RawCell`.
- Three internal helpers (not in the §4 file list, noted here):
  `ChipList.tsx` (shared chip-row primitive behind the two list cells),
  `styles.ts` (token-only inline-style helpers), and `coerce.ts` above.

[`Properties.tsx`](../ui/src/Properties.tsx) — the panel: one keyed row
per top-level key (internal `PropertyRow`), empty/populated states with
a `+ Add property` affordance, click-to-rename keys, a per-row type
chevron menu, and the modelable read-only fallback. Mounted above the
editor in [`App.tsx`](../ui/src/App.tsx) for the selected markdown file,
fed `frontmatter` from a new `propertiesFrontmatter` signal set on each
`onAstChange` tick. [`Editor.tsx`](../ui/src/Editor.tsx) gained
`EditorApi.replaceRange` (decision (c)).

#### Test counts (cumulative)

**Rust:** unchanged — **121 tests** (Session F is frontend-only).

**UI:** **99 vitest tests** (was 50; +49 — `inferType` 15, `coerce` 14,
`serializeFrontmatter` 20: serialize/splice/`hasUnmodelableYaml`, the
serialize→split→parse round-trip, and the parse→edit→serialize→re-parse
round-trip).

#### Verification

- `cargo test --workspace` — 121 green (no Rust touched).
- `npx tsc --noEmit`, `npm run build` — clean (strict mode, no `any`).
- `npx vitest run` — 99/99 green.
- Prettier — clean (repo has no eslint config; `tsc` strict + Prettier
  are the enforced gates).
- No hardcoded colors/fonts in any Properties component (grep verified);
  spacing uses `--space-*` tokens, only fixed widget geometry uses rem
  literals — consistent with `App.tsx`'s header-button sizing.
- Browser smoke (`localhost:5173`, pre-vault): app boots, no console
  errors — confirms the Properties module graph compiles and loads.

#### Smoke status — deferred to Session G

The Properties UI only mounts after a vault is open and a markdown file
selected, which requires the Tauri IPC backend (`open_vault`,
`read_file_text`). As in Session E, native-window interaction —
the six-row demo doc, per-cell edit + on-disk round-trip, frontmatter-less
add, the raw-mode flow-back — is left to the Session G interactive
closeout (`cargo tauri dev`). All logic underneath those flows is unit-
tested (the 49 new cases) and the round-trip is proven losslessly at the
`serializeFrontmatter` level.

#### Post-merge fixes (2026-05-20)

The operator's first interactive smoke on the merged Session F caught
two bugs.

- **Properties showed in raw mode.** Spec §2.4 had Properties stay
  visible in raw mode (so raw-typed frontmatter would "flow back"). In
  practice the operator expected raw mode to mean "see the file as-is"
  — the parallel Properties panel was redundant with the raw YAML now
  showing in the editor itself. The `<Properties>` mount in
  [`App.tsx`](../ui/src/App.tsx) is now wrapped in
  `<Show when={!effectiveRaw()}>`. This is a deliberate spec deviation
  beyond the §5 set: the §2.4 "raw-mode flow-back" still applies when
  the user toggles *back* to live preview (Properties remounts from the
  current frontmatter), but no longer in real-time while raw is active.
- **Renaming a freshly-added property reverted to the default name.**
  Cause: the focus-guarded `createEffect` in `PropertyRow` (and the
  string/number/date/chip cells) re-ran on every focus change because
  it read `keyFocused()` reactively. On blur, the effect fired with
  the *old* `props.keyName` ("property") before the 150ms AST tick
  could update it, resetting the draft to the stale name. The rename
  *had* committed to the buffer — the new row arrived 150ms later —
  but the old row's display flickered back to "property" inside that
  window, which read to the operator as "it reverted." Fix: all five
  focus-guarded effects are now `createEffect(on(() => props.value,
  (v) => { if (!focused()) setDraft(v); }))` — `on()` makes them
  re-run *only* on actual prop changes, never on focus alone. Same
  latent flicker existed in the value cells but was less visible
  because those rows stay mounted; fixed pre-emptively.

Tests, types, build, prettier all still clean — fixes are pure
reactivity reshape, no logic surface change.

### 9.7 Session G — Interactive smoke + L2 closeout

*Pending.*
