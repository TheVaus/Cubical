> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session H.1 — Embed content extractor + IPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend half of Session H — a `get_embed` IPC that, given a wiki-link target (`note` / `note#heading` / `note#^id`), returns the content to be rendered inline by the (deferred) embed widget. Pure markdown-aware extractors do the work; the handler is a thin orchestrator.

**Architecture:** New `cubical-core::vault::embeds` module with three pure functions (`extract_section`, `extract_block`, `strip_frontmatter`) — fully unit-testable. New `cubical-app::commands::embeds::get_embed` handler mirrors `commands::autocomplete::block_id_autocomplete`: snapshot `files.path`, `resolve_target`, read file off-runtime, route by anchor kind to the matching extractor, return a tagged response. Widens `commands::links::split_target_anchor` to `pub(crate)` for reuse. Zero frontend code beyond the IPC binding (used in H.2).

**Tech Stack:** Rust (`cubical-core` pure module, `cubical-app` handler, Tauri shim), TypeScript (IPC binding only). Reuses `cubical_index::blocks_for_file` (Session G), `cubical_core::vault::links::{resolve_target, read_source_off_executor}`, and `crate::commands::links::split_target_anchor` (widened in this session).

**Branch:** Work on a new branch `l3-session-h1-embed-extractor` cut from `main` (single-checkout workflow — no worktrees).

**Design:** `docs/superpowers/specs/2026-05-29-l3-session-h1-embed-extractor-design.md`.

---

## Background — read before touching code

You have no prior context. Read this and the referenced files before starting.

- **Spec §2.8** (`docs/layer-3-spec.md`): `![[target]]` renders a note inline, `![[…#heading]]` a section, `![[…#^id]]` a block. Recursion bounded at depth 4 (default), beyond → styled link; unresolved → placeholder. **All recursion / widget concerns are H.2** — this session returns one slice at a time.
- **`resolve_target`** (`cubical_core::vault::links::resolve_target`) accepts exact vault path with/without `.md`, then unique basename. Snapshot pattern: `SELECT path FROM files ORDER BY path` → build `Vec<String>` → call. `block_id_autocomplete` (`crates/cubical-app/src/commands/autocomplete.rs`, search "block_id_autocomplete") is the model — copy the file-snapshot loop verbatim.
- **`split_target_anchor`** (`crates/cubical-app/src/commands/links.rs:63`) splits `target_raw` into `(target_string, Option<ResolvedAnchor>)`. **Currently private**. This plan widens it to `pub(crate)` and reuses it; do not duplicate the parsing.
- **`ResolvedAnchor`** (`crates/cubical-app/src/api/types.rs:300`) is `enum { Heading { value: String }, Block { value: String } }`. The `value` stores the anchor text without `#`/`^` (matching `Anchor::Block { value }` from `cubical-ast::wikilink::parse_body`).
- **`read_source_off_executor`** (`cubical_core::vault::links::read_source_off_executor`, `pub(crate)`) reads a file off the tokio runtime as lossy UTF-8, returning `Option<String>`. Already used by `refresh_blocks`. **This module is in `cubical-core`'s `vault` tree; `cubical-app` doesn't have access through `pub(crate)`.** Widen to `pub` in this session (one-line visibility change) so the handler can call it.
- **`blocks_for_file(conn, &path) -> Vec<BlockRow>`** (`cubical_index::blocks_for_file`, Session G). `BlockRow { block_id: String, position_hint: u64 }`. `position_hint` is the byte offset of the start of the line carrying `^id` — set by Session G's `extract_block_ids`. This is *exactly* what `extract_block` consumes.
- **`vault::blocks`** lives at `crates/cubical-core/src/vault/blocks.rs` and is declared `pub mod blocks;` in `vault/mod.rs:19`. **`vault::embeds`** will be a sibling module in the same style.
- **No frontmatter-strip helper exists yet** in `cubical_core::vault::frontmatter`. We add one as a pure function inside the new `embeds` module — it's used only here for now, so don't pre-export it.
- **Handler module layout:** `crates/cubical-app/src/commands/mod.rs` lists `pub mod backlinks;`, `pub mod blocks;`, `pub mod links;`, etc. Add `pub mod embeds;` in alphabetical order. The handler test harness uses `fresh_state_with_vault` + `seed_file(vault, rel, type_id)` from `commands::autocomplete::tests` — pattern to copy.
- **Tauri shim + registration:** `crates/cubical-app/src/lib.rs` has one `#[tauri::command]` shim per handler, registered in `tauri::generate_handler![...]`. `block_id_autocomplete` is the recent precedent — copy it verbatim, renaming.
- **IPC binding:** `ui/src/api/ipc.ts` mirrors wire types + exports `invoke("name", { req })`. `blockIdAutocomplete` is the recent precedent.

