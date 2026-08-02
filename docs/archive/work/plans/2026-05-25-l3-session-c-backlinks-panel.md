> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session C — Backlinks panel + right-sidebar shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the collapsible right-sidebar shell and its first occupant — the Backlinks panel — for the open note. Every note whose `links.target_path` resolves to it appears as one row with a single-line context snippet; the panel refreshes live whenever the link index changes; row clicks reuse the existing file-open flow; the collapsed state persists per-vault.

**Architecture:** A new `get_backlinks` IPC reads the L3 `links` table for rows pointing at `path`, joins each row to a source-file context snippet built by a pure helper, and returns the result. A new dedicated query (`backlinks_for`) surfaces `source_path` (the existing `links_to` returns a shape that omits it; `links_to` has no production callers — only tests — so a new query is cleaner than mutating its return shape). The frontend grows two new files: `RightSidebar.tsx` (collapsible shell, panel-agnostic so Session I can add Unlinked Mentions next to Backlinks) and `sidebar/Backlinks.tsx` (data-bound panel). Live refresh piggybacks on the existing `vault:file-changed` listener with a 200ms debounce (recommended in the session prompt; defer shipping `vault:index-changed` until a second consumer needs it).

**Tech Stack:** Rust (`cubical-index`, `cubical-app`); TypeScript / Solid (`ui/src/RightSidebar.tsx`, `ui/src/sidebar/Backlinks.tsx`, `ui/src/App.tsx`, `ui/src/api/ipc.ts`); Tauri 2 IPC.

---

## Spec references

- [`docs/layer-3-spec.md`](../../../layer-3-spec.md) §1 goal 3, §2.3 (Backlinks panel + right sidebar), §3.1 (`get_backlinks`), §3.5 (`vault:index-changed` — *not* shipped this session), §4 (frontend file map), §5 deviation #4, §8 Session C, §9.1 + §9.2 (what landed in A and B).
- [`docs/architecture/ui.md`](../../../architecture/ui.md) §11.1 (right sidebar in the locked layout), §11.4 (CSS-variable token surface — every new UI surface consumes tokens).
- [`docs/conventions.md`](../../../conventions.md) — `cargo fmt` + `cargo clippy -- -D warnings`, strict TS, no `any`, no `unwrap` outside tests/`main`, Conventional Commits.
- L3 Session A query module ([`crates/cubical-index/src/links.rs`](../../../../crates/cubical-index/src/links.rs)) — `LinkRow`, `replace_links_for_file`, `links_to` (callers: tests only).
- L3 Session A `resolve_link` handler shape ([`crates/cubical-app/src/commands/links.rs`](../../../../crates/cubical-app/src/commands/links.rs)) — mirror its pure-handler structure.
- L3 Session B `App.tsx` navigation flow — `handleSelectFile` / `handleNavigateWikilink` (the seam a row click reuses).

---

## Decisions locked in this plan