### Scope boundaries — do NOT do these

- **No frontend widget, no embed.ts, no decoration changes.** The IPC binding is unused by design until H.2.
- **No recursion / depth cap / cycle detection in the backend.** The handler returns one slice; the widget walks the chain.
- **No setext-heading support** (`===` / `---` underline-style). ATX headings (`# foo`) only. Adding setext later is a non-breaking extractor change.
- **Don't introduce a new markdown parser dependency.** The extractors are simple line walks — they don't need Lezer / pulldown-cmark.

---

## File Structure

**Create:**
- `crates/cubical-core/src/vault/embeds.rs` — `extract_section`, `extract_block`, `strip_frontmatter`, slug helper, tests.
- `crates/cubical-app/src/commands/embeds.rs` — `get_embed` handler + tests.

**Modify:**
- `crates/cubical-core/src/vault/mod.rs` — declare `pub mod embeds;`.
- `crates/cubical-core/src/vault/links.rs` — widen `read_source_off_executor` from `pub(crate)` to `pub`.
- `crates/cubical-app/src/commands/links.rs` — widen `split_target_anchor` from `fn` to `pub(crate) fn`.
- `crates/cubical-app/src/api/types.rs` — `GetEmbedRequest`, `GetEmbedResponse`, `EmbedKind` enum.
- `crates/cubical-app/src/commands/mod.rs` — `pub mod embeds;`.
- `crates/cubical-app/src/lib.rs` — type imports, Tauri shim, registration.
- `ui/src/api/ipc.ts` — wire types + `getEmbed` binding.
- `docs/layer-3-spec.md` — append §9.12.
- `CLAUDE.md` — rewrite the Project state block.

---

### Task 1: Pure extractors (`cubical-core::vault::embeds`)

**Files:**
- Create: `crates/cubical-core/src/vault/embeds.rs`
- Modify: `crates/cubical-core/src/vault/mod.rs`

- [ ] **Step 1: Declare the module**

In `crates/cubical-core/src/vault/mod.rs`, add `pub mod embeds;` next to `pub mod blocks;` (alphabetical):

```rust
mod atomic;
pub mod blocks;
pub mod embeds;
mod frontmatter;
pub mod links;
mod scan;
pub mod tags;
mod watcher;
```

- [ ] **Step 2: Write the failing tests**

Create `crates/cubical-core/src/vault/embeds.rs` with the module doc-comment + tests + an empty `pub fn` for each so the file compiles to a failing assertion rather than a missing-symbol error:

```rust
//! Pure embed content extractors (L3 Session H.1, spec §2.8). One slice
//! per call — recursion / depth cap / cycle detection live on the
//! frontend in H.2. The handler in `cubical-app::commands::embeds`
//! routes by anchor kind.

/// Lowercase + collapse non-alphanumeric runs to `-` + trim leading/
/// trailing `-`. Used to compare heading text to an anchor value so
/// `"My Section!"` matches anchor `"my-section"` / `"My Section"` /
/// `"My Section!"` — they all slugify to `"my-section"`.
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.extend(c.to_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    trimmed.to_string()
}

/// Slice from the line *after* an ATX heading matching `anchor` (by
/// slug) up to the line *before* the next heading whose level is
/// `≤` the matched heading's. `None` if no heading matches.
pub fn extract_section(_source: &str, _anchor: &str) -> Option<String> {
    None
}

/// Block (paragraph or list-item) containing `byte_offset`: walk to
/// the nearest blank-line boundary on each side. `byte_offset` is the
/// start of a line per `BlockRow::position_hint`'s contract. Returns
/// the contiguous slice as a `String`.
pub fn extract_block(_source: &str, _byte_offset: u64) -> String {
    String::new()
}

/// If `source` opens with a YAML frontmatter block (`---\n…\n---\n`),
/// return the body slice after the closer. Otherwise return `source`
/// unchanged. Pure, borrow-returning.
pub fn strip_frontmatter(source: &str) -> &str {
    source
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_collapses_and_lowercases() {
        assert_eq!(slugify("My Section!"), "my-section");
        assert_eq!(slugify("My Section"), "my-section");
        assert_eq!(slugify("my-section"), "my-section");
        assert_eq!(slugify("---"), "");
    }

    #[test]
    fn extract_section_matches_heading_by_slug() {
        let src = "# My Section\nbody\n";
        assert_eq!(extract_section(src, "my-section"), Some("body\n".into()));
    }

    #[test]
    fn extract_section_respects_level_ceiling() {
        let src = "## A\nfoo\n# B\nbar\n";
        // anchor "a" matches "## A" (level 2); stops at "# B" (level 1 ≤ 2).
        assert_eq!(extract_section(src, "a"), Some("foo\n".into()));
    }

    #[test]
    fn extract_section_keeps_subheadings_below_the_matched_level() {
        let src = "# A\nfoo\n## A.1\nbar\n# B\n";
        assert_eq!(
            extract_section(src, "a"),
            Some("foo\n## A.1\nbar\n".into()),
        );
    }

    #[test]
    fn extract_section_returns_none_when_missing() {
        assert_eq!(extract_section("# A\nfoo\n", "ghost"), None);
    }

    #[test]
    fn extract_block_paragraph_walks_to_blank_lines() {
        let src = "para one\nstill para ^id\n\nnext\n";
        // Line "still para ^id" starts at offset 9.
        let offset = src.find("still para").unwrap() as u64;
        assert_eq!(extract_block(src, offset), "para one\nstill para ^id\n");
    }

    #[test]
    fn extract_block_list_item_block_ends_at_blank_line() {
        let src = "- a\n- b ^id\n- c\n\nafter\n";
        let offset = src.find("- b ^id").unwrap() as u64;
        assert_eq!(extract_block(src, offset), "- a\n- b ^id\n- c\n");
    }

    #[test]
    fn extract_block_returns_empty_when_offset_past_end() {
        assert_eq!(extract_block("short\n", 999), String::new());
    }

    #[test]
    fn strip_frontmatter_present_returns_body() {
        assert_eq!(
            strip_frontmatter("---\ntitle: x\n---\nbody\n"),
            "body\n",
        );
    }

    #[test]
    fn strip_frontmatter_absent_returns_full_source() {
        assert_eq!(strip_frontmatter("plain\n"), "plain\n");
    }

    #[test]
    fn strip_frontmatter_unclosed_returns_full_source() {
        // No closing `---` — treat as not-frontmatter, keep everything.
        assert_eq!(strip_frontmatter("---\nonly opener\n"), "---\nonly opener\n");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p cubical-core vault::embeds::tests -- --nocapture 2>&1 | tail -20`
Expected: 9 of the 10 tests FAIL (the `slugify_collapses_and_lowercases` test passes because `slugify` is real; everything else returns the stubbed defaults).

- [ ] **Step 4: Implement `extract_section`**

Replace the stub in `embeds.rs`:

```rust
pub fn extract_section(source: &str, anchor: &str) -> Option<String> {
    let target = slugify(anchor);
    if target.is_empty() {
        return None;
    }
    let lines: Vec<&str> = source.split_inclusive('\n').collect();
    // Find the matched heading.
    let mut matched: Option<(usize, usize)> = None; // (line_index, level)
    for (i, line) in lines.iter().enumerate() {
        if let Some((level, text)) = parse_atx_heading(line) {
            if slugify(text) == target {
                matched = Some((i, level));
                break;
            }
        }
    }
    let (start_line, level) = matched?;
    // Collect from the line AFTER the heading until next heading with level <= matched.
    let mut end_line = lines.len();
    for (j, line) in lines.iter().enumerate().skip(start_line + 1) {
        if let Some((l, _)) = parse_atx_heading(line) {
            if l <= level {
                end_line = j;
                break;
            }
        }
    }
    let slice: String = lines[start_line + 1..end_line].concat();
    Some(slice)
}

/// `(level, text_after_hashes)` if `line` is an ATX heading, else None.
/// Strips the `#`s + the single required space. Trailing `\n` is kept
/// on `text` because callers don't care — they slugify it.
fn parse_atx_heading(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    // CommonMark requires a space (or end of line) after the hashes.
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }
    Some((hashes, rest.trim_start_matches(' ')))
}
```

- [ ] **Step 5: Implement `extract_block`**

Replace the stub:

```rust
pub fn extract_block(source: &str, byte_offset: u64) -> String {
    let pos = byte_offset as usize;
    if pos >= source.len() {
        return String::new();
    }
    // Find the start of the line containing `pos`.
    let line_start = source[..pos].rfind('\n').map_or(0, |i| i + 1);
    // Walk back over preceding non-blank lines.
    let mut block_start = line_start;
    loop {
        if block_start == 0 {
            break;
        }
        // The previous line ends at block_start - 1 (the '\n'); its
        // start is the byte after the previous '\n' before that.
        let prev_end = block_start - 1; // index of the '\n'
        let prev_start = source[..prev_end].rfind('\n').map_or(0, |i| i + 1);
        let prev_line = &source[prev_start..prev_end];
        if prev_line.trim().is_empty() {
            break;
        }
        block_start = prev_start;
    }
    // Walk forward over the line containing `pos` and following non-blank lines.
    let mut block_end = line_start;
    while block_end < source.len() {
        let line_end_excl = source[block_end..]
            .find('\n')
            .map_or(source.len(), |i| block_end + i + 1);
        let line = &source[block_end..line_end_excl];
        let line_text = line.trim_end_matches(['\r', '\n']);
        if line_text.trim().is_empty() {
            break;
        }
        block_end = line_end_excl;
    }
    source[block_start..block_end].to_string()
}
```

- [ ] **Step 6: Implement `strip_frontmatter`**

Replace the stub:

```rust
pub fn strip_frontmatter(source: &str) -> &str {
    // Accept "---\n" or "---\r\n" as the opener; require a closing
    // "---" on its own line. Anything else → return source unchanged.
    let after_opener = if let Some(rest) = source.strip_prefix("---\n") {
        rest
    } else if let Some(rest) = source.strip_prefix("---\r\n") {
        rest
    } else {
        return source;
    };
    // Find the closing "---" line. Match on "\n---\n", "\n---\r\n",
    // or "\n---" at the very end of file.
    let opener_consumed = source.len() - after_opener.len();
    for (idx, _) in after_opener.match_indices("\n---") {
        let close_start = opener_consumed + idx; // index of the '\n' before "---"
        let after_close_dashes = close_start + "\n---".len();
        if after_close_dashes == source.len() {
            // Closer is the last 3 chars; body is empty.
            return "";
        }
        let next = &source[after_close_dashes..];
        if let Some(rest) = next.strip_prefix('\n') {
            return rest;
        }
        if let Some(rest) = next.strip_prefix("\r\n") {
            return rest;
        }
        // "---" mid-line, not a closer — keep looking.
    }
    source
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cargo test -p cubical-core vault::embeds 2>&1 | tail -15`
Expected: PASS (10 tests). Then `cargo clippy -p cubical-core --all-targets -- -D warnings` + `cargo fmt --all`.

- [ ] **Step 8: Commit**

```bash
git add crates/cubical-core/src/vault/embeds.rs crates/cubical-core/src/vault/mod.rs
git commit -m "feat(core): pure embed extractors — section, block, frontmatter strip"
```

---

### Task 2: Widen visibility of reused helpers

**Files:**
- Modify: `crates/cubical-core/src/vault/links.rs`
- Modify: `crates/cubical-app/src/commands/links.rs`

- [ ] **Step 1: Widen `read_source_off_executor` to `pub`**

In `crates/cubical-core/src/vault/links.rs`, find the line:

```rust
pub(crate) async fn read_source_off_executor(abs_path: &std::path::Path) -> Option<String> {
```

Change to:

```rust
pub async fn read_source_off_executor(abs_path: &std::path::Path) -> Option<String> {
```

- [ ] **Step 2: Widen `split_target_anchor` to `pub(crate)`**

In `crates/cubical-app/src/commands/links.rs:63`, change:

```rust
fn split_target_anchor(target_raw: &str) -> (String, Option<ResolvedAnchor>) {
```

to:

```rust
pub(crate) fn split_target_anchor(target_raw: &str) -> (String, Option<ResolvedAnchor>) {
```

- [ ] **Step 3: Build to verify nothing broke**

Run: `cargo build --workspace 2>&1 | tail -3 && cargo test -p cubical-core --lib links 2>&1 | grep -E "test result" | tail`
Expected: clean build; existing `links` tests still green.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-core/src/vault/links.rs crates/cubical-app/src/commands/links.rs
git commit -m "refactor: widen read_source_off_executor + split_target_anchor for embed reuse"
```

---

### Task 3: Wire types

**Files:**
- Modify: `crates/cubical-app/src/api/types.rs`

- [ ] **Step 1: Append the wire types**

At the end of `crates/cubical-app/src/api/types.rs`, append:

```rust
// -- get_embed (L3 Session H.1) ----------------------------------------

/// Request payload for `get_embed`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetEmbedRequest {
    pub vault_id: String,
    /// Wiki-link target as written (no `[[`/`]]`/`|`). May include a
    /// `#heading` or `#^block-id` anchor.
    pub target_raw: String,
}

/// What kind of embed `get_embed` resolved the target to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EmbedKind {
    /// Full note body (frontmatter stripped).
    Note,
    /// Heading-anchored section.
    Section,
    /// Block-anchored paragraph or list item.
    Block,
    /// Target didn't resolve to any file in the vault.
    Unresolved,
    /// Target resolved, but the named heading / block id wasn't found.
    MissingAnchor,
}

/// Response payload for `get_embed`.
#[derive(Debug, Clone, Serialize)]
pub struct GetEmbedResponse {
    pub kind: EmbedKind,
    /// Resolved vault-relative path. `None` only when kind=Unresolved.
    pub target_path: Option<String>,
    /// Extracted content. `None` when kind is Unresolved or
    /// MissingAnchor.
    pub content: Option<String>,
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cargo build -p cubical-app 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add crates/cubical-app/src/api/types.rs
git commit -m "feat(app): wire types for get_embed (L3 Session H.1)"
```

---

### Task 4: `get_embed` handler

**Files:**
- Create: `crates/cubical-app/src/commands/embeds.rs`
- Modify: `crates/cubical-app/src/commands/mod.rs`

- [ ] **Step 1: Declare the module**

In `crates/cubical-app/src/commands/mod.rs`, add `pub mod embeds;` in alphabetical order with the existing `pub mod blocks; / links; / tags;` lines:

```rust
pub mod autocomplete;
pub mod backlinks;
pub mod blocks;
pub mod embeds;
pub mod links;
pub mod tags;
pub mod vault;
```

- [ ] **Step 2: Write the failing tests + handler skeleton**

Create `crates/cubical-app/src/commands/embeds.rs` with the handler signature returning `MissingAnchor` so the file compiles and tests run (and fail loudly with mismatch messages):

```rust
//! Embed content extractor (L3 Session H.1, spec §9.12). Returns one
//! slice per call — recursion / depth / cycle handling live on the
//! frontend in H.2. The handler is the thin orchestrator; the pure
//! extractors live in `cubical_core::vault::embeds`.

use cubical_core::vault::embeds::{extract_block, extract_section, strip_frontmatter};
use cubical_core::vault::links::{read_source_off_executor, resolve_target};
use cubical_index::blocks_for_file;

use crate::api::types::{EmbedKind, GetEmbedRequest, GetEmbedResponse, ResolvedAnchor};
use crate::commands::links::split_target_anchor;
use crate::error::CubicalError;
use crate::state::AppState;

/// Extract the content to inline for `target_raw`. See spec §9.12.
pub async fn get_embed(
    state: &AppState,
    req: GetEmbedRequest,
) -> Result<GetEmbedResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let vault = open.vault.clone();
    drop(guard);

    // Snapshot files.path for resolution (mirror commands/autocomplete).
    let conn = vault.index().connection();
    let mut rows = conn
        .query("SELECT path FROM files ORDER BY path", ())
        .await?;
    let mut known: Vec<String> = Vec::new();
    while let Some(row) = rows.next().await? {
        known.push(row.get(0)?);
    }

    let (target, anchor) = split_target_anchor(&req.target_raw);
    let Some(target_path) = resolve_target(&target, &known) else {
        return Ok(GetEmbedResponse {
            kind: EmbedKind::Unresolved,
            target_path: None,
            content: None,
        });
    };

    // Read the file off the runtime; unreadable file folds into Unresolved
    // (the watcher will heal on next change — same policy as refresh_blocks).
    let abs = vault.root().join(&target_path);
    let Some(source) = read_source_off_executor(&abs).await else {
        return Ok(GetEmbedResponse {
            kind: EmbedKind::Unresolved,
            target_path: Some(target_path),
            content: None,
        });
    };

    match anchor {
        None => Ok(GetEmbedResponse {
            kind: EmbedKind::Note,
            target_path: Some(target_path),
            content: Some(strip_frontmatter(&source).to_string()),
        }),
        Some(ResolvedAnchor::Heading { value }) => {
            match extract_section(&source, &value) {
                Some(content) => Ok(GetEmbedResponse {
                    kind: EmbedKind::Section,
                    target_path: Some(target_path),
                    content: Some(content),
                }),
                None => Ok(GetEmbedResponse {
                    kind: EmbedKind::MissingAnchor,
                    target_path: Some(target_path),
                    content: None,
                }),
            }
        }
        Some(ResolvedAnchor::Block { value }) => {
            let blocks = blocks_for_file(vault.index(), &target_path).await?;
            match blocks.into_iter().find(|b| b.block_id == value) {
                Some(b) => Ok(GetEmbedResponse {
                    kind: EmbedKind::Block,
                    target_path: Some(target_path),
                    content: Some(extract_block(&source, b.position_hint)),
                }),
                None => Ok(GetEmbedResponse {
                    kind: EmbedKind::MissingAnchor,
                    target_path: Some(target_path),
                    content: None,
                }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AppState, OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use cubical_index::{replace_blocks_for_file, BlockRow};
    use tempfile::tempdir;
    use tokio_util::sync::CancellationToken;

    async fn state_with_vault_at(dir: &std::path::Path, vault_id: &str) -> (Vault, AppState) {
        let vault = Vault::open(dir).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault {
                vault: vault.clone(),
                cancel: CancellationToken::new(),
                scan_status: ScanStatusBackend::Complete,
                watcher: None,
            },
        );
        (vault, state)
    }

    async fn scan(vault: &Vault) {
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx)
            .await
            .expect("scan");
    }

    #[tokio::test]
    async fn get_embed_full_note_strips_frontmatter() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("Daily.md"), "---\nk: v\n---\nbody text\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;

        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "Daily".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, EmbedKind::Note));
        assert_eq!(resp.target_path.as_deref(), Some("Daily.md"));
        assert_eq!(resp.content.as_deref(), Some("body text\n"));
    }

    #[tokio::test]
    async fn get_embed_section_returns_heading_slice() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("Notes.md"),
            "# Intro\nhello\n# Other\nignored\n",
        )
        .unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;

        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "Notes#Intro".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, EmbedKind::Section));
        assert_eq!(resp.content.as_deref(), Some("hello\n"));
    }

    #[tokio::test]
    async fn get_embed_block_returns_paragraph_via_blocks_for_file() {
        let dir = tempdir().unwrap();
        // Block id `xyz` lives on line 2 ("still para ^xyz").
        let src = "para one\nstill para ^xyz\n\nnext\n";
        std::fs::write(dir.path().join("Notes.md"), src).unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;
        // Sanity: the scan should have populated the blocks row already.
        replace_blocks_for_file(
            vault.index(),
            "Notes.md",
            &[BlockRow {
                block_id: "xyz".into(),
                position_hint: src.find("still para").unwrap() as u64,
            }],
        )
        .await
        .expect("seed blocks");

        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "Notes#^xyz".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, EmbedKind::Block));
        assert_eq!(
            resp.content.as_deref(),
            Some("para one\nstill para ^xyz\n"),
        );
    }

    #[tokio::test]
    async fn get_embed_unresolved_target_returns_unresolved() {
        let dir = tempdir().unwrap();
        let (_vault, state) = state_with_vault_at(dir.path(), "v1").await;
        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "ghost".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, EmbedKind::Unresolved));
        assert!(resp.target_path.is_none());
        assert!(resp.content.is_none());
    }

    #[tokio::test]
    async fn get_embed_missing_heading_returns_missing_anchor() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("Notes.md"), "# Real\nbody\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        scan(&vault).await;

        let resp = get_embed(
            &state,
            GetEmbedRequest {
                vault_id: "v1".into(),
                target_raw: "Notes#Ghost".into(),
            },
        )
        .await
        .expect("ok");
        assert!(matches!(resp.kind, EmbedKind::MissingAnchor));
        assert_eq!(resp.target_path.as_deref(), Some("Notes.md"));
        assert!(resp.content.is_none());
    }
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cargo test -p cubical-app commands::embeds 2>&1 | tail -15`
Expected: PASS (5 tests). Then `cargo clippy -p cubical-app --all-targets -- -D warnings` + `cargo fmt --all`.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-app/src/commands/embeds.rs crates/cubical-app/src/commands/mod.rs
git commit -m "feat(app): get_embed handler — routes target → section/block/note slice"
```