1. **Backlinks query shape:** add a new dedicated `backlinks_for(conn, target_path) -> Vec<BacklinkRow>` rather than extending `links_to`. `links_to` has no production callers (only tests), so a clean new shape is cheaper than dragging a tuple through both call sites. `links_to` stays where it is for now.
2. **Snippet heuristic:** width 120 chars, centred on `position`, single-line (every `\n`/`\r` collapsed to a single space), trimmed at word boundaries when possible (prefer breaking on whitespace within 16 chars of either end; otherwise hard-cut). Helper returns the literal block when the source is shorter than the window. Empty when the enclosing block text is empty.
3. **One row per backlink, no grouping** — faithful to the spec's singular "each row showing the source note". Optional grouping is deferred.
4. **Live refresh route:** piggyback on `vault:file-changed` with a 200ms debounce. Cheapest, matches the Session B resolver-cache invalidation. `vault:index-changed` (§3.5) is *not* shipped this session — promote it when a second consumer appears (probably Session I unlinked mentions).
5. **Collapsed-state persistence:** vault-local setting key `ui.right_sidebar_collapsed`, boolean. Extend the `Setting` discriminated union in `ui/src/api/ipc.ts`, mirroring `editor.raw_source_default`.
6. **Sidebar width:** `18rem` (matches the file-list pane's `flex: 0 0 18rem` so the layout reads as balanced). Hardcoded as `"18rem"` in JSX — no new token yet (a resizer would be the reason to mint one, and that's not in this session's scope).
7. **Empty / loading / error states:** the panel renders three terminal text states (empty, loading, error) and the populated list. No skeleton placeholder — a 200ms debounce + a small query keeps load time well under perception threshold.

---

## File structure

**Create (Rust):**

```
crates/cubical-app/src/commands/backlinks.rs       # pure handler + snippet helper + tests
```

**Modify (Rust):**

```
crates/cubical-index/src/links.rs                  # add BacklinkRow + backlinks_for() + tests
crates/cubical-index/src/lib.rs                    # re-export BacklinkRow + backlinks_for
crates/cubical-app/src/api/types.rs                # add GetBacklinksRequest/Response + Backlink
crates/cubical-app/src/commands/mod.rs             # pub mod backlinks
crates/cubical-app/src/lib.rs                      # Tauri shim for get_backlinks
```

**Create (TS):**

```
ui/src/RightSidebar.tsx                            # collapsible shell, panel-agnostic
ui/src/sidebar/Backlinks.tsx                       # data-bound panel
ui/src/sidebar/backlinks.ts                        # pure helpers: format, group-data, state machine
ui/src/sidebar/backlinks.test.ts                   # vitest cases for the pure helpers
```

**Modify (TS):**

```
ui/src/api/ipc.ts                                  # getBacklinks wrapper + extend Setting union
ui/src/App.tsx                                     # render <RightSidebar>, fetch on selection + live refresh
```

**Modify (docs):**

```
docs/layer-3-spec.md                               # fill §9.3 at session close
CLAUDE.md                                          # rewrite Project state at session close
```

**Untouched (explicit non-goals):**

```
crates/cubical-ast/**                              # no AST changes
crates/cubical-core/**                             # no extraction changes
ui/src/editor/**                                   # no editor changes
ui/src/ast/**                                      # no AST normalizer changes
```

---

## Wire shapes (load-bearing)

### Rust — `BacklinkRow` (in `cubical-index`)

```rust
/// One backlink — a `links` row enriched with its source file, used by
/// `get_backlinks`. Distinct from `LinkRow` because the backlinks
/// surface needs `source_path` (which `links_to` omits).
#[derive(Debug, Clone, PartialEq)]
pub struct BacklinkRow {
    pub source_path: String,
    pub target_raw: String,
    pub anchor_kind: Option<String>,
    pub anchor_value: Option<String>,
    pub display_text: Option<String>,
    pub is_embed: bool,
    pub position: u64,
}
```

### Rust — IPC types (in `cubical-app/src/api/types.rs`)

```rust
/// Request payload for `get_backlinks`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetBacklinksRequest {
    pub vault_id: String,
    /// Vault-relative path of the note whose backlinks to list.
    pub path: String,
}

/// Response payload for `get_backlinks`.
#[derive(Debug, Clone, Serialize)]
pub struct GetBacklinksResponse {
    pub backlinks: Vec<Backlink>,
}

/// One backlink as surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct Backlink {
    /// Vault-relative path of the source note that links here.
    pub source_path: String,
    /// Single-line context snippet drawn from the source note. Empty
    /// only when the enclosing block has no readable text.
    pub context: String,
    /// Byte offset of the link's opener within the source note. The
    /// frontend uses this to differentiate two rows with identical
    /// (source_path, context) when sorting / keying.
    pub position: u64,
}
```

### TS — `ipc.ts`

```ts
export interface GetBacklinksRequest {
  vault_id: string;
  path: string;
}

export interface Backlink {
  source_path: string;
  context: string;
  position: number;
}

export interface GetBacklinksResponse {
  backlinks: Backlink[];
}

export function getBacklinks(
  req: GetBacklinksRequest,
): Promise<GetBacklinksResponse> {
  return invoke("get_backlinks", { req });
}

// Setting union extension:
export type Setting =
  | { key: "editor.raw_source_default"; value: boolean }
  | { key: "appearance.theme_mode"; value: "light" | "dark" | "system" }
  | { key: "ui.right_sidebar_collapsed"; value: boolean };
```

---

## Snippet grammar (load-bearing)

`build_snippet(source: &str, position: u64) -> String`:

- Width: 120 chars. Half-window: 60 chars on each side of `position`.
- Clamp the window: `start = position.saturating_sub(60)`, `end = (position + 60).min(source.len())`. Take `&source[start..end]` over **byte** indices; widen each end to the nearest UTF-8 char boundary so we never slice mid-codepoint.
- Replace every `\n` and `\r` with a single space.
- Collapse runs of whitespace into a single space.
- Trim leading/trailing whitespace.
- Word-boundary polish: if `start > 0` and the snippet's first 16 chars contain a space, drop everything up to and including that first space (so the snippet starts on a word boundary), then re-prefix `"…"`. Same on the trailing edge: if `end < source.len()` and the last 16 chars contain a space, drop everything from that last space onward, then append `"…"`.
- Empty source → empty string. Source shorter than 120 chars → no ellipses on the edges that touch the source boundary.

This is testable in isolation — `tests` in the same module cover near-start, near-end, multi-line collapse, ellipses behaviour, UTF-8 safety.

---

## Task 1: `BacklinkRow` + `backlinks_for` query

**Files:**
- Modify: `crates/cubical-index/src/links.rs`
- Modify: `crates/cubical-index/src/lib.rs`

- [ ] **Step 1: Write the failing query test** in `crates/cubical-index/src/links.rs` (append inside the existing `#[cfg(test)] mod tests`):

```rust
#[tokio::test]
async fn backlinks_for_returns_source_path_and_orders_per_file() {
    let (_dir, conn) = open_test_index().await;
    seed_file(&conn, "a.md").await;
    seed_file(&conn, "b.md").await;
    seed_file(&conn, "target.md").await;

    // Two links from b.md, ordered by position; one link from a.md.
    let mut a_row = row("Target", Some("target.md"));
    a_row.position = 50;
    let mut b_row_1 = row("Target", Some("target.md"));
    b_row_1.position = 200;
    let mut b_row_2 = row("Target", Some("target.md"));
    b_row_2.position = 10;

    replace_links_for_file(&conn, "a.md", &[a_row]).await.unwrap();
    replace_links_for_file(&conn, "b.md", &[b_row_2, b_row_1]).await.unwrap();

    let got = backlinks_for(&conn, "target.md").await.expect("backlinks");
    assert_eq!(got.len(), 3);
    // Sorted by (source_path, position) — a.md first, then b.md's
    // two rows in ascending position order.
    assert_eq!(got[0].source_path, "a.md");
    assert_eq!(got[0].position, 50);
    assert_eq!(got[1].source_path, "b.md");
    assert_eq!(got[1].position, 10);
    assert_eq!(got[2].source_path, "b.md");
    assert_eq!(got[2].position, 200);
}

#[tokio::test]
async fn backlinks_for_returns_empty_when_no_links_point_here() {
    let (_dir, conn) = open_test_index().await;
    seed_file(&conn, "lonely.md").await;
    let got = backlinks_for(&conn, "lonely.md").await.expect("ok");
    assert!(got.is_empty());
}
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `cargo test -p cubical-index backlinks_for`
Expected: FAIL — `backlinks_for` does not exist, and `BacklinkRow` does not exist.

- [ ] **Step 3: Add `BacklinkRow` and `backlinks_for` to `crates/cubical-index/src/links.rs`.**

Append (after the existing `links_to` function, before `fn row_to_link`):

```rust
/// Backlinks row — a `links` row enriched with `source_path`, the
/// shape `get_backlinks` returns to the frontend. Distinct from
/// [`LinkRow`] because backlinks need the *source* file, not just the
/// columns `LinkRow` carries.
///
/// See `docs/layer-3-spec.md` §2.3.
#[derive(Debug, Clone, PartialEq)]
pub struct BacklinkRow {
    /// Vault-relative path of the file that contains the link.
    pub source_path: String,
    /// The wiki-link target as written, with anchor stripped.
    pub target_raw: String,
    /// `"heading"` or `"block"`, or `None`.
    pub anchor_kind: Option<String>,
    /// Heading text or block id, or `None`.
    pub anchor_value: Option<String>,
    /// The optional `|display` text.
    pub display_text: Option<String>,
    /// `true` when the link was written `![[…]]`.
    pub is_embed: bool,
    /// Byte offset of the link's opener within `source_path`.
    pub position: u64,
}

/// All backlinks pointing at `target_path`, ordered by
/// `(source_path, position)` so per-file grouping is stable.
pub async fn backlinks_for(
    conn: &IndexConn,
    target_path: &str,
) -> Result<Vec<BacklinkRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT source_path, target_raw, anchor_kind, anchor_value, \
                    display_text, is_embed, position \
             FROM links WHERE target_path = ?1 \
             ORDER BY source_path, position",
            params![target_path],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let is_embed_int: i64 = row.get(5)?;
        let position_int: i64 = row.get(6)?;
        out.push(BacklinkRow {
            source_path: row.get(0)?,
            target_raw: row.get(1)?,
            anchor_kind: row.get(2)?,
            anchor_value: row.get(3)?,
            display_text: row.get(4)?,
            is_embed: is_embed_int != 0,
            position: position_int.try_into().unwrap_or(0),
        });
    }
    Ok(out)
}
```

- [ ] **Step 4: Re-export from `crates/cubical-index/src/lib.rs`.**

Find the existing line that re-exports from `links::` and extend it. Check current shape with:

```bash
grep -n "links::" crates/cubical-index/src/lib.rs
```

Add `BacklinkRow` and `backlinks_for` to the existing `pub use crate::links::{ … };` group (or add a new `pub use` line if there isn't one yet). Final form should be (adjust to match existing style):

```rust
pub use crate::links::{
    backlinks_for, links_from, links_to, replace_links_for_file, BacklinkRow, LinkRow,
};
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `cargo test -p cubical-index backlinks_for`
Expected: PASS — both new tests green.

- [ ] **Step 6: Run the full index suite to confirm no regressions.**

Run: `cargo test -p cubical-index`
Expected: PASS — all prior link/index tests + 2 new ones.

- [ ] **Step 7: Commit.**

```bash
git add crates/cubical-index/src/links.rs crates/cubical-index/src/lib.rs
git commit -m "feat(index): add backlinks_for query with source_path"
```

---

## Task 2: IPC types — `GetBacklinksRequest` / `Response` / `Backlink`

**Files:**
- Modify: `crates/cubical-app/src/api/types.rs`

- [ ] **Step 1: Append the new types to `crates/cubical-app/src/api/types.rs`** (after the `ResolvedAnchor` enum, before the `// -- close_vault` section):