---

### Task 5: Tauri shim + registration + IPC binding

**Files:**
- Modify: `crates/cubical-app/src/lib.rs`
- Modify: `ui/src/api/ipc.ts`

- [ ] **Step 1: Import the wire types**

In `crates/cubical-app/src/lib.rs`, extend the `use api::types::{...}` block to add the new types alphabetically (next to other `Get*` types):

```rust
    GetEmbedRequest, GetEmbedResponse,
```

(They land near the existing `GetBacklinksRequest` / `GetCanonicalAstRequest` lines.)

- [ ] **Step 2: Add the shim + registration**

In `crates/cubical-app/src/lib.rs`, add the shim near the other `get_*` shims (e.g. after `get_backlinks`):

```rust
/// Tauri shim — see [`commands::embeds::get_embed`].
#[tauri::command]
async fn get_embed(
    state: tauri::State<'_, AppState>,
    req: GetEmbedRequest,
) -> Result<GetEmbedResponse, CubicalError> {
    commands::embeds::get_embed(state.inner(), req).await
}
```

And register it in `tauri::generate_handler![...]` next to `get_backlinks,`:

```rust
            get_embed,
```

- [ ] **Step 3: Build to verify wiring**

Run: `cargo build -p cubical-app 2>&1 | tail -3`
Expected: clean (the `generate_handler!` macro fails loudly on a missing name or non-Serde type).