```rust
// -- get_backlinks -------------------------------------------------------

/// Request payload for `get_backlinks`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetBacklinksRequest {
    /// Vault whose link index to query.
    pub vault_id: String,
    /// Vault-relative path of the note whose backlinks to list. The
    /// handler matches `links.target_path` against this string.
    pub path: String,
}

/// Response payload for `get_backlinks`.
#[derive(Debug, Clone, Serialize)]
pub struct GetBacklinksResponse {
    /// Backlinks in `(source_path, position)` order. Empty when no
    /// note links at `path`.
    pub backlinks: Vec<Backlink>,
}

/// One backlink row surfaced to the frontend.
///
/// `context` is a single-line snippet (~120 chars) drawn from the
/// source file's text around `position`. Empty only when the
/// enclosing block has no readable text.
#[derive(Debug, Clone, Serialize)]
pub struct Backlink {
    /// Vault-relative path of the source note that links here.
    pub source_path: String,
    /// Single-line context snippet, ~120 chars centred on `position`.
    pub context: String,
    /// Byte offset of the link's opener within `source_path`. Used by
    /// the frontend as a stable key/sort tiebreaker.
    pub position: u64,
}
```

- [ ] **Step 2: Confirm it compiles (a no-op shim until Task 4 wires it).**

Run: `cargo check -p cubical-app`
Expected: PASS — types compile.

- [ ] **Step 3: Commit.**

```bash
git add crates/cubical-app/src/api/types.rs
git commit -m "feat(app): add GetBacklinks request/response types"
```

---

## Task 3: Snippet helper

**Files:**
- Create: `crates/cubical-app/src/commands/backlinks.rs`
- Modify: `crates/cubical-app/src/commands/mod.rs`

- [ ] **Step 1: Create `crates/cubical-app/src/commands/backlinks.rs` with the snippet helper skeleton (no handler yet) and its test module.** The full content of the file at this step:

```rust
//! Pure async command handler for `get_backlinks`.
//!
//! Reads `links` rows pointing at the target path, joins each row to
//! a short single-line snippet drawn from the source file's text, and
//! returns the result. The snippet helper is a pure function tested
//! in isolation; the handler itself is the only piece that touches
//! disk + libSQL.
//!
//! See `docs/layer-3-spec.md` §2.3 and §3.1.

/// Build a single-line context snippet around `position` in `source`.
///
/// Width is 120 bytes, centred on `position`. Newlines collapse to
/// spaces; runs of whitespace collapse to a single space; word
/// boundaries are preferred for trimming. UTF-8 boundaries are
/// respected — the helper never slices mid-codepoint.
///
/// Returns the empty string when `source` has no readable text.
pub fn build_snippet(source: &str, position: u64) -> String {
    const WIDTH: usize = 120;
    const HALF: usize = WIDTH / 2;
    const WORD_LOOKAHEAD: usize = 16;

    if source.is_empty() {
        return String::new();
    }

    let len = source.len();
    let pos = (position as usize).min(len);
    let raw_start = pos.saturating_sub(HALF);
    let raw_end = (pos + HALF).min(len);

    // Widen each end to a UTF-8 char boundary so the slice is safe.
    let start = char_boundary_floor(source, raw_start);
    let end = char_boundary_ceil(source, raw_end);

    let mut window: String = source[start..end].to_string();

    // Newline/CR → space.
    window = window.replace(['\n', '\r'], " ");

    // Collapse runs of whitespace.
    let mut collapsed = String::with_capacity(window.len());
    let mut prev_space = false;
    for ch in window.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                collapsed.push(' ');
            }
            prev_space = true;
        } else {
            collapsed.push(ch);
            prev_space = false;
        }
    }
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut snippet = trimmed.to_string();

    // Word-boundary polish on the leading edge.
    if start > 0 {
        let head: String = snippet.chars().take(WORD_LOOKAHEAD).collect();
        if let Some(space_idx) = head.find(' ') {
            // Drop everything up to and including the first space in
            // the head window.
            let drop_to = space_idx + 1;
            snippet = format!("…{}", &snippet[drop_to..]);
        } else {
            snippet = format!("…{snippet}");
        }
    }
    // Word-boundary polish on the trailing edge.
    if end < len {
        let snippet_len = snippet.len();
        let tail_start = snippet_len.saturating_sub(WORD_LOOKAHEAD);
        let tail = &snippet[tail_start..];
        if let Some(space_idx) = tail.rfind(' ') {
            let cut = tail_start + space_idx;
            snippet = format!("{}…", &snippet[..cut]);
        } else {
            snippet = format!("{snippet}…");
        }
    }
    snippet
}

fn char_boundary_floor(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn char_boundary_ceil(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_source_returns_empty() {
        assert_eq!(build_snippet("", 0), "");
    }

    #[test]
    fn short_source_returns_full_text_no_ellipses() {
        let s = "hello world";
        let got = build_snippet(s, 5);
        assert_eq!(got, "hello world");
    }

    #[test]
    fn near_start_no_leading_ellipsis() {
        let mut s = String::from("Lead text ");
        s.push_str(&"x".repeat(200));
        let got = build_snippet(&s, 0);
        assert!(got.starts_with("Lead text"), "got: {got}");
        assert!(got.ends_with('…'), "got: {got}");
    }

    #[test]
    fn near_end_no_trailing_ellipsis() {
        let mut s = String::from(&"x".repeat(200));
        s.push_str(" trailing words");
        let pos = (s.len() - 5) as u64;
        let got = build_snippet(&s, pos);
        assert!(got.starts_with('…'), "got: {got}");
        assert!(got.ends_with("trailing words"), "got: {got}");
    }

    #[test]
    fn middle_position_has_both_ellipses() {
        let s = "a".repeat(200) + " word " + &"b".repeat(200);
        let pos = 200u64; // inside the word
        let got = build_snippet(&s, pos);
        assert!(got.starts_with('…') && got.ends_with('…'), "got: {got}");
    }

    #[test]
    fn newlines_collapse_to_single_spaces() {
        let s = "alpha\n\nbeta\r\ngamma";
        let got = build_snippet(s, 0);
        assert!(!got.contains('\n'));
        assert!(!got.contains('\r'));
        assert_eq!(got, "alpha beta gamma");
    }

    #[test]
    fn runs_of_whitespace_collapse() {
        let s = "alpha    beta\t\t  gamma";
        let got = build_snippet(s, 0);
        assert_eq!(got, "alpha beta gamma");
    }

    #[test]
    fn utf8_does_not_panic_at_boundary() {
        // 'é' is two bytes — make the half-window land mid-char.
        let s = "héllo wörld ".repeat(30);
        // Pick a position guaranteed to land near a multibyte char.
        let _ = build_snippet(&s, 61);
    }

    #[test]
    fn position_beyond_source_clamps_to_end() {
        let s = "short text";
        let got = build_snippet(s, 9_999);
        assert_eq!(got, "short text");
    }
}
```

- [ ] **Step 2: Register the new module in `crates/cubical-app/src/commands/mod.rs`.**

Replace the existing module list with:

```rust
pub mod backlinks;
pub mod links;
pub mod vault;
```

- [ ] **Step 3: Run the snippet helper tests.**

Run: `cargo test -p cubical-app commands::backlinks::tests`
Expected: PASS — all 9 snippet helper tests green.

- [ ] **Step 4: Commit.**

```bash
git add crates/cubical-app/src/commands/backlinks.rs crates/cubical-app/src/commands/mod.rs
git commit -m "feat(app): add build_snippet pure helper for backlink context"
```

---

## Task 4: `get_backlinks` pure handler

**Files:**
- Modify: `crates/cubical-app/src/commands/backlinks.rs`

- [ ] **Step 1: Append the failing handler tests** at the bottom of `crates/cubical-app/src/commands/backlinks.rs`'s `tests` module (inside the existing `mod tests { … }` block, after `position_beyond_source_clamps_to_end`):

```rust
    // -- End-to-end get_backlinks tests ---------------------------------

    use crate::api::types::GetBacklinksRequest;
    use crate::error::CubicalError;
    use crate::state::{AppState, OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use cubical_index::{replace_links_for_file, LinkRow};
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    async fn fresh_state_with_vault(vault_id: &str) -> (TempDir, Vault, AppState) {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
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
        (dir, vault, state)
    }

    /// Write a markdown file under the vault root *and* seed its
    /// `files` row. The handler reads the file from disk for the
    /// snippet, so both halves must exist.
    async fn seed_md(vault: &Vault, rel: &str, body: &str) {
        let abs = vault.root().join(rel);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(&abs, body).expect("write");
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                ) VALUES (?1, 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                libsql::params![rel],
            )
            .await
            .expect("seed files row");
    }

    fn link_at(target_raw: &str, target_path: &str, position: u64) -> LinkRow {
        LinkRow {
            target_raw: target_raw.into(),
            target_path: Some(target_path.into()),
            anchor_kind: None,
            anchor_value: None,
            display_text: None,
            is_embed: false,
            position,
        }
    }

    #[tokio::test]
    async fn get_backlinks_returns_empty_when_no_links_point_here() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_md(&vault, "lonely.md", "no links here").await;

        let resp = get_backlinks(
            &state,
            GetBacklinksRequest {
                vault_id: "v1".into(),
                path: "lonely.md".into(),
            },
        )
        .await
        .expect("ok");
        assert!(resp.backlinks.is_empty());
    }

    #[tokio::test]
    async fn get_backlinks_returns_one_row_per_link_with_snippet() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_md(
            &vault,
            "source.md",
            "Some preamble before the link [[target]] and trailing text.",
        )
        .await;
        seed_md(&vault, "target.md", "body").await;

        let conn = vault.index();
        let pos = "Some preamble before the link ".len() as u64;
        replace_links_for_file(conn, "source.md", &[link_at("target", "target.md", pos)])
            .await
            .expect("seed links");

        let resp = get_backlinks(
            &state,
            GetBacklinksRequest {
                vault_id: "v1".into(),
                path: "target.md".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.backlinks.len(), 1);
        let b = &resp.backlinks[0];
        assert_eq!(b.source_path, "source.md");
        assert_eq!(b.position, pos);
        assert!(b.context.contains("link"), "context: {}", b.context);
        assert!(!b.context.contains('\n'));
    }

    #[tokio::test]
    async fn get_backlinks_lists_multiple_sources_ordered() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_md(&vault, "a.md", "first link [[target]] here").await;
        seed_md(&vault, "b.md", "[[target]] at start").await;
        seed_md(&vault, "target.md", "body").await;

        let conn = vault.index();
        replace_links_for_file(conn, "a.md", &[link_at("target", "target.md", 11)])
            .await
            .expect("a");
        replace_links_for_file(conn, "b.md", &[link_at("target", "target.md", 0)])
            .await
            .expect("b");

        let resp = get_backlinks(
            &state,
            GetBacklinksRequest {
                vault_id: "v1".into(),
                path: "target.md".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.backlinks.len(), 2);
        assert_eq!(resp.backlinks[0].source_path, "a.md");
        assert_eq!(resp.backlinks[1].source_path, "b.md");
    }

    #[tokio::test]
    async fn get_backlinks_missing_source_file_returns_empty_context_not_error() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        // Seed the index row but NOT the disk file — simulates a
        // file deleted between extraction and the panel query.
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                ) VALUES ('ghost.md', 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                (),
            )
            .await
            .expect("seed ghost row");
        seed_md(&vault, "target.md", "body").await;

        let conn = vault.index();
        replace_links_for_file(conn, "ghost.md", &[link_at("target", "target.md", 0)])
            .await
            .expect("links");

        let resp = get_backlinks(
            &state,
            GetBacklinksRequest {
                vault_id: "v1".into(),
                path: "target.md".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.backlinks.len(), 1);
        assert_eq!(resp.backlinks[0].source_path, "ghost.md");
        assert_eq!(resp.backlinks[0].context, "");
    }

    #[tokio::test]
    async fn get_backlinks_unknown_vault_errors() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = get_backlinks(
            &state,
            GetBacklinksRequest {
                vault_id: "ghost".into(),
                path: "anything".into(),
            },
        )
        .await
        .expect_err("vault-not-open");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }
```

- [ ] **Step 2: Run the new tests to confirm they fail with "function not defined".**

Run: `cargo test -p cubical-app commands::backlinks::tests::get_backlinks`
Expected: FAIL — `get_backlinks` function does not exist.

- [ ] **Step 3: Add the `get_backlinks` handler** in `crates/cubical-app/src/commands/backlinks.rs`. Insert before the `#[cfg(test)] mod tests {` block:

```rust
use cubical_index::backlinks_for;

use crate::api::types::{Backlink, GetBacklinksRequest, GetBacklinksResponse};
use crate::error::CubicalError;
use crate::state::AppState;

/// List every backlink for `path` — every link row whose
/// `target_path` resolves to it — with a single-line context snippet
/// drawn from each source file.
///
/// Errors only when the vault is not open. A source file that has
/// gone missing on disk (e.g. deleted between extraction and the
/// query) yields an empty `context`; the row still appears so the
/// panel surfaces the stale link.
pub async fn get_backlinks(
    state: &AppState,
    req: GetBacklinksRequest,
) -> Result<GetBacklinksResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let rows = backlinks_for(open.vault.index(), &req.path).await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let abs = open.vault.root().join(&row.source_path);
        let context = match std::fs::read_to_string(&abs) {
            Ok(text) => build_snippet(&text, row.position),
            Err(e) => {
                tracing::debug!(
                    path = %row.source_path,
                    error = %e,
                    "get_backlinks: source read failed; snippet will be empty",
                );
                String::new()
            }
        };
        out.push(Backlink {
            source_path: row.source_path,
            context,
            position: row.position,
        });
    }

    Ok(GetBacklinksResponse { backlinks: out })
}
```

- [ ] **Step 4: Run the new tests to verify they pass.**

Run: `cargo test -p cubical-app commands::backlinks::tests`
Expected: PASS — all snippet helper tests + 5 new handler tests green.

- [ ] **Step 5: Run the full app suite to confirm no regressions.**

Run: `cargo test -p cubical-app`
Expected: PASS — all prior tests + 14 new ones (9 snippet + 5 handler).

- [ ] **Step 6: Commit.**

```bash
git add crates/cubical-app/src/commands/backlinks.rs
git commit -m "feat(app): add get_backlinks pure handler"
```

---

## Task 5: Tauri shim for `get_backlinks`

**Files:**
- Modify: `crates/cubical-app/src/lib.rs`

- [ ] **Step 1: Extend the imports** at the top of `crates/cubical-app/src/lib.rs`. Find the `use api::types::{ … };` block and add the three new types — final form:

```rust
use api::types::{
    CancelVaultScanRequest, CloseVaultRequest, GetBacklinksRequest, GetBacklinksResponse,
    GetCanonicalAstRequest, GetCanonicalAstResponse, GetFrontmatterRequest, GetFrontmatterResponse,
    GetSettingRequest, GetSettingResponse, GetVaultInfoRequest, GetVaultInfoResponse,
    ListFilesRequest, ListFilesResponse, OpenVaultRequest, OpenVaultResponse, ReadFileTextRequest,
    ReadFileTextResponse, ResolveLinkRequest, ResolveLinkResponse, SetSettingRequest,
    SetSettingResponse, WriteFileTextRequest, WriteFileTextResponse,
};
```