- [ ] **Step 4: Add the IPC binding**

In `ui/src/api/ipc.ts`, append (after the existing `getBrokenBlockRefs` binding):

```ts
// ---------------------------------------------------------------------------
// get_embed (L3 Session H.1 — embed content extractor)
// ---------------------------------------------------------------------------

export interface GetEmbedRequest {
  vault_id: string;
  /** Wiki-link target as written (no `[[`/`]]`/`|`). May include
   *  a `#heading` or `#^block-id` anchor. */
  target_raw: string;
}

export type EmbedKind =
  | "note"
  | "section"
  | "block"
  | "unresolved"
  | "missing-anchor";

export interface GetEmbedResponse {
  kind: EmbedKind;
  /** Resolved vault-relative path; null only when kind === "unresolved". */
  target_path: string | null;
  /** Extracted content; null when kind is "unresolved" or "missing-anchor". */
  content: string | null;
}

/** Resolve `target_raw` and return its embedded content slice. */
export function getEmbed(
  req: GetEmbedRequest,
): Promise<GetEmbedResponse> {
  return invoke("get_embed", { req });
}
```

- [ ] **Step 5: Typecheck**

Run: `cd ui && npx tsc --noEmit 2>&1 | tail -3`
Expected: clean (the binding is unused for now — that's fine; the widget arrives in H.2).

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-app/src/lib.rs ui/src/api/ipc.ts
git commit -m "feat: register get_embed Tauri command + IPC binding"
```