- [ ] **Step 2: Add `get_backlinks` to the `invoke_handler!` registration list.** Insert below the existing `resolve_link,` line:

```rust
            resolve_link,
            get_backlinks,
            close_vault,
```

- [ ] **Step 3: Add the Tauri shim** at the end of the file, after the `resolve_link` shim:

```rust
/// Tauri shim — see [`commands::backlinks::get_backlinks`].
#[tauri::command]
async fn get_backlinks(
    state: tauri::State<'_, AppState>,
    req: GetBacklinksRequest,
) -> Result<GetBacklinksResponse, CubicalError> {
    commands::backlinks::get_backlinks(state.inner(), req).await
}
```

- [ ] **Step 4: Verify the workspace compiles.**

Run: `cargo build --workspace`
Expected: PASS — clean build.

- [ ] **Step 5: Run clippy with warnings-as-errors.**

Run: `cargo clippy --workspace --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Run `cargo fmt --check`.**

Run: `cargo fmt --check`
Expected: clean.

- [ ] **Step 7: Commit.**

```bash
git add crates/cubical-app/src/lib.rs
git commit -m "feat(ipc): wire get_backlinks Tauri command"
```

---

## Task 6: TS IPC wrapper + extend Setting union

**Files:**
- Modify: `ui/src/api/ipc.ts`

- [ ] **Step 1: Add the wire types and wrapper.** Insert after the `ResolveLinkResponse` interface and before the `Setting` union (around line 159):

```ts
// ---------------------------------------------------------------------------
// get_backlinks (L3 Session C)
// ---------------------------------------------------------------------------

export interface GetBacklinksRequest {
  vault_id: string;
  /** Vault-relative path of the note whose backlinks to list. */
  path: string;
}

/** One backlink as surfaced to the frontend. */
export interface Backlink {
  /** Vault-relative path of the source note that links here. */
  source_path: string;
  /** Single-line context snippet (~120 chars). Empty when the source
   *  file is unreadable or its enclosing block has no text. */
  context: string;
  /** Byte offset of the link's opener within `source_path`. */
  position: number;
}

export interface GetBacklinksResponse {
  backlinks: Backlink[];
}
```

- [ ] **Step 2: Extend the `Setting` discriminated union** with the new key. Replace the existing union with:

```ts
export type Setting =
  | { key: "editor.raw_source_default"; value: boolean }
  | { key: "appearance.theme_mode"; value: "light" | "dark" | "system" }
  | { key: "ui.right_sidebar_collapsed"; value: boolean };
```

- [ ] **Step 3: Add the `getBacklinks` function.** Insert after the existing `resolveLink` function (around line 277):

```ts
/**
 * List every backlink for `path` — every note that links here, with
 * a single-line context snippet drawn from the source. Backlinks are
 * ordered `(source_path, position)`. Empty list when nothing links.
 */
export function getBacklinks(
  req: GetBacklinksRequest,
): Promise<GetBacklinksResponse> {
  return invoke("get_backlinks", { req });
}
```

- [ ] **Step 4: Run the typechecker.**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/api/ipc.ts
git commit -m "feat(ipc): add getBacklinks wrapper + ui.right_sidebar_collapsed setting"
```

---

## Task 7: Pure helpers for the Backlinks panel

**Files:**
- Create: `ui/src/sidebar/backlinks.ts`
- Create: `ui/src/sidebar/backlinks.test.ts`

The Solid panel will be a thin reactive shell around these pure helpers. Keeping the logic in plain TS lets us unit-test it without a render harness (consistent with the rest of the codebase — see `ui/src/properties/coerce.ts` for the pattern).

- [ ] **Step 1: Write the failing helper tests** in `ui/src/sidebar/backlinks.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Backlink } from "../api/ipc";
import {
  backlinkKey,
  basenameWithoutExtension,
  type BacklinksViewState,
  reduceBacklinksState,
} from "./backlinks";

const sample: Backlink = {
  source_path: "notes/foo.md",
  context: "leading text [[Target]] trailing text",
  position: 13,
};

describe("backlinkKey", () => {
  it("combines source path and position", () => {
    expect(backlinkKey(sample)).toBe("notes/foo.md@13");
  });

  it("distinguishes two links from the same file", () => {
    const a: Backlink = { ...sample, position: 10 };
    const b: Backlink = { ...sample, position: 20 };
    expect(backlinkKey(a)).not.toBe(backlinkKey(b));
  });
});

describe("basenameWithoutExtension", () => {
  it("strips directory and .md extension", () => {
    expect(basenameWithoutExtension("notes/sub/Foo.md")).toBe("Foo");
  });

  it("returns bare name unchanged when no path or extension", () => {
    expect(basenameWithoutExtension("Foo")).toBe("Foo");
  });

  it("preserves dots inside the basename", () => {
    expect(basenameWithoutExtension("v1.2.notes.md")).toBe("v1.2.notes");
  });

  it("handles a trailing slash gracefully", () => {
    expect(basenameWithoutExtension("notes/")).toBe("");
  });
});

describe("reduceBacklinksState", () => {
  const idle: BacklinksViewState = { kind: "idle" };

  it("starts loading on fetch:start", () => {
    const next = reduceBacklinksState(idle, { type: "fetch:start" });
    expect(next).toEqual({ kind: "loading" });
  });

  it("captures empty result as 'empty'", () => {
    const next = reduceBacklinksState(
      { kind: "loading" },
      { type: "fetch:success", backlinks: [] },
    );
    expect(next).toEqual({ kind: "empty" });
  });

  it("captures non-empty result as 'loaded'", () => {
    const next = reduceBacklinksState(
      { kind: "loading" },
      { type: "fetch:success", backlinks: [sample] },
    );
    expect(next).toEqual({ kind: "loaded", backlinks: [sample] });
  });

  it("captures errors", () => {
    const next = reduceBacklinksState(
      { kind: "loading" },
      { type: "fetch:error", message: "boom" },
    );
    expect(next).toEqual({ kind: "error", message: "boom" });
  });

  it("returns to idle when the open file is cleared", () => {
    const next = reduceBacklinksState(
      { kind: "loaded", backlinks: [sample] },
      { type: "file:cleared" },
    );
    expect(next).toEqual({ kind: "idle" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `cd ui && npx vitest run src/sidebar/backlinks.test.ts`
Expected: FAIL — `backlinks.ts` does not exist.

- [ ] **Step 3: Create `ui/src/sidebar/backlinks.ts`** with the helpers:

```ts
/**
 * Pure helpers for the L3 Session C Backlinks panel.
 *
 * The Solid component is a thin shell around these — keeping the
 * data-shape logic out of JSX lets us unit-test it without a render
 * harness, consistent with the rest of the UI codebase (see
 * `properties/coerce.ts` and `properties/inferType.ts`).
 */

import type { Backlink } from "../api/ipc";

/**
 * Stable key for a backlink row. `source_path` alone is ambiguous
 * when one source file contains multiple links to the same target;
 * combine with `position` for a tiebreaker.
 */
export function backlinkKey(b: Backlink): string {
  return `${b.source_path}@${b.position}`;
}

/**
 * Display name for a source-file row: basename minus the `.md`
 * extension. Falls back to the empty string for a trailing-slash
 * input (which should not happen in practice, but we don't want to
 * crash if it does).
 */
export function basenameWithoutExtension(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  if (base.endsWith(".md")) return base.slice(0, -3);
  return base;
}

/**
 * View-state machine for the panel. `idle` is the no-file-open state;
 * `loading` is between fetch start and the first response for the
 * current file. `empty` / `loaded` / `error` are the terminal states
 * for one fetch.
 */
export type BacklinksViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; backlinks: Backlink[] }
  | { kind: "error"; message: string };

export type BacklinksAction =
  | { type: "fetch:start" }
  | { type: "fetch:success"; backlinks: Backlink[] }
  | { type: "fetch:error"; message: string }
  | { type: "file:cleared" };

export function reduceBacklinksState(
  state: BacklinksViewState,
  action: BacklinksAction,
): BacklinksViewState {
  switch (action.type) {
    case "fetch:start":
      return { kind: "loading" };
    case "fetch:success":
      return action.backlinks.length === 0
        ? { kind: "empty" }
        : { kind: "loaded", backlinks: action.backlinks };
    case "fetch:error":
      return { kind: "error", message: action.message };
    case "file:cleared":
      return { kind: "idle" };
    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cd ui && npx vitest run src/sidebar/backlinks.test.ts`
Expected: PASS — all 13 tests green.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/sidebar/backlinks.ts ui/src/sidebar/backlinks.test.ts
git commit -m "feat(ui): add pure helpers + state machine for backlinks panel"
```

---

## Task 8: `Backlinks.tsx` panel component

**Files:**
- Create: `ui/src/sidebar/Backlinks.tsx`

- [ ] **Step 1: Create `ui/src/sidebar/Backlinks.tsx`** with the panel:

```tsx
import { createEffect, createSignal, For, Show, type Component } from "solid-js";

import { getBacklinks, type Backlink } from "../api/ipc";
import {
  backlinkKey,
  basenameWithoutExtension,
  reduceBacklinksState,
  type BacklinksViewState,
} from "./backlinks";

/**
 * Props for the Backlinks panel.
 *
 * `vaultId` + `path` drive the fetch. `refreshSignal` is a tick the
 * parent increments to force a refetch (used by the
 * `vault:file-changed` debounce in `App.tsx`). `onRowClick` reuses
 * the parent's existing file-open flow.
 */
export interface BacklinksProps {
  vaultId: string | null;
  path: string | null;
  refreshSignal: number;
  onRowClick: (path: string) => void;
}

const Backlinks: Component<BacklinksProps> = (props) => {
  const [state, setState] = createSignal<BacklinksViewState>({ kind: "idle" });

  // Refetch whenever vault, path, or the refresh signal changes.
  // We capture the in-flight token in a closure so a late response
  // from a previous fetch never overwrites a newer one's state.
  let token = 0;
  createEffect(() => {
    const vid = props.vaultId;
    const p = props.path;
    // Read so the effect tracks it; value itself is unused.
    void props.refreshSignal;

    if (!vid || !p) {
      setState(reduceBacklinksState(state(), { type: "file:cleared" }));
      return;
    }

    const my = ++token;
    setState(reduceBacklinksState(state(), { type: "fetch:start" }));
    getBacklinks({ vault_id: vid, path: p })
      .then((resp) => {
        if (my !== token) return;
        setState(
          reduceBacklinksState(state(), {
            type: "fetch:success",
            backlinks: resp.backlinks,
          }),
        );
      })
      .catch((e: unknown) => {
        if (my !== token) return;
        const message =
          typeof e === "object" && e !== null && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
        setState(reduceBacklinksState(state(), { type: "fetch:error", message }));
      });
  });

  return (
    <section
      aria-label="Backlinks"
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        "min-height": 0,
        flex: 1,
        "overflow-y": "auto",
      }}
    >
      <header
        style={{
          color: "var(--c-fg-secondary)",
          "font-size": "var(--text-xs)",
          "font-family": "var(--font-body)",
          "text-transform": "uppercase",
          "letter-spacing": "0.05em",
        }}
      >
        Backlinks
      </header>
      <Show
        when={state().kind !== "idle"}
        fallback={
          <p
            style={{
              margin: 0,
              color: "var(--c-fg-muted)",
              "font-size": "var(--text-xs)",
            }}
          >
            Select a note to see its backlinks.
          </p>
        }
      >
        <Show when={state().kind === "loading"}>
          <p
            style={{
              margin: 0,
              color: "var(--c-fg-muted)",
              "font-size": "var(--text-xs)",
            }}
          >
            Loading…
          </p>
        </Show>
        <Show when={state().kind === "empty"}>
          <p
            style={{
              margin: 0,
              color: "var(--c-fg-muted)",
              "font-size": "var(--text-xs)",
            }}
          >
            No backlinks yet.
          </p>
        </Show>
        <Show when={state().kind === "error"}>
          {(_) => {
            const s = state();
            if (s.kind !== "error") return null;
            return (
              <p
                role="alert"
                style={{
                  margin: 0,
                  color: "var(--c-error)",
                  "font-size": "var(--text-xs)",
                }}
              >
                {s.message}
              </p>
            );
          }}
        </Show>
        <Show when={state().kind === "loaded"}>
          {(_) => {
            const s = state();
            if (s.kind !== "loaded") return null;
            return (
              <ul
                role="list"
                style={{
                  margin: 0,
                  padding: 0,
                  "list-style": "none",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "var(--space-2)",
                }}
              >
                <For each={s.backlinks}>
                  {(b: Backlink) => (
                    <li
                      role="listitem"
                      onClick={() => props.onRowClick(b.source_path)}
                      data-key={backlinkKey(b)}
                      style={{
                        display: "flex",
                        "flex-direction": "column",
                        gap: "var(--space-1)",
                        padding: "var(--space-2) var(--space-3)",
                        border: "1px solid var(--c-border-subtle)",
                        "border-radius": "var(--radius-sm, var(--radius-md))",
                        background: "var(--c-bg-secondary)",
                        cursor: "pointer",
                        transition: "background var(--transition-fast)",
                      }}
                      title={b.source_path}
                    >
                      <span
                        style={{
                          "font-size": "var(--text-sm)",
                          "font-family": "var(--font-body)",
                          color: "var(--c-fg-primary)",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {basenameWithoutExtension(b.source_path)}
                      </span>
                      <span
                        style={{
                          "font-size": "var(--text-xs)",
                          "font-family": "var(--font-mono)",
                          color: "var(--c-fg-secondary)",
                          "line-height": "var(--leading-base)",
                        }}
                      >
                        {b.context || "—"}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            );
          }}
        </Show>
      </Show>
    </section>
  );
};

export default Backlinks;
```

- [ ] **Step 2: Typecheck the new component.**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run the existing test suite to confirm no regressions.**

Run: `cd ui && npx vitest run`
Expected: PASS — 161 existing + 13 new from Task 7.

- [ ] **Step 4: Commit.**

```bash
git add ui/src/sidebar/Backlinks.tsx
git commit -m "feat(ui): Backlinks panel component with loading/empty/error states"
```

---

## Task 9: `RightSidebar.tsx` shell

**Files:**
- Create: `ui/src/RightSidebar.tsx`

- [ ] **Step 1: Create `ui/src/RightSidebar.tsx`** with the collapsible shell. It owns the collapsed state and exposes a toggle button; the panel itself is supplied as `children` (so Session I can add Unlinked Mentions next to Backlinks without touching this file):

```tsx
import { Show, type Component, type JSX } from "solid-js";

/**
 * Collapsible right-sidebar shell.
 *
 * Panel-agnostic on purpose: Session C ships exactly one occupant
 * (Backlinks), Session I will add Unlinked Mentions and a tab/segment
 * selector. The shell itself only handles the collapsed/expanded
 * frame and the toggle button; the contents are `children`.
 *
 * `collapsed` and `onToggle` are owned by the parent so the value can
 * be persisted as a vault-local setting.
 */
export interface RightSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  children: JSX.Element;
}

const COLLAPSED_WIDTH = "2rem";
const EXPANDED_WIDTH = "18rem";

const RightSidebar: Component<RightSidebarProps> = (props) => {
  return (
    <aside
      aria-label="Right sidebar"
      style={{
        flex: `0 0 ${props.collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH}`,
        display: "flex",
        "flex-direction": "column",
        border: "1px solid var(--c-border-subtle)",
        "border-radius": "var(--radius-md)",
        background: "var(--c-bg-secondary)",
        "min-height": 0,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": props.collapsed ? "center" : "flex-end",
          padding: "var(--space-2)",
          "border-bottom": props.collapsed
            ? "none"
            : "1px solid var(--c-border-subtle)",
        }}
      >
        <button
          type="button"
          onClick={props.onToggle}
          aria-label={props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={!props.collapsed}
          title={props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            width: "1.75rem",
            height: "1.75rem",
            "font-family": "var(--font-mono)",
            "font-size": "var(--text-sm)",
            "line-height": "1",
            color: "var(--c-fg-secondary)",
            background: "transparent",
            border: "1px solid var(--c-border-subtle)",
            "border-radius": "var(--radius-sm, var(--radius-md))",
            cursor: "pointer",
            transition:
              "color var(--transition-fast), background var(--transition-fast)",
          }}
        >
          {props.collapsed ? "‹" : "›"}
        </button>
      </header>
      <Show when={!props.collapsed}>
        <div
          style={{
            flex: 1,
            "min-height": 0,
            display: "flex",
            "flex-direction": "column",
          }}
        >
          {props.children}
        </div>
      </Show>
    </aside>
  );
};

export default RightSidebar;
```

- [ ] **Step 2: Typecheck.**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add ui/src/RightSidebar.tsx
git commit -m "feat(ui): collapsible right-sidebar shell"
```

---

## Task 10: Wire `<RightSidebar>` + `<Backlinks>` into `App.tsx`

**Files:**
- Modify: `ui/src/App.tsx`

This is the largest TS change — pull the new pieces into the existing layout, fetch backlinks on file-selection change, debounce-refresh on `vault:file-changed`, and persist the collapsed state.

- [ ] **Step 1: Extend imports** in `ui/src/App.tsx`. After the existing `import { ... } from "./styles/theme";` block, add:

```tsx
import RightSidebar from "./RightSidebar";
import Backlinks from "./sidebar/Backlinks";
```

- [ ] **Step 2: Add new state signals.** Inside the `App` component, immediately after the `createOffer` signal pair (around line 165), add:

```tsx
  // L3 Session C: right-sidebar shell state + backlinks refresh tick.
  // `rightSidebarCollapsed` mirrors the `ui.right_sidebar_collapsed`
  // vault-local setting (seeded on vault open, persisted on toggle).
  // `backlinksRefreshTick` is a monotonic counter that the Backlinks
  // panel watches — every `vault:file-changed` event bumps it after
  // a 200ms debounce so the panel refetches without polling.
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = createSignal(false);
  const [backlinksRefreshTick, setBacklinksRefreshTick] = createSignal(0);
  let backlinksRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const BACKLINKS_REFRESH_DEBOUNCE_MS = 200;
```

- [ ] **Step 3: Add the debounced bump helper.** After the `scheduleAutosave` helper (around line 277), add:

```tsx
  /**
   * Bump the backlinks refresh tick after a 200ms debounce. Called
   * from the `vault:file-changed` listener — any vault file change
   * may have created or removed a link pointing at the open note.
   */
  const scheduleBacklinksRefresh = () => {
    if (backlinksRefreshTimer !== undefined) {
      clearTimeout(backlinksRefreshTimer);
    }
    backlinksRefreshTimer = setTimeout(() => {
      backlinksRefreshTimer = undefined;
      setBacklinksRefreshTick((n) => n + 1);
    }, BACKLINKS_REFRESH_DEBOUNCE_MS);
  };
```

- [ ] **Step 4: Add a toggle handler that persists.** After the `setRawAsDefault` function (around line 339), add:

```tsx
  /**
   * Toggle the right sidebar collapsed/expanded and persist the new
   * value to the vault. With no vault open the change is in-memory
   * only (the setting is vault-local — nowhere to persist yet).
   */
  const toggleRightSidebar = () => {
    const next = !rightSidebarCollapsed();
    setRightSidebarCollapsed(next);
    const id = vaultId();
    if (id) {
      setSetting(id, "ui.right_sidebar_collapsed", next).catch((e) => {
        console.error("persisting ui.right_sidebar_collapsed failed", e);
      });
    }
  };
```

- [ ] **Step 5: Hook the file-changed listener.** Inside the `onVaultFileChanged` handler in `onMount` (around line 506), add `scheduleBacklinksRefresh();` right after the existing `wikilinkResolver()?.invalidate();` line. Final shape of that block:

```tsx
    unlistenFileChanged = await onVaultFileChanged((p) => {
      if (p.vault_id !== vaultId()) return;
      scheduleRefresh();

      // L3 Session B: any vault file change may have created or
      // removed a wiki-link target. Drop the resolver cache so the
      // next decoration rebuild re-resolves.
      wikilinkResolver()?.invalidate();

      // L3 Session C: any vault file change may have added/removed
      // a link pointing at the open note. Bump the backlinks tick
      // after a 200ms debounce so the panel refetches.
      scheduleBacklinksRefresh();

      // L2 §2.7 + §2.8 (rest of the block unchanged) …
```

- [ ] **Step 6: Cleanup the timer.** Inside the existing `onCleanup` block (around line 579) add `if (backlinksRefreshTimer !== undefined) clearTimeout(backlinksRefreshTimer);` after the autosave-timer line. Final block:

```tsx
  onCleanup(() => {
    unlistenProgress?.();
    unlistenComplete?.();
    unlistenCancelled?.();
    unlistenFileChanged?.();
    if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
    if (backlinksRefreshTimer !== undefined) clearTimeout(backlinksRefreshTimer);
  });
```

- [ ] **Step 7: Seed the collapsed state on vault open.** Inside `handleOpen`, after the existing `setRawDefault(stored ?? false);` block (around line 642), add:

```tsx
      // Seed the right-sidebar collapsed state from this vault's
      // settings. Absent key → expanded (false). The shell is the
      // primary surface for backlinks/mentions; default-open is the
      // right out-of-the-box experience.
      try {
        const stored = await getSetting(
          resp.vault_id,
          "ui.right_sidebar_collapsed",
        );
        setRightSidebarCollapsed(stored ?? false);
      } catch (e) {
        console.error("loading ui.right_sidebar_collapsed failed", e);
      }
```

- [ ] **Step 8: Render `<RightSidebar>` next to the editor.** Find the existing flex row that holds the file list and editor (around line 825 — the `<div style={{ display: "flex", gap: "var(--space-3)", flex: 1, "min-height": 0, }}>`). Inside that flex row, *after* the editor `<div>` block closes (the one starting `<div style={{ flex: 1, "min-width": 0, … }}>` and ending with its closing `</div>`), add the sidebar render:

```tsx
            <RightSidebar
              collapsed={rightSidebarCollapsed()}
              onToggle={toggleRightSidebar}
            >
              <Backlinks
                vaultId={vaultId()}
                path={selectedPath()}
                refreshSignal={backlinksRefreshTick()}
                onRowClick={(path) =>
                  void handleNavigateWikilink(path, null)
                }
              />
            </RightSidebar>
```

The `handleNavigateWikilink` reuse means a row click goes through the same `handleSelectFile` plumbing as a wiki-link click — autosave / `seenHash` / `dirty` bookkeeping stay correct.

- [ ] **Step 9: Reset the tick on vault swap.** Inside `handleOpen`, in the "reset prior vault's UI state" block (around line 596), after `setCreateOffer(null);` add:

```tsx
      setBacklinksRefreshTick(0);
      setRightSidebarCollapsed(false);
```

- [ ] **Step 10: Typecheck and build.**

Run: `cd ui && npx tsc --noEmit && npx vite build`
Expected: clean.

- [ ] **Step 11: Run the full vitest suite.**

Run: `cd ui && npx vitest run`
Expected: PASS — 161 baseline + 13 new = 174 tests.

- [ ] **Step 12: Commit.**

```bash
git add ui/src/App.tsx
git commit -m "feat(app): wire RightSidebar + Backlinks into the main layout"
```

---

## Task 11: Final verification gates

- [ ] **Step 1: Run the full Rust suite.**

Run: `cargo test --workspace`
Expected: PASS — 170 baseline + 2 query + 9 snippet + 5 handler = 186 tests.

- [ ] **Step 2: Run clippy with warnings-as-errors.**

Run: `cargo clippy --workspace --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 3: Run `cargo fmt --check`.**

Run: `cargo fmt --check`
Expected: clean.

- [ ] **Step 4: Run TypeScript typecheck.**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Run the production build.**

Run: `cd ui && npm run build`
Expected: clean.

- [ ] **Step 6: Run the full vitest suite.**

Run: `cd ui && npx vitest run`
Expected: PASS — 174 tests.

- [ ] **Step 7: Interactive smoke against `cargo tauri dev` (best-effort).**

If the operator is available, drive a hands-on smoke with this vault:

```
NoteA.md   →   # NoteA\n\nSomething about [[Target]] and more.\n
NoteB.md   →   # NoteB\n\n[[Target|the target]] is referenced here.\n
NoteC.md   →   # NoteC\n\nNo backlinks point here.\n
Target.md  →   # Target\n\nbody\n
```

Confirm: opening `Target.md` populates the panel with two rows (`NoteA`, `NoteB`); the context for each row contains the word `Target`; clicking `NoteA` opens it (editor / seenHash flow stays correct — write to NoteA, see it autosave); opening `NoteC.md` shows the "No backlinks yet" empty state; creating a new `NoteD.md` with `[[Target]]` updates the panel within ~200ms; collapsing the sidebar and re-opening the vault remembers the collapsed state.

If the smoke can't run (no operator, headless environment), document that explicitly in §9.3 — mirror Session B's pattern (record the recommended smoke vault + the checks that need a human, note that the unit-test coverage exercises every pure decision).

---

## Task 12: Documentation — fill §9.3 + rewrite Project state

**Files:**
- Modify: `docs/layer-3-spec.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Open `docs/layer-3-spec.md` and append §9.3** below the existing §9.2 block. Mirror §9.1 and §9.2's voice and structure (intro paragraph, named subsections for each landed piece, a "Decisions worth noting" block, the final "What's left for L3" line).

Cover, in order:
- The query layer (`BacklinkRow` + `backlinks_for`, ordering, why a new query rather than enriching `links_to`).
- The IPC layer (`get_backlinks` handler, snippet helper grammar + UTF-8 safety, missing-source-file behaviour).
- The frontend layer (`RightSidebar` shell, `Backlinks` panel, view-state machine, pure-helpers pattern).
- Wiring (App.tsx render + fetch-on-selection + debounced live refresh).
- The `ui.right_sidebar_collapsed` setting (vault-local).

Match §9.2's "Decisions worth noting" block — explicit decision lines for: query-shape choice; snippet heuristic + UTF-8 boundary handling; one-row-per-link vs. group-by-source; piggyback-vs-`vault:index-changed`; vault-local collapsed-state persistence; sidebar width hardcoded vs. tokenised.

- [ ] **Step 2: Rewrite the CLAUDE.md "Project state" block.** Replace the existing 4-line block (DO NOT append). New content:

```
## Project state

Current layer: 3 — Knowledge Graph (Sessions A + B + C done, Sessions D–K pending). Session C landed the collapsible right-sidebar shell (`ui/src/RightSidebar.tsx`, `flex: 0 0 18rem` expanded / `2rem` collapsed, panel-agnostic so Session I can add Unlinked Mentions next to Backlinks) with its first occupant — the Backlinks panel (`ui/src/sidebar/Backlinks.tsx`) — listing every note whose `links.target_path` resolves to the open file with a single-line ~120-char context snippet, refreshing on a 200ms-debounced `vault:file-changed` tick (the spec's `vault:index-changed` event is deferred until a second consumer surfaces). Backed by a new `get_backlinks` IPC + a dedicated `backlinks_for(target_path) -> Vec<BacklinkRow>` query (chosen over enriching `links_to` because `links_to` has no production callers); the snippet helper is a pure 120-char window centred on `position`, newlines collapsed, word-boundary trimmed, UTF-8 safe. Row clicks reuse the Session B `handleNavigateWikilink` → `handleSelectFile` seam so autosave / `seenHash` / `dirty` bookkeeping stays correct. Collapsed state persists as a new `ui.right_sidebar_collapsed` vault-local setting.
Tests: <NEW_RUST> Rust + <NEW_VITEST> vitest. L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: L3 Session D — Tags (parsing, index, nested tags, decoration). build-order §3, layer spec §2.4 + §8 Session D.
```

Replace `<NEW_RUST>` and `<NEW_VITEST>` with the final test counts from Task 11 (Rust will be 186 if you added exactly the planned tests; vitest will be 174). If the counts differ — e.g. you added an extra regression test — record the actual numbers.

- [ ] **Step 3: Commit the docs.**

```bash
git add docs/layer-3-spec.md CLAUDE.md
git commit -m "docs: L3 Session C complete — backlinks panel + right-sidebar shell"
```

---

## Task 13: Finish the branch

- [ ] **Step 1: Final clean tree check.**

Run: `git status`
Expected: working tree clean.

- [ ] **Step 2: Invoke `superpowers:finishing-a-development-branch`.** It will offer merge / PR / cleanup options; default per project workflow is to merge `l3-session-c-backlinks-panel` into `main` with `--no-ff` after a final all-gates-green confirmation, then delete the branch. Do NOT push (per CLAUDE.md memory: `feedback_no_worktrees` plus session-end protocol "do NOT push").

- [ ] **Step 3: Report the DoD checklist back to the user** per the session prompt's `SESSION END PROTOCOL`: every DoD box's status, decisions deferred (none if Task 12 captured everything), the new test counts, smoke evidence (or explicit deferral), and the next session name (L3 Session D — Tags: parsing, index, nested tags, decoration).

---

## Self-review notes

- Every spec §6 / §8 Session C / DoD box maps to a task: query (Task 1), handler (Tasks 2–5), snippet (Task 3), shell (Task 9), panel (Tasks 7–8), wiring + refresh + persistence (Task 10), §9.3 + Project state (Task 12).
- Decisions raised in the session prompt are recorded above ("Decisions locked in this plan") and surfaced again in §9.3 — no placeholders.
- Type names + signatures used in later tasks match the earlier definitions: `Backlink` (TS) ↔ `Backlink` (Rust); `BacklinkRow` only in Rust; `BacklinksViewState` discriminator matches `kind: "idle" | "loading" | "empty" | "loaded" | "error"` exactly; `ui.right_sidebar_collapsed` setting key used identically in IPC union, App seeding, and toggle persistence.
- Out-of-scope items (Tags, virtual tag pages, autocomplete, embeds proper, unlinked mentions, pending-rewrites, `vault:index-changed` event, `l3` tag) are NOT introduced anywhere in the plan.