---

### Task 6: Verify + docs + finish branch

**Files:**
- Modify: `docs/layer-3-spec.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full gates**

```bash
cargo test --workspace 2>&1 | grep -E "test result: FAILED|^test result: ok" | grep -v "0 passed; 0 failed" | tail
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --all --check
( cd ui && npx tsc --noEmit && npx vitest run && npm run build )
```
Expected: Rust 288 (was 273 + 15 new: 10 extractor + 5 handler) green; clippy clean; fmt clean; vitest 293 unchanged (no UI logic added); build OK. If `runner::tests::schema_too_new_is_rejected` trips, it's a known parallel-run flake — re-run in isolation.

- [ ] **Step 2: Real-app smoke note**

There is no editor surface this session — `get_embed` is reachable only via dev-console invocation. Optional best-effort:

```bash
cargo build -p cubical-app
# then: cargo tauri dev, open the sandbox vault.
#  - Dev console:
#      __TAURI__.core.invoke("get_embed", { req: { vault_id: <id>, target_raw: "Daily" } })
#    Expect { kind: "note", target_path: "Daily.md", content: "<body, sans frontmatter>" }.
#  - Same with "Daily#Intro" → kind: "section".
#  - Same with "Daily#^id" (id minted via Cmd/Ctrl+Shift+B beforehand) → kind: "block".
#  - Same with "ghost" → kind: "unresolved".
```
Otherwise: the extractor + handler tests cover every branch end-to-end — the smoke is purely confirmatory.

- [ ] **Step 3: Update docs + state**

- Append `### 9.12 Session H.1 — Embed content extractor + IPC` to `docs/layer-3-spec.md` (mirror §9.11 style): pure `extract_section` / `extract_block` / `strip_frontmatter` in `cubical-core::vault::embeds`; slug-based heading match; per-line walk to blank-line boundaries for blocks; `get_embed` handler resolving target like `resolve_link`, routing by anchor kind, folding unreadable files into `Unresolved`; `EmbedKind` enum with kebab-case serde rename; IPC binding unused until H.2. Note frontend embed widget is the H.2 follow-up.
- Rewrite the `CLAUDE.md` "Project state" block (do not append): Session H.1 done; update Rust test count (288); vitest unchanged (293); set "Next: **Session H.2 — embed widget** (live-preview block widget consuming `getEmbed`, depth cap, cycle detection, unresolved placeholder)."

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch.

---

## Self-review notes (for the executor)

- **Backend only** — no frontend changes beyond the IPC binding. The binding sits unused; that's intentional (the H.2 widget consumes it). Mirrors the §9.8 Session G backend cadence.
- **Slugify on both sides** — heading matching compares slugified text to slugified anchor. Don't try to special-case raw-text equality; the slugify call subsumes it.
- **Block extraction uses simple blank-line boundaries** — this is correct for the common "paragraph" and "list item" cases. Multi-paragraph blockquote-style blocks aren't a target for v1 (and the spec doesn't demand them).
- **Unreadable file → `Unresolved`** — the embed surface treats "can't read" the same as "doesn't exist." Don't surface filesystem error messages through `get_embed`; the watcher heals on next change (same policy as `refresh_blocks`).
- **No new markdown parser dependency.** The extractors are pure line walks. If the next phase wants real markdown awareness (e.g. setext headings, multi-paragraph blocks), revisit then — not now.
- **`split_target_anchor` reuse** — widening to `pub(crate)` keeps a single anchor-parsing source of truth. Don't duplicate the logic in `commands::embeds`.
- **Out of scope, on purpose:** the embed widget, depth cap, cycle detection, callout styling, rich markdown rendering inside embeds, setext headings, embedded images/audio.
```
