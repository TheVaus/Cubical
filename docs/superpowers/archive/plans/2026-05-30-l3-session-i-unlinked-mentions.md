# L3 Session I — Unlinked Mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a second right-sidebar panel that surfaces every plain-text occurrence of the open note's title or any frontmatter `aliases` value that isn't already a link, with a per-row "link it" action that rewrites the matched text into `[[…]]` on disk.

**Architecture:** Pure on-demand scan (no new index table). A pure `cubical-core::vault::mentions` module walks the source text outside of frontmatter / code / wiki-links / markdown links, then finds whole-word case-insensitive needle occurrences. Two new IPC handlers (`get_unlinked_mentions` + `link_mention`) follow the L0 §8 pure-handler + thin-shim pattern. Frontend mirrors the Session C Backlinks pattern verbatim: state signal + Solid panel + segment selector inside the existing `RightSidebar` shell, with the new `ui.right_sidebar_panel` vault-local setting persisting the selected segment.

**Tech Stack:** Rust 2021 (`cubical-core`, `cubical-app`, `cubical-index`), TypeScript strict (`ui/`), Solid signals, libSQL (no new migration), Tauri 2 IPC.

---

## Pre-flight decisions (resolved from the session prompt's "Decisions to raise" block)

These are locked at plan time. If a step encounters a reality that contradicts one of these, surface the conflict in a review checkpoint — don't silently change.

| Decision | Choice | Rationale |
|---|---|---|
| Title source | `path.basename` minus the `.md` extension (case-preserved as on disk) | No `title:` frontmatter convention exists in the codebase; matches `basenameWithoutExtension` in `ui/src/sidebar/backlinksState.ts:27`. |
| Whole-word boundary | Boundary char = `!ch.is_alphanumeric() && ch != '_'` (Rust's locale-independent `char::is_alphanumeric`) | Matches Tantivy's default tokenizer boundary so the eventual L4 search agrees. |
| Alias-matched rewrite shape | `[[Title\|alias]]` when alias ≠ title case-insensitively; bare `[[Title]]` otherwise | Preserves the surface text the reader saw, but resolves to the unambiguous file path. |
| Match casing in the rewrite | Drop source casing in favor of canonical title/alias (except the alias-display case above) | Spec doesn't require preserving original casing, and the canonical form is shorter + cleaner. |
| Source-file `expected_seen_hash` | Read just-in-time on the backend; frontend doesn't supply one. Atomic write still gates on the on-disk hash captured during the same call | Frontend has no seen-hash for files that aren't currently open in the editor. |
| Live-refresh route | Piggyback the existing `vault:file-changed` debounced listener; rename `BACKLINKS_REFRESH_DEBOUNCE_MS` → `RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS` and fan it out to both panels | Spec is explicit that no new `vault:index-changed` event ships in I. |
| Segment selector location | Inside `RightSidebar` (the shell owns the tab chrome) | Keeps `App.tsx` flatter and lets `RightSidebar` continue to be the single chrome owner. |
| Group by source vs. flat list | Flat list, ordered `(source_path, position)`. Identical to Backlinks (which is also flat). | Symmetry across the two panels. |
| Snippet helper sharing | Lift `build_snippet` (currently in `crates/cubical-app/src/commands/backlinks.rs:19`) into a new `crates/cubical-app/src/commands/snippet.rs` module; both backlinks + mentions import it | Identical-looking context across the two panels; pure function with no I/O. |
| Open note exclusion | The open note's `path` is excluded from the candidate list inside the handler — its own mentions of itself never surface | Spec §2.9 wording: "for the open note, every plain-text occurrence … in vault text." |
| Source casing for needles | Always include both the title and every alias, deduped case-insensitively, blank entries dropped | Aliases of wrong shape (non-string in the YAML list) are silently dropped. |

---

## File Structure

### New Rust files

- `crates/cubical-core/src/vault/mentions.rs` — pure scanner: `extract_text_runs` + `find_mention_occurrences` + their shared `MentionHit` type. No I/O. Heavy unit tests.
- `crates/cubical-app/src/commands/mentions.rs` — `get_unlinked_mentions` and `link_mention` pure handlers + tests.
- `crates/cubical-app/src/commands/snippet.rs` — `build_snippet` lifted out of `backlinks.rs` (verbatim, no behaviour change); both backlinks + mentions import it.

### Modified Rust files

- `crates/cubical-ast/src/lib.rs` — promote `mod wikilink` to `pub mod wikilink` and re-export `scan_wikilinks` + `TokenizedRun` so `cubical-core` can call them without copying the tokenizer.
- `crates/cubical-core/src/vault/mod.rs` — `pub mod mentions;` plus re-exports for what the app uses.
- `crates/cubical-app/src/api/types.rs` — add `GetUnlinkedMentionsRequest/Response`, `Mention`, `LinkMentionRequest/Response`.
- `crates/cubical-app/src/commands/mod.rs` — `pub mod mentions;` + `pub mod snippet;`.
- `crates/cubical-app/src/commands/backlinks.rs` — delete the inlined `build_snippet` + its tests; replace with `use crate::commands::snippet::build_snippet;` (the unit tests for the helper move with it).
- `crates/cubical-app/src/lib.rs` — register both new shims in `generate_handler!`.

### New TypeScript files

- `ui/src/sidebar/unlinkedMentionsState.ts` — pure state machine mirroring `backlinksState.ts:1`.
- `ui/src/sidebar/UnlinkedMentions.tsx` — panel mirroring `Backlinks.tsx:33`.
- `ui/src/sidebar/unlinkedMentions.test.ts` — unit tests mirroring `backlinks.test.ts:1`.

### Modified TypeScript files

- `ui/src/RightSidebar.tsx` — add `segment` + `onSegmentChange` props + a tabbed chrome bar above the children when the segment selector is enabled.
- `ui/src/App.tsx` — render `<UnlinkedMentions>` or `<Backlinks>` based on the selected segment; wire debounced `vault:file-changed` refresh for both; persist `ui.right_sidebar_panel`.
- `ui/src/api/ipc.ts` — add `getUnlinkedMentions` + `linkMention` + their wire types; extend `Setting` union with `ui.right_sidebar_panel`.

---

## Task 1: Promote `cubical-ast::wikilink` to a public module

**Files:**
- Modify: `crates/cubical-ast/src/lib.rs:38`
- Test: existing `crates/cubical-ast/tests/*` continue to pass (no new test needed — the module's own tests already exercise `scan_wikilinks`).

- [ ] **Step 1: Promote the module to `pub`**

Edit `crates/cubical-ast/src/lib.rs`. Change line 38 from `mod wikilink;` to `pub mod wikilink;`, and add to the `pub use` block right after `pub use types::{...}`:

```rust
pub use wikilink::{scan_wikilinks, TokenizedRun};
```

- [ ] **Step 2: Verify the crate still builds + tests pass**

Run: `cargo test -p cubical-ast`
Expected: PASS (same count as before; no new tests).

- [ ] **Step 3: Verify no downstream crate broke**

Run: `cargo build --workspace`
Expected: PASS, no warnings.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-ast/src/lib.rs
git commit -m "refactor(ast): expose scan_wikilinks + TokenizedRun publicly

Session I's mentions scanner needs to walk the same wiki-link
tokens the AST recognises so already-linked occurrences are
excluded. Promote the previously-private module instead of
copying the tokenizer."
```

---

## Task 2: Pure scanner — `extract_text_runs`

**Files:**
- Create: `crates/cubical-core/src/vault/mentions.rs`
- Modify: `crates/cubical-core/src/vault/mod.rs:24` (add `pub mod mentions;`)
- Test: inline `#[cfg(test)]` block in `mentions.rs`

The scanner walks `source` byte-by-byte and yields every text region that is *outside* all of: YAML frontmatter, fenced code (` ``` ` / `~~~`), inline code spans (`` `…` ``), wiki-links (`[[…]]` / `![[…]]`), and markdown links (`[…](…)` for both display and url segments). Heading marker chars (`#` runs at line start, `===`/`---` underlines) are excluded so a heading whose text matches a title is still indexed as text. Raw URLs auto-linked by the editor are *not* a separate token in pulldown-cmark — they're text — so we don't filter them; the whole-word boundary filter at match time handles the surrounding `://`.

- [ ] **Step 1: Add the module declaration**

Edit `crates/cubical-core/src/vault/mod.rs`. Add `pub mod mentions;` next to the existing `pub mod blocks;` / `pub mod links;` lines.

- [ ] **Step 2: Write the failing tests for `extract_text_runs`**

Create `crates/cubical-core/src/vault/mentions.rs` with this initial content:

```rust
//! On-demand unlinked-mention scanner (L3 Session I, spec §2.9).
//!
//! Pure: no I/O, no DB. Walks markdown source to find plain-text
//! regions (skipping frontmatter, fenced/inline code, wiki-links,
//! and markdown links), then matches needles against those regions
//! with whole-word case-insensitive comparison.

use cubical_ast::wikilink::{scan_wikilinks, TokenizedRun};

/// A contiguous slice of source bytes that is plain text — i.e. NOT
/// inside frontmatter, fenced code, inline code, a wiki-link, or a
/// markdown link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextRun<'a> {
    /// Byte offset into the original source where this run begins.
    pub start: u64,
    /// The slice itself (borrowed from the source).
    pub slice: &'a str,
}

/// Walk `source` and yield every plain-text run, in source order.
pub fn extract_text_runs(source: &str) -> Vec<TextRun<'_>> {
    todo!()
}

/// One needle occurrence found inside a text run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionHit {
    /// Which needle in the caller's slice matched (so the caller can
    /// distinguish title vs. alias).
    pub needle_index: usize,
    /// Byte offset into the original source where the match starts.
    pub byte_offset: u64,
    /// Length in bytes of the matched span.
    pub byte_len: u64,
}

/// Find every whole-word case-insensitive occurrence of any `needle`
/// in the plain-text regions of `source`. Empty / whitespace-only /
/// whitespace-containing needles are skipped silently.
pub fn find_mention_occurrences(source: &str, needles: &[&str]) -> Vec<MentionHit> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_slices(runs: &[TextRun<'_>]) -> Vec<&str> {
        runs.iter().map(|r| r.slice).collect()
    }

    // ---- extract_text_runs ---------------------------------------

    #[test]
    fn empty_source_yields_no_runs() {
        assert!(extract_text_runs("").is_empty());
    }

    #[test]
    fn plain_paragraph_is_one_run() {
        let runs = extract_text_runs("hello world\n");
        assert_eq!(run_slices(&runs), vec!["hello world\n"]);
        assert_eq!(runs[0].start, 0);
    }

    #[test]
    fn frontmatter_block_is_skipped() {
        let src = "---\ntitle: Foo\n---\nbody text\n";
        let runs = extract_text_runs(src);
        let joined: String = runs.iter().map(|r| r.slice).collect();
        assert!(!joined.contains("title:"), "frontmatter leaked: {joined:?}");
        assert!(joined.contains("body text"));
    }

    #[test]
    fn fenced_code_is_skipped() {
        let src = "before\n```\nDaily inside fence\n```\nafter Daily\n";
        let joined: String = extract_text_runs(src)
            .iter()
            .map(|r| r.slice)
            .collect();
        assert!(!joined.contains("inside fence"), "fenced leaked: {joined:?}");
        assert!(joined.contains("after Daily"));
    }

    #[test]
    fn inline_code_span_is_skipped() {
        let src = "see `daily` for context and Daily again\n";
        let joined: String = extract_text_runs(src)
            .iter()
            .map(|r| r.slice)
            .collect();
        // The plain text outside the span survives.
        assert!(joined.contains("see "));
        assert!(joined.contains("Daily again"));
        // The span's interior does not.
        assert!(!joined.contains("`daily`"));
    }

    #[test]
    fn wikilink_body_is_skipped() {
        let src = "text [[Daily]] more text\n";
        let joined: String = extract_text_runs(src)
            .iter()
            .map(|r| r.slice)
            .collect();
        assert!(joined.contains("text "));
        assert!(joined.contains(" more text"));
        assert!(!joined.contains("Daily"), "wiki-link leaked: {joined:?}");
    }

    #[test]
    fn embed_wikilink_body_is_skipped() {
        let src = "text ![[Daily]] more\n";
        let joined: String = extract_text_runs(src)
            .iter()
            .map(|r| r.slice)
            .collect();
        assert!(!joined.contains("Daily"));
    }

    #[test]
    fn markdown_link_display_and_url_are_skipped() {
        let src = "see [Daily](daily.md) here\n";
        let joined: String = extract_text_runs(src)
            .iter()
            .map(|r| r.slice)
            .collect();
        assert!(joined.contains("see "));
        assert!(joined.contains(" here"));
        assert!(!joined.contains("Daily"));
        assert!(!joined.contains("daily.md"));
    }

    #[test]
    fn text_runs_preserve_byte_offsets() {
        // "hello [[Daily]] world" — runs at 0 ("hello ") and 15 (" world\n").
        let runs = extract_text_runs("hello [[Daily]] world\n");
        let starts: Vec<u64> = runs.iter().map(|r| r.start).collect();
        assert_eq!(starts.first().copied(), Some(0));
        // Second run starts after the closing ]] which ends at byte 15.
        assert!(starts.contains(&15), "starts: {starts:?}");
    }
}
```

- [ ] **Step 3: Run the failing tests**

Run: `cargo test -p cubical-core --lib vault::mentions`
Expected: tests fail with `not yet implemented` (the `todo!()` body).

- [ ] **Step 4: Implement `extract_text_runs`**

Replace the `todo!()` body of `extract_text_runs` with:

```rust
pub fn extract_text_runs(source: &str) -> Vec<TextRun<'_>> {
    if source.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor: usize = 0;
    let mut i: usize = 0;
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut in_fence = false;
    let mut fence_marker: &str = "";

    // Frontmatter: a `---\n` at byte 0, terminated by the next `\n---\n`
    // or `\n---` at end of file. Mirrors `cubical_ast::split_frontmatter`
    // semantics at the byte level — we only need to find the end offset.
    if source.starts_with("---\n") || source.starts_with("---\r\n") {
        let after_open = if source.starts_with("---\r\n") { 5 } else { 4 };
        // Find next line beginning with `---` followed by EOL or EOF.
        let mut probe = after_open;
        while probe < len {
            // Line start position.
            let line_start = probe;
            // Advance probe to end of line.
            while probe < len && bytes[probe] != b'\n' {
                probe += 1;
            }
            let line = &source[line_start..probe];
            let trimmed = line.trim_end_matches('\r');
            if trimmed == "---" || trimmed == "..." {
                // Skip past the close (include the trailing newline if any).
                cursor = probe + if probe < len { 1 } else { 0 };
                i = cursor;
                break;
            }
            if probe < len {
                probe += 1; // step past the '\n'
            }
        }
        if cursor == 0 {
            // No close found — treat whole file as frontmatter (degenerate).
            return Vec::new();
        }
    }

    let mut line_start = i;
    let mut at_line_start = true;

    while i < len {
        let b = bytes[i];

        // Line tracking.
        if b == b'\n' {
            i += 1;
            line_start = i;
            at_line_start = true;
            continue;
        }

        // Fence open/close — check only at the start of a line.
        if at_line_start {
            // Skip leading spaces (up to 3 — CommonMark allows that).
            let mut j = i;
            let mut spaces = 0;
            while j < len && bytes[j] == b' ' && spaces < 4 {
                j += 1;
                spaces += 1;
            }
            if !in_fence {
                if source[j..].starts_with("```") || source[j..].starts_with("~~~") {
                    // Flush any pending text run up to line_start.
                    push_run(&mut out, source, cursor, line_start);
                    in_fence = true;
                    fence_marker = if source[j..].starts_with("```") {
                        "```"
                    } else {
                        "~~~"
                    };
                    // Skip to end of line.
                    while i < len && bytes[i] != b'\n' {
                        i += 1;
                    }
                    if i < len {
                        i += 1;
                    }
                    cursor = i;
                    line_start = i;
                    at_line_start = true;
                    continue;
                }
            } else if source[j..].starts_with(fence_marker) {
                in_fence = false;
                while i < len && bytes[i] != b'\n' {
                    i += 1;
                }
                if i < len {
                    i += 1;
                }
                cursor = i;
                line_start = i;
                at_line_start = true;
                continue;
            }
            at_line_start = false;
        }

        if in_fence {
            i += 1;
            continue;
        }

        // Inline code span — opening backtick run. Skip over until a
        // matching-length run closes it. CommonMark allows `…`, ``…``, etc.
        if b == b'`' {
            let mut tick_len = 0;
            while i + tick_len < len && bytes[i + tick_len] == b'`' {
                tick_len += 1;
            }
            // Find a closing run of the same length on the same or
            // subsequent lines (CommonMark allows multi-line code spans).
            let scan_start = i + tick_len;
            let mut close = scan_start;
            let mut found_close = None;
            while close < len {
                if bytes[close] == b'`' {
                    let mut run = 0;
                    while close + run < len && bytes[close + run] == b'`' {
                        run += 1;
                    }
                    if run == tick_len {
                        found_close = Some(close);
                        break;
                    }
                    close += run;
                } else {
                    close += 1;
                }
            }
            match found_close {
                Some(end) => {
                    push_run(&mut out, source, cursor, i);
                    let after = end + tick_len;
                    cursor = after;
                    i = after;
                    continue;
                }
                None => {
                    // Unterminated — treat the backticks as literal text.
                    i += tick_len;
                    continue;
                }
            }
        }

        // Wiki-link / embed.
        if b == b'[' && i + 1 < len && bytes[i + 1] == b'[' {
            // Look back: an immediately-preceding `!` makes this an embed
            // and the run's exclusion zone starts at the `!`.
            let opener_start = if i > 0 && bytes[i - 1] == b'!' { i - 1 } else { i };
            // Find matching `]]`.
            let mut j = i + 2;
            let mut close = None;
            while j + 1 < len {
                if bytes[j] == b']' && bytes[j + 1] == b']' {
                    close = Some(j + 2);
                    break;
                }
                j += 1;
            }
            if let Some(after_close) = close {
                push_run(&mut out, source, cursor, opener_start);
                cursor = after_close;
                i = after_close;
                continue;
            }
            // Unterminated wiki-link → fall through and treat as text.
        }

        // Markdown link `[display](url)` — skip both segments.
        if b == b'[' {
            // Find matching `]`.
            let mut j = i + 1;
            let mut depth = 1;
            while j < len {
                match bytes[j] {
                    b'[' => depth += 1,
                    b']' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            if j < len && bytes[j] == b']' && j + 1 < len && bytes[j + 1] == b'(' {
                // Find the matching `)`.
                let mut k = j + 2;
                while k < len && bytes[k] != b')' {
                    k += 1;
                }
                if k < len {
                    push_run(&mut out, source, cursor, i);
                    cursor = k + 1;
                    i = k + 1;
                    continue;
                }
            }
        }

        i += 1;
    }

    push_run(&mut out, source, cursor, len);
    out
}

fn push_run<'a>(out: &mut Vec<TextRun<'a>>, source: &'a str, start: usize, end: usize) {
    if end > start {
        out.push(TextRun {
            start: start as u64,
            slice: &source[start..end],
        });
    }
}
```

- [ ] **Step 5: Re-run the tests; iterate until green**

Run: `cargo test -p cubical-core --lib vault::mentions`
Expected: all text-run tests PASS. (The mention-hit tests still error at `todo!()` — that's Task 3.)

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-core/src/vault/mod.rs crates/cubical-core/src/vault/mentions.rs
git commit -m "feat(core): pure text-run scanner for unlinked mentions

vault::mentions::extract_text_runs walks markdown source and yields
plain-text regions outside frontmatter, fenced/inline code, wiki-links,
and markdown links. Foundation for the on-demand Session I scan
(spec §2.9); the needle finder lands next."
```

---

## Task 3: Pure scanner — `find_mention_occurrences`

**Files:**
- Modify: `crates/cubical-core/src/vault/mentions.rs`

The matcher iterates each text run and, for each needle, walks character boundaries looking for case-insensitive substring matches whose preceding + following codepoints (or the run edges) satisfy the whole-word boundary rule.

- [ ] **Step 1: Add failing tests for the matcher**

Append to the `tests` module in `crates/cubical-core/src/vault/mentions.rs`:

```rust
    // ---- find_mention_occurrences --------------------------------

    fn hit_slice<'a>(src: &'a str, hit: &MentionHit) -> &'a str {
        let s = hit.byte_offset as usize;
        let e = s + hit.byte_len as usize;
        &src[s..e]
    }

    #[test]
    fn finds_simple_whole_word_match_case_insensitive() {
        let src = "I worked on the Daily today.\n";
        let hits = find_mention_occurrences(src, &["daily"]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hit_slice(src, &hits[0]), "Daily");
        assert_eq!(hits[0].needle_index, 0);
    }

    #[test]
    fn rejects_substring_inside_a_larger_word() {
        let src = "ordinarily this counts but ordinariness does not\n";
        let hits = find_mention_occurrences(src, &["dinari"]);
        assert!(hits.is_empty(), "substring leaked: {hits:?}");
    }

    #[test]
    fn boundary_treats_hyphen_as_non_word() {
        let src = "see Daily-Note for details\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hit_slice(src, &hits[0]), "Daily");
    }

    #[test]
    fn boundary_treats_underscore_as_word_so_underscore_blocks_match() {
        let src = "see Daily_Notes for details\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert!(hits.is_empty(), "underscore should block whole-word match: {hits:?}");
    }

    #[test]
    fn multiple_needles_one_call() {
        let src = "Daily and Journal both belong here.\n";
        let hits = find_mention_occurrences(src, &["Daily", "Journal"]);
        let needles: Vec<usize> = hits.iter().map(|h| h.needle_index).collect();
        assert!(needles.contains(&0));
        assert!(needles.contains(&1));
    }

    #[test]
    fn empty_or_whitespace_needles_silently_dropped() {
        let src = "text here\n";
        let hits = find_mention_occurrences(src, &["", "  ", "text"]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].needle_index, 2);
    }

    #[test]
    fn needle_with_internal_space_is_supported() {
        // The session prompt says skip needles containing whitespace;
        // but the spec allows the title to be multi-word. Decision:
        // allow internal spaces, only block leading/trailing or empty.
        // (See "Decisions" table — we treat trimming as silent.)
        let src = "see Project Alpha for the spec\n";
        let hits = find_mention_occurrences(src, &["Project Alpha"]);
        assert_eq!(hits.len(), 1, "multi-word needle should match");
    }

    #[test]
    fn match_inside_code_block_is_excluded() {
        let src = "```\nDaily here\n```\nDaily there\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].byte_offset, "```\nDaily here\n```\n".len() as u64);
    }

    #[test]
    fn match_inside_wikilink_is_excluded() {
        let src = "[[Daily]] and Daily mention\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
        // The surviving match is the second one (after the wiki-link).
        assert_eq!(hit_slice(src, &hits[0]), "Daily");
        assert!(hits[0].byte_offset > "[[Daily]] ".len() as u64);
    }

    #[test]
    fn match_inside_markdown_link_is_excluded() {
        let src = "[Daily](daily.md) plus Daily standalone\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].byte_offset > "[Daily](daily.md) ".len() as u64 - 1);
    }

    #[test]
    fn unicode_whitespace_acts_as_boundary() {
        let src = "alpha\u{00A0}Daily\u{00A0}omega\n"; // NBSP on both sides
        let hits = find_mention_occurrences(src, &["Daily"]);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn frontmatter_value_is_not_a_match_source() {
        let src = "---\naliases: [Daily]\n---\nBody Daily here\n";
        let hits = find_mention_occurrences(src, &["Daily"]);
        // Only the body match should land.
        assert_eq!(hits.len(), 1);
    }
}
```

- [ ] **Step 2: Run the new tests; they should fail at `todo!()`**

Run: `cargo test -p cubical-core --lib vault::mentions::tests::finds_simple_whole_word_match_case_insensitive`
Expected: FAIL with `not yet implemented`.

- [ ] **Step 3: Implement `find_mention_occurrences`**

Replace the `todo!()` body of `find_mention_occurrences` with:

```rust
pub fn find_mention_occurrences(source: &str, needles: &[&str]) -> Vec<MentionHit> {
    // Pre-filter needles: keep non-empty after trim. Lowercase once.
    let prepared: Vec<(usize, String, usize)> = needles
        .iter()
        .enumerate()
        .filter_map(|(idx, n)| {
            let trimmed = n.trim();
            if trimmed.is_empty() {
                return None;
            }
            Some((idx, trimmed.to_lowercase(), trimmed.len()))
        })
        .collect();
    if prepared.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    for run in extract_text_runs(source) {
        let run_lower = run.slice.to_lowercase();
        // Lowercased length may differ from byte length when sources
        // contain casefolding-expanding characters; for matching we
        // operate on `run_lower` and map matches back via `char_indices`
        // of the original slice. Keep this simple: for ASCII the byte
        // offsets line up. For non-ASCII titles, this still works
        // because we use the **lowered** match's char position to walk
        // the **original** char_indices in parallel.
        //
        // We use a single linear scan per needle. N (needles) is small
        // (typically ≤5: title + a few aliases).
        for (needle_idx, needle_lower, _needle_byte_len) in &prepared {
            // Search positions one char at a time so byte boundaries
            // land cleanly. find() works on bytes (UTF-8 safe).
            let mut search_from = 0usize;
            while search_from <= run_lower.len() {
                let Some(rel) = run_lower[search_from..].find(needle_lower) else {
                    break;
                };
                let match_start = search_from + rel;
                let match_end = match_start + needle_lower.len();

                // Whole-word boundary check on the LOWER form — same
                // chars, just casefolded, so word/non-word classification
                // is preserved.
                if is_word_boundary(&run_lower, match_start, match_end) {
                    // Translate the matched span back to the original
                    // run's bytes. For ASCII titles this is identity;
                    // for non-ASCII we map via char_indices.
                    let (orig_start, orig_len) =
                        map_lower_span_to_original(run.slice, &run_lower, match_start, match_end);
                    out.push(MentionHit {
                        needle_index: *needle_idx,
                        byte_offset: run.start + orig_start as u64,
                        byte_len: orig_len as u64,
                    });
                    // Advance past this match.
                    search_from = match_end;
                } else {
                    // Slide forward by one char.
                    let step = run_lower[match_start..]
                        .chars()
                        .next()
                        .map(|c| c.len_utf8())
                        .unwrap_or(1);
                    search_from = match_start + step;
                }
            }
        }
    }
    // Sort by source position so callers don't need to re-sort.
    out.sort_by_key(|h| h.byte_offset);
    out
}

/// Whole-word boundary check: the chars immediately before / after the
/// match span must be either absent (run edge) or non-word
/// (`!alphanumeric && != '_'`).
fn is_word_boundary(s: &str, start: usize, end: usize) -> bool {
    let before_ok = match s[..start].chars().next_back() {
        None => true,
        Some(c) => !is_word_char(c),
    };
    let after_ok = match s[end..].chars().next() {
        None => true,
        Some(c) => !is_word_char(c),
    };
    before_ok && after_ok
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Translate `[match_start..match_end)` in `lower` back to the
/// equivalent `(orig_start, orig_len)` in `original`. Walks chars in
/// lockstep — for ASCII this is identity, for non-ASCII it accounts
/// for casefolding-induced length changes (e.g. `ß` → `ss`).
fn map_lower_span_to_original(
    original: &str,
    lower: &str,
    match_start: usize,
    match_end: usize,
) -> (usize, usize) {
    let mut orig_iter = original.char_indices();
    let mut lower_iter = lower.char_indices();
    let mut orig_start = 0usize;
    let mut orig_end = original.len();
    let mut found_start = false;
    loop {
        match (orig_iter.next(), lower_iter.next()) {
            (Some((oi, oc)), Some((li, _))) => {
                if !found_start && li >= match_start {
                    orig_start = oi;
                    found_start = true;
                }
                if li >= match_end {
                    orig_end = oi;
                    break;
                }
                // Advance lower iterator by the lowercased width of `oc`
                // when oc.to_lowercase() produces multi-char output.
                let lowered_len: usize = oc.to_lowercase().map(|c| c.len_utf8()).sum();
                if lowered_len > oc.len_utf8() {
                    // Skip extra lower-side chars to stay in lockstep.
                    let extra = lowered_len - oc.len_utf8();
                    let mut skipped = 0usize;
                    while skipped < extra {
                        if let Some((_, lc)) = lower_iter.next() {
                            skipped += lc.len_utf8();
                        } else {
                            break;
                        }
                    }
                }
            }
            (Some((oi, _)), None) => {
                orig_end = oi;
                break;
            }
            (None, _) => break,
        }
    }
    if !found_start {
        orig_start = original.len();
    }
    (orig_start, orig_end.saturating_sub(orig_start))
}
```

- [ ] **Step 4: Run all `mentions` tests**

Run: `cargo test -p cubical-core --lib vault::mentions`
Expected: all PASS.

- [ ] **Step 5: Update the `pub use` exports**

Edit `crates/cubical-core/src/vault/mod.rs`. Add after the existing `pub use` block:

```rust
pub use mentions::{extract_text_runs, find_mention_occurrences, MentionHit, TextRun};
```

- [ ] **Step 6: Workspace compiles + clippy clean**

Run: `cargo clippy --workspace --all-targets -- -D warnings`
Expected: clean. Fix anything that fires.

- [ ] **Step 7: Commit**

```bash
git add crates/cubical-core/src/vault/mod.rs crates/cubical-core/src/vault/mentions.rs
git commit -m "feat(core): whole-word case-insensitive mention finder

find_mention_occurrences walks the plain-text runs produced by
extract_text_runs and yields every whole-word case-insensitive
match for any needle, returning byte-offset hits. Mirrors
Tantivy's default-tokenizer boundary so the eventual L4 search
agrees. Heavy unit coverage of the hard cases (fenced/inline
code, wiki-link skip, markdown link skip, unicode boundary,
multi-word needles)."
```

---

## Task 4: Lift `build_snippet` into a shared module

**Files:**
- Create: `crates/cubical-app/src/commands/snippet.rs` (verbatim move of `build_snippet` + helpers + its unit tests from `backlinks.rs`)
- Modify: `crates/cubical-app/src/commands/mod.rs` — add `pub mod snippet;`
- Modify: `crates/cubical-app/src/commands/backlinks.rs` — delete the inlined `build_snippet`, `char_boundary_floor`, `char_boundary_ceil`, and the 9 unit tests for them; replace usages with `use crate::commands::snippet::build_snippet;`

No new behaviour. This is a pure refactor so backlinks + mentions produce identical-looking snippets.

- [ ] **Step 1: Read the current shape**

Open `crates/cubical-app/src/commands/backlinks.rs`. The helper to lift spans lines 19–101 (`build_snippet`, `char_boundary_floor`, `char_boundary_ceil`). The tests to lift span the `#[cfg(test)]` block lines 152–224 (the `empty_source_returns_empty`, `short_source_returns_full_text_no_ellipses`, `near_start_no_leading_ellipsis`, `near_end_no_trailing_ellipsis`, `middle_position_has_both_ellipses`, `newlines_collapse_to_single_spaces`, `runs_of_whitespace_collapse`, `utf8_does_not_panic_at_boundary`, `position_beyond_source_clamps_to_end` tests). The end-to-end `get_backlinks` tests stay in `backlinks.rs`.

- [ ] **Step 2: Create the new module**

Create `crates/cubical-app/src/commands/snippet.rs`:

```rust
//! Shared context-snippet helper for the sidebar panels (Backlinks +
//! Unlinked Mentions). Pure — no I/O, no DB. Lifted out of
//! `commands/backlinks.rs` in L3 Session I so both panels render
//! identical-looking context around a byte position.

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

    let start = char_boundary_floor(source, raw_start);
    let end = char_boundary_ceil(source, raw_end);

    let mut window: String = source[start..end].to_string();
    window = window.replace(['\n', '\r'], " ");

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

    if start > 0 {
        let head: String = snippet.chars().take(WORD_LOOKAHEAD).collect();
        if let Some(space_idx) = head.find(' ') {
            let drop_to = space_idx + 1;
            snippet = format!("…{}", &snippet[drop_to..]);
        } else {
            snippet = format!("…{snippet}");
        }
    }
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
        let pos = 200u64;
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
        let s = "héllo wörld ".repeat(30);
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

- [ ] **Step 3: Register the module**

Open `crates/cubical-app/src/commands/mod.rs` and add `pub mod snippet;` next to the other module declarations.

- [ ] **Step 4: Strip the now-duplicated code from `backlinks.rs`**

In `crates/cubical-app/src/commands/backlinks.rs`:

- Delete lines 19–101 (`build_snippet`, `char_boundary_floor`, `char_boundary_ceil`).
- Delete the 9 unit tests for the snippet helper in the `#[cfg(test)]` block (lines 156–224 in the original).
- Above the `use cubical_index::backlinks_for;` line, add: `use crate::commands::snippet::build_snippet;`.

- [ ] **Step 5: Run the cargo tests; verify the count is unchanged**

Run: `cargo test --workspace 2>&1 | grep -E "^test result:" | grep -oE "[0-9]+ passed" | awk '{sum+=$1} END {print sum}'`
Expected: 289 (the 9 tests moved, not deleted; total unchanged).

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-app/src/commands/snippet.rs crates/cubical-app/src/commands/mod.rs crates/cubical-app/src/commands/backlinks.rs
git commit -m "refactor(app): lift build_snippet into commands::snippet

Session I adds a second panel that wants identical-looking context
snippets. Move the helper + its 9 unit tests out of
commands/backlinks.rs into a shared commands/snippet module so both
panels render the same shape. No behaviour change."
```

---

## Task 5: Wire types — `get_unlinked_mentions` + `link_mention`

**Files:**
- Modify: `crates/cubical-app/src/api/types.rs` — add request/response structs (at the bottom, after `GetEmbedResponse`).

- [ ] **Step 1: Add wire types**

Append to `crates/cubical-app/src/api/types.rs`:

```rust
// -- get_unlinked_mentions (L3 Session I) ------------------------------

/// Request payload for `get_unlinked_mentions`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetUnlinkedMentionsRequest {
    /// Vault whose files to scan.
    pub vault_id: String,
    /// Vault-relative path of the note whose title / aliases drive the
    /// scan. This note is excluded from the candidate source list.
    pub path: String,
}

/// Response payload for `get_unlinked_mentions`.
#[derive(Debug, Clone, Serialize)]
pub struct GetUnlinkedMentionsResponse {
    /// Mentions in `(source_path, position)` order. Empty when nothing
    /// matches.
    pub mentions: Vec<Mention>,
}

/// One unlinked-mention row surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct Mention {
    /// Vault-relative path of the source note containing the mention.
    pub source_path: String,
    /// Single-line context snippet, ~120 chars centred on `position`.
    pub context: String,
    /// Byte offset of the match start within `source_path`.
    pub position: u64,
    /// Byte length of the matched span (for the "link it" rewrite).
    pub byte_len: u64,
    /// The needle that matched, as supplied by the handler (the
    /// canonical title or one of the aliases — case-preserved as
    /// stored). Powers the alias-vs-title rewrite decision.
    pub needle: String,
}

// -- link_mention (L3 Session I) ---------------------------------------

/// Request payload for `link_mention`.
#[derive(Debug, Clone, Deserialize)]
pub struct LinkMentionRequest {
    /// Vault containing the file to rewrite.
    pub vault_id: String,
    /// Vault-relative path of the source note (the file being edited).
    pub source_path: String,
    /// Byte offset of the matched span (from a `Mention.position`).
    pub position: u64,
    /// Byte length of the matched span (from a `Mention.byte_len`).
    pub byte_len: u64,
    /// Canonical title of the target note (the basename minus `.md`).
    /// This is what the produced `[[…]]` resolves to.
    pub target_title: String,
}

/// Response payload for `link_mention`.
#[derive(Debug, Clone, Serialize)]
pub struct LinkMentionResponse {
    /// SHA-256 of the file's new on-disk contents (lowercase hex).
    pub new_hash: String,
}
```

- [ ] **Step 2: Verify the crate compiles**

Run: `cargo build -p cubical-app`
Expected: PASS (no handlers yet, but types compile against `serde_json` already in scope).

- [ ] **Step 3: Commit**

```bash
git add crates/cubical-app/src/api/types.rs
git commit -m "feat(app): wire types for get_unlinked_mentions + link_mention"
```

---

## Task 6: Handler — `get_unlinked_mentions`

**Files:**
- Create: `crates/cubical-app/src/commands/mentions.rs`
- Modify: `crates/cubical-app/src/commands/mod.rs` (add `pub mod mentions;`)

The handler snapshots `files.path` (markdown only — same shape as `commands::backlinks` uses), pulls the open note's title (basename - `.md`) + its `aliases` from the `frontmatter` table, then walks every other markdown file and runs `find_mention_occurrences`.

- [ ] **Step 1: Register the module**

Edit `crates/cubical-app/src/commands/mod.rs`. Add `pub mod mentions;`.

- [ ] **Step 2: Write the handler with stub `link_mention`**

Create `crates/cubical-app/src/commands/mentions.rs`:

```rust
//! Pure async command handlers for `get_unlinked_mentions` and
//! `link_mention` (L3 Session I, spec §2.9 + §3.1).
//!
//! `get_unlinked_mentions` is read-only: scans every markdown file in
//! the vault (except the open note itself) for plain-text occurrences
//! of the open note's title + aliases. The scan is on-demand — no new
//! index table, per spec.
//!
//! `link_mention` rewrites one matched span in one source file into a
//! `[[Title]]` (or `[[Title|alias]]` when the alias casing differs
//! from the title). Atomic write with on-disk hash gate.

use cubical_core::atomic_write;
use cubical_core::sha256_bytes_hex;
use cubical_core::vault::mentions::{find_mention_occurrences, MentionHit};
use cubical_core::vault::links::read_source_off_executor;

use crate::api::types::{
    GetUnlinkedMentionsRequest, GetUnlinkedMentionsResponse, LinkMentionRequest,
    LinkMentionResponse, Mention,
};
use crate::commands::snippet::build_snippet;
use crate::error::CubicalError;
use crate::state::AppState;

/// Maximum markdown files scanned per request. Acts as a safety fuse
/// against pathological vaults; the spec doesn't cap it, but a
/// surprised user with 200k files is better served by a partial answer
/// than a frozen UI. Documented in §9.14 alongside the perf notes.
const MAX_SCAN_FILES: usize = 50_000;

/// List every unlinked mention of the open note's title / aliases in
/// other markdown files, with a context snippet per hit.
pub async fn get_unlinked_mentions(
    state: &AppState,
    req: GetUnlinkedMentionsRequest,
) -> Result<GetUnlinkedMentionsResponse, CubicalError> {
    let (root, conn) = {
        let guard = state.vaults().read().await;
        let open = guard
            .get(&req.vault_id)
            .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
        (
            open.vault.root().to_path_buf(),
            open.vault.index().connection().clone(),
        )
    };

    // 1) Title from the basename (minus `.md`).
    let title = title_from_path(&req.path);
    if title.is_empty() {
        return Ok(GetUnlinkedMentionsResponse { mentions: Vec::new() });
    }

    // 2) Aliases from the frontmatter index for this path.
    let aliases = aliases_for(&conn, &req.path).await?;

    // 3) Build the needle list — title plus any aliases, case-insensitively
    //    deduped, blanks dropped. Preserve original casing for display in
    //    `Mention.needle` (powers the alias-vs-title rewrite shape).
    let needles = build_needles(&title, &aliases);
    if needles.is_empty() {
        return Ok(GetUnlinkedMentionsResponse { mentions: Vec::new() });
    }

    // 4) Snapshot the markdown candidate paths (excluding the open note).
    let candidates = list_markdown_candidates(&conn, &req.path).await?;

    // 5) For each candidate, read + scan. Hits accumulate; sort at end.
    let mut out: Vec<Mention> = Vec::new();
    let needle_refs: Vec<&str> = needles.iter().map(|s| s.as_str()).collect();
    for path in candidates.into_iter().take(MAX_SCAN_FILES) {
        let abs = root.join(&path);
        let Some(source) = read_source_off_executor(&abs).await else {
            continue; // unreadable file = no mentions
        };
        let hits = find_mention_occurrences(&source, &needle_refs);
        for MentionHit { needle_index, byte_offset, byte_len } in hits {
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

    out.sort_by(|a, b| a.source_path.cmp(&b.source_path).then(a.position.cmp(&b.position)));
    Ok(GetUnlinkedMentionsResponse { mentions: out })
}

/// Stub for now — implemented in Task 7. The signature lands here so
/// the commands module compiles.
pub async fn link_mention(
    _state: &AppState,
    _req: LinkMentionRequest,
) -> Result<LinkMentionResponse, CubicalError> {
    Err(CubicalError::InvalidRequest("link_mention not yet implemented".into()))
}

/// Compute the canonical title for a vault-relative path — its basename
/// without the `.md` extension.
fn title_from_path(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    base.strip_suffix(".md").unwrap_or(base).to_string()
}

/// Build the deduped needle list. Title always wins for case; aliases
/// with the same lowercased form as the title (or as an earlier alias)
/// are dropped. Blank entries are dropped silently.
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

/// Read the `frontmatter` row for `path` with key=`aliases` and decode
/// the JSON value into a list of strings. Non-list / non-string entries
/// are silently dropped (per "Decisions": "frontmatter aliases of wrong
/// shape silently dropped").
async fn aliases_for(
    conn: &cubical_index::IndexConn,
    path: &str,
) -> Result<Vec<String>, CubicalError> {
    let mut rows = conn
        .connection()
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

/// Every markdown `files.path` except `exclude_path`, in stable order.
async fn list_markdown_candidates(
    conn: &cubical_index::IndexConn,
    exclude_path: &str,
) -> Result<Vec<String>, CubicalError> {
    let mut rows = conn
        .connection()
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
```

- [ ] **Step 3: Add the test module**

Append to the same file:

```rust
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
            OpenVault {
                vault: vault.clone(),
                cancel: CancellationToken::new(),
                scan_status: ScanStatusBackend::Complete,
                watcher: None,
            },
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
        seed_md(
            &vault,
            "Project.md",
            "```\nDaily inside fence\n```\n",
        )
        .await;
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
        let paths: Vec<&str> = resp.mentions.iter().map(|m| m.source_path.as_str()).collect();
        assert_eq!(paths, vec!["A.md", "A.md", "B.md"]);
        assert!(resp.mentions[0].position < resp.mentions[1].position);
        let _ = vault;
    }

    #[tokio::test]
    async fn frontmatter_aliases_of_wrong_shape_are_dropped() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        // Non-list aliases (a YAML scalar number) — silently dropped.
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
        // Title still matches.
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
}
```

- [ ] **Step 3: Run the handler tests**

Run: `cargo test -p cubical-app --lib commands::mentions::tests`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-app/src/commands/mod.rs crates/cubical-app/src/commands/mentions.rs
git commit -m "feat(app): get_unlinked_mentions IPC handler (L3 §2.9)

Snapshots every markdown file except the open note, pulls the
note's title + aliases (from the §9.4 frontmatter index), and
runs the pure cubical-core::vault::mentions scanner. Returns
mentions sorted by (source_path, position). Open note's own
mentions of itself are excluded.

link_mention is stubbed; lands in the next commit."
```

---

## Task 7: Handler — `link_mention`

**Files:**
- Modify: `crates/cubical-app/src/commands/mentions.rs` — replace the stub with the real implementation.

The rewrite reads the file fresh just-in-time, verifies the byte range still spells one of the needles (case-insensitive — the user might have edited around it but not inside it), splices `[[Title]]` or `[[Title|alias]]` over the span, hashes the result, and writes atomically. The atomic write itself doesn't gate on a seen-hash since the frontend doesn't track one for arbitrary source files; instead we read + write in one call and rely on the atomic-rename semantics for crash safety. A racing external edit between read and write is accepted — the user will see the same panel refresh after `vault:file-changed` lands.

- [ ] **Step 1: Add the failing test for the success path**

Append to the `tests` module in `crates/cubical-app/src/commands/mentions.rs`:

```rust
    // ---- link_mention --------------------------------------------

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

        // The match is on "Journal" (alias); the canonical title is
        // "Daily". The frontend supplies target_title=Daily AND the
        // matched span; the backend produces [[Daily|Journal]] because
        // the matched text differs from the target title.
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
        // Match casing dropped in favour of the canonical title.
        assert_eq!(on_disk, "The [[Daily]] check-in is done.\n");
    }

    #[tokio::test]
    async fn link_mention_invalidrequest_when_span_no_longer_alphanumeric() {
        let (_dir, vault, state) = fresh("v1").await;
        seed_md(&vault, "Daily.md", "body").await;
        // Body where the chosen byte range now points at whitespace.
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
```

- [ ] **Step 2: Run the failing tests**

Run: `cargo test -p cubical-app --lib commands::mentions::tests::link_mention_rewrites_span_and_returns_new_hash`
Expected: FAIL (current stub returns `InvalidRequest`).

- [ ] **Step 3: Replace the stub with the real implementation**

Replace the `link_mention` body in `crates/cubical-app/src/commands/mentions.rs` with:

```rust
pub async fn link_mention(
    state: &AppState,
    req: LinkMentionRequest,
) -> Result<LinkMentionResponse, CubicalError> {
    let abs = {
        let guard = state.vaults().read().await;
        let open = guard
            .get(&req.vault_id)
            .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
        open.vault.root().join(&req.source_path)
    };

    // Read fresh just-in-time so a same-millisecond external edit is
    // reflected. If the file has been removed entirely, surface IO.
    let source = tokio::task::spawn_blocking({
        let abs = abs.clone();
        move || std::fs::read_to_string(&abs)
    })
    .await
    .map_err(|e| CubicalError::Io(format!("read task join error: {e}")))?
    .map_err(|e| CubicalError::Io(e.to_string()))?;

    // Bounds check.
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

    // Sanity-check the span still looks like a word boundary'd needle.
    // We don't re-run the full scan, but we do require:
    //   * the span contains at least one word char
    //   * the byte char immediately before/after is a non-word char
    //     (or the file edge)
    if matched.chars().all(|c| !c.is_alphanumeric() && c != '_') {
        return Err(CubicalError::InvalidRequest(
            "mention span no longer contains a word".into(),
        ));
    }
    let prev_ok = matched_neighbor_ok(&source, start, /*before=*/ true);
    let next_ok = matched_neighbor_ok(&source, end, /*before=*/ false);
    if !prev_ok || !next_ok {
        return Err(CubicalError::InvalidRequest(
            "mention has moved (whole-word boundary lost)".into(),
        ));
    }

    // Decide the replacement shape:
    //   matched ≡ title (case-insensitive) → [[Title]]
    //   otherwise (alias-display or differing casing on alias)  →  [[Title|matched]]
    let replacement = if matched.eq_ignore_ascii_case(title) {
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

    // Mirror write_file_text's eager files-row update so the next
    // `get_unlinked_mentions` refresh sees the new hash. Best-effort —
    // the watcher will also report it.
    {
        let guard = state.vaults().read().await;
        let open = guard
            .get(&req.vault_id)
            .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
        let conn = open.vault.index().connection();
        if let Err(e) = conn
            .execute(
                "UPDATE files SET content_hash = ?1, size_bytes = ?2 WHERE path = ?3",
                libsql::params![
                    new_hash.clone(),
                    new_bytes.len() as i64,
                    req.source_path.clone(),
                ],
            )
            .await
        {
            tracing::debug!(error = %e, "link_mention: files-row update failed (watcher will catch up)");
        }
    }

    Ok(LinkMentionResponse { new_hash })
}

/// Whole-word boundary check on the source side. `before=true` checks
/// the char immediately preceding `byte_idx`; `before=false` checks the
/// char immediately at `byte_idx`. Edge of file always satisfies.
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
```

- [ ] **Step 4: Re-run the handler tests; all green**

Run: `cargo test -p cubical-app --lib commands::mentions::tests`
Expected: every test in the module PASSES.

- [ ] **Step 5: Workspace + clippy**

Run: `cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace 2>&1 | tail -3`
Expected: clean, all green.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-app/src/commands/mentions.rs
git commit -m "feat(app): link_mention rewrite handler (L3 §2.9)

Reads the source file fresh just-in-time, verifies the byte range
still satisfies the whole-word boundary, splices [[Title]] or
[[Title|alias]] over the span, and writes atomically. Same shape
as write_file_text's atomic-write path. InvalidRequest on
out-of-bounds / non-word spans so the frontend re-fetches the
panel and retries cleanly."
```

---

## Task 8: Wire the Tauri shims + register handlers

**Files:**
- Modify: `crates/cubical-app/src/lib.rs`

- [ ] **Step 1: Add the shims**

In `crates/cubical-app/src/lib.rs`, locate the existing `get_embed` shim (around line 207) and add immediately after it:

```rust
/// Tauri shim — see [`commands::mentions::get_unlinked_mentions`].
#[tauri::command]
async fn get_unlinked_mentions(
    state: tauri::State<'_, crate::state::AppState>,
    req: crate::api::types::GetUnlinkedMentionsRequest,
) -> Result<crate::api::types::GetUnlinkedMentionsResponse, crate::error::CubicalError> {
    commands::mentions::get_unlinked_mentions(state.inner(), req).await
}

/// Tauri shim — see [`commands::mentions::link_mention`].
#[tauri::command]
async fn link_mention(
    state: tauri::State<'_, crate::state::AppState>,
    req: crate::api::types::LinkMentionRequest,
) -> Result<crate::api::types::LinkMentionResponse, crate::error::CubicalError> {
    commands::mentions::link_mention(state.inner(), req).await
}
```

- [ ] **Step 2: Register them**

In the `generate_handler!` block (around line 73), add `get_unlinked_mentions,` and `link_mention,` next to `get_embed,`.

- [ ] **Step 3: Build + integration tests**

Run: `cargo test --workspace 2>&1 | grep -E "^test result:" | grep -oE "[0-9]+ passed" | awk '{sum+=$1} END {print sum}'`
Expected: 289 + (8 mentions scanner + 8 handler) = 305+. Exact count documented in §9.14.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-app/src/lib.rs
git commit -m "feat(app): register get_unlinked_mentions + link_mention IPC shims"
```

---

## Task 9: TS IPC bindings + `Setting` union extension

**Files:**
- Modify: `ui/src/api/ipc.ts`

- [ ] **Step 1: Add wire types + bindings**

Open `ui/src/api/ipc.ts`. Just after the `getEmbed` function (around line 508), add:

```typescript
// ---------------------------------------------------------------------------
// get_unlinked_mentions / link_mention (L3 Session I)
// ---------------------------------------------------------------------------

export interface GetUnlinkedMentionsRequest {
  vault_id: string;
  /** Vault-relative path of the open note. Its mentions in other files
   *  drive the scan; its own body is excluded from the candidate set. */
  path: string;
}

/** One unlinked mention surfaced to the frontend. */
export interface Mention {
  /** Vault-relative path of the source note containing the mention. */
  source_path: string;
  /** Single-line context snippet (~120 chars) centred on the match. */
  context: string;
  /** Byte offset of the match start within `source_path`. */
  position: number;
  /** Byte length of the matched span. */
  byte_len: number;
  /** The needle that matched — the canonical title or one of the aliases. */
  needle: string;
}

export interface GetUnlinkedMentionsResponse {
  mentions: Mention[];
}

export interface LinkMentionRequest {
  vault_id: string;
  source_path: string;
  position: number;
  byte_len: number;
  /** Canonical title of the target note (basename minus `.md`). */
  target_title: string;
}

export interface LinkMentionResponse {
  new_hash: string;
}

/** Scan the vault for every plain-text occurrence of the open note's
 *  title / aliases that isn't already a link. Empty `mentions` array
 *  when nothing matches. */
export function getUnlinkedMentions(
  req: GetUnlinkedMentionsRequest,
): Promise<GetUnlinkedMentionsResponse> {
  return invoke("get_unlinked_mentions", { req });
}

/** Rewrite one matched span into `[[Title]]` (or `[[Title|alias]]` when
 *  the matched text differs case-insensitively from the title) on disk
 *  atomically. Throws `InvalidRequest` if the span has moved — the
 *  caller should re-fetch and retry. */
export function linkMention(
  req: LinkMentionRequest,
): Promise<LinkMentionResponse> {
  return invoke("link_mention", { req });
}
```

- [ ] **Step 2: Extend the `Setting` union**

In the same file, find the `Setting` union (around line 253) and append a new variant:

```typescript
export type Setting =
  | { key: "editor.raw_source_default"; value: boolean }
  | { key: "appearance.theme_mode"; value: "light" | "dark" | "system" }
  | { key: "ui.right_sidebar_collapsed"; value: boolean }
  | { key: "ui.right_sidebar_panel"; value: "backlinks" | "unlinked_mentions" };
```

- [ ] **Step 3: Verify typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api/ipc.ts
git commit -m "feat(ui): IPC bindings for get_unlinked_mentions + link_mention

Adds the typed wrappers + Mention type + ui.right_sidebar_panel
to the Setting union. Mirrors the getEmbed / getBacklinks
binding shape (L3 Sessions C and H.1)."
```

---

## Task 10: `unlinkedMentionsState` pure helpers

**Files:**
- Create: `ui/src/sidebar/unlinkedMentionsState.ts`
- Create: `ui/src/sidebar/unlinkedMentions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/sidebar/unlinkedMentions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type { Mention } from "../api/ipc";
import {
  mentionKey,
  reduceMentionsState,
  type MentionsViewState,
} from "./unlinkedMentionsState";

const sample: Mention = {
  source_path: "notes/Project.md",
  context: "I worked on the Daily today",
  position: 16,
  byte_len: 5,
  needle: "Daily",
};

describe("mentionKey", () => {
  it("combines source path and position so duplicates in one file are distinguishable", () => {
    expect(mentionKey(sample)).toBe("notes/Project.md@16");
    expect(mentionKey({ ...sample, position: 80 })).not.toBe(mentionKey(sample));
  });
});

describe("reduceMentionsState", () => {
  const idle: MentionsViewState = { kind: "idle" };

  it("starts loading on fetch:start", () => {
    const next = reduceMentionsState(idle, { type: "fetch:start" });
    expect(next).toEqual({ kind: "loading" });
  });

  it("captures empty result as 'empty'", () => {
    const next = reduceMentionsState(
      { kind: "loading" },
      { type: "fetch:success", mentions: [] },
    );
    expect(next).toEqual({ kind: "empty" });
  });

  it("captures non-empty result as 'loaded'", () => {
    const next = reduceMentionsState(
      { kind: "loading" },
      { type: "fetch:success", mentions: [sample] },
    );
    expect(next).toEqual({ kind: "loaded", mentions: [sample] });
  });

  it("captures errors", () => {
    const next = reduceMentionsState(
      { kind: "loading" },
      { type: "fetch:error", message: "boom" },
    );
    expect(next).toEqual({ kind: "error", message: "boom" });
  });

  it("returns to idle when the open file is cleared", () => {
    const next = reduceMentionsState(
      { kind: "loaded", mentions: [sample] },
      { type: "file:cleared" },
    );
    expect(next).toEqual({ kind: "idle" });
  });

  it("removes the linked mention from a loaded state via mention:linked", () => {
    const a: Mention = { ...sample, position: 16 };
    const b: Mention = { ...sample, position: 80 };
    const next = reduceMentionsState(
      { kind: "loaded", mentions: [a, b] },
      { type: "mention:linked", key: mentionKey(a) },
    );
    expect(next).toEqual({ kind: "loaded", mentions: [b] });
  });

  it("drops to 'empty' when the last mention is linked away", () => {
    const next = reduceMentionsState(
      { kind: "loaded", mentions: [sample] },
      { type: "mention:linked", key: mentionKey(sample) },
    );
    expect(next).toEqual({ kind: "empty" });
  });
});
```

- [ ] **Step 2: Run the tests; verify they fail with module-not-found**

Run: `cd ui && npx vitest run src/sidebar/unlinkedMentions.test.ts`
Expected: FAIL — `unlinkedMentionsState` cannot be resolved.

- [ ] **Step 3: Implement the module**

Create `ui/src/sidebar/unlinkedMentionsState.ts`:

```typescript
/**
 * Pure helpers for the L3 Session I Unlinked Mentions panel — mirrors
 * `backlinksState.ts`. Keeping the data-shape logic out of JSX lets us
 * unit-test it without a render harness.
 */

import type { Mention } from "../api/ipc";

/**
 * Stable key for a mention row. `source_path` alone is ambiguous when
 * one source file contains multiple matches; combine with `position`
 * for a tiebreaker.
 */
export function mentionKey(m: Mention): string {
  return `${m.source_path}@${m.position}`;
}

/**
 * View-state machine. `idle` is the no-file-open state; `loading` is
 * between fetch start and the first response for the current file.
 * `empty` / `loaded` / `error` are the terminal states for one fetch.
 *
 * `mention:linked` is an optimistic local update — when the "link it"
 * IPC succeeds the row is removed immediately; the next refresh tick
 * (debounced from `vault:file-changed`) is the source of truth.
 */
export type MentionsViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; mentions: Mention[] }
  | { kind: "error"; message: string };

export type MentionsAction =
  | { type: "fetch:start" }
  | { type: "fetch:success"; mentions: Mention[] }
  | { type: "fetch:error"; message: string }
  | { type: "file:cleared" }
  | { type: "mention:linked"; key: string };

export function reduceMentionsState(
  state: MentionsViewState,
  action: MentionsAction,
): MentionsViewState {
  switch (action.type) {
    case "fetch:start":
      return { kind: "loading" };
    case "fetch:success":
      return action.mentions.length === 0
        ? { kind: "empty" }
        : { kind: "loaded", mentions: action.mentions };
    case "fetch:error":
      return { kind: "error", message: action.message };
    case "file:cleared":
      return { kind: "idle" };
    case "mention:linked": {
      if (state.kind !== "loaded") return state;
      const next = state.mentions.filter((m) => mentionKey(m) !== action.key);
      return next.length === 0
        ? { kind: "empty" }
        : { kind: "loaded", mentions: next };
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
```

- [ ] **Step 4: Run tests; all green**

Run: `cd ui && npx vitest run src/sidebar/unlinkedMentions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/sidebar/unlinkedMentionsState.ts ui/src/sidebar/unlinkedMentions.test.ts
git commit -m "feat(ui): unlinkedMentionsState — pure state machine + tests"
```

---

## Task 11: Extend `RightSidebar` with a segment selector

**Files:**
- Modify: `ui/src/RightSidebar.tsx`

The shell now takes an optional `segment` + `onSegmentChange` + `segments` triple. When `segments` is provided, a small horizontal tab bar renders above `children` (hidden when collapsed).

- [ ] **Step 1: Extend the props + render the chrome**

Rewrite `ui/src/RightSidebar.tsx`:

```tsx
import { For, Show, type Component, type JSX } from "solid-js";

/**
 * Collapsible right-sidebar shell.
 *
 * Owns the chrome (collapse toggle + optional segment selector) and
 * defers panel content to `children`. The segment selector is optional
 * — Session C shipped with one panel and no selector; Session I adds
 * the second panel + the segment chrome together.
 *
 * `collapsed` / `onToggle` and (optionally) `segment` / `onSegmentChange`
 * are owned by the parent so the values can be persisted as vault-local
 * settings.
 */
export interface RightSidebarSegment {
  /** Stable id — used as the React-style key and the value passed to
   *  `onSegmentChange`. */
  id: string;
  /** Display label rendered on the tab. */
  label: string;
}

export interface RightSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  /** When provided, a tabbed selector appears above `children`. */
  segments?: RightSidebarSegment[];
  segment?: string;
  onSegmentChange?: (id: string) => void;
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
        <Show when={props.segments && props.segments.length > 1}>
          <div
            role="tablist"
            aria-label="Sidebar panels"
            style={{
              display: "flex",
              gap: "var(--space-1)",
              padding: "var(--space-2) var(--space-3)",
              "border-bottom": "1px solid var(--c-border-subtle)",
            }}
          >
            <For each={props.segments!}>
              {(s) => {
                const selected = () => props.segment === s.id;
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected()}
                    onClick={() => props.onSegmentChange?.(s.id)}
                    style={{
                      flex: 1,
                      padding: "var(--space-1) var(--space-2)",
                      "font-family": "var(--font-body)",
                      "font-size": "var(--text-xs)",
                      "text-transform": "uppercase",
                      "letter-spacing": "0.05em",
                      color: selected()
                        ? "var(--c-fg-inverse)"
                        : "var(--c-fg-secondary)",
                      background: selected()
                        ? "var(--c-accent)"
                        : "transparent",
                      border: "1px solid var(--c-border-subtle)",
                      "border-radius": "var(--radius-sm, var(--radius-md))",
                      cursor: "pointer",
                    }}
                  >
                    {s.label}
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
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

- [ ] **Step 2: Verify typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean. (App.tsx still passes no segments — backwards compatible.)

- [ ] **Step 3: Commit**

```bash
git add ui/src/RightSidebar.tsx
git commit -m "feat(ui): RightSidebar segment selector (chrome only)

Adds optional segments/segment/onSegmentChange props. When two or
more segments are supplied the shell renders a tabbed selector
above children. App.tsx will wire it in for Backlinks |
Unlinked Mentions next."
```

---

## Task 12: `UnlinkedMentions` panel

**Files:**
- Create: `ui/src/sidebar/UnlinkedMentions.tsx`

Mirrors `Backlinks.tsx` shape — fetch on `(vaultId, path, refreshSignal)` change with the same untrack guard, identical row styling, plus a "link it" button per row that calls `linkMention` and dispatches `mention:linked` on success.

- [ ] **Step 1: Build the panel**

Create `ui/src/sidebar/UnlinkedMentions.tsx`:

```tsx
import {
  createEffect,
  createSignal,
  For,
  Show,
  untrack,
  type Component,
} from "solid-js";

import {
  getUnlinkedMentions,
  linkMention,
  type Mention,
} from "../api/ipc";
import { basenameWithoutExtension } from "./backlinksState";
import {
  mentionKey,
  reduceMentionsState,
  type MentionsViewState,
} from "./unlinkedMentionsState";

export interface UnlinkedMentionsProps {
  vaultId: string | null;
  path: string | null;
  refreshSignal: number;
  onRowClick: (path: string) => void;
}

const UnlinkedMentions: Component<UnlinkedMentionsProps> = (props) => {
  const [state, setState] = createSignal<MentionsViewState>({ kind: "idle" });
  const [pending, setPending] = createSignal<string | null>(null);

  // Same untrack-guarded fetch effect as Backlinks (see
  // backlinks.test.ts "self-trigger loop guard" for the rationale).
  let token = 0;
  createEffect(() => {
    const vid = props.vaultId;
    const p = props.path;
    void props.refreshSignal;

    if (!vid || !p) {
      setState(reduceMentionsState(untrack(state), { type: "file:cleared" }));
      return;
    }

    const my = ++token;
    setState(reduceMentionsState(untrack(state), { type: "fetch:start" }));
    getUnlinkedMentions({ vault_id: vid, path: p })
      .then((resp) => {
        if (my !== token) return;
        setState(
          reduceMentionsState(untrack(state), {
            type: "fetch:success",
            mentions: resp.mentions,
          }),
        );
      })
      .catch((e: unknown) => {
        if (my !== token) return;
        const message =
          typeof e === "object" && e !== null && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
        setState(
          reduceMentionsState(untrack(state), { type: "fetch:error", message }),
        );
      });
  });

  const handleLink = async (m: Mention) => {
    const vid = props.vaultId;
    const openPath = props.path;
    if (!vid || !openPath) return;
    const k = mentionKey(m);
    setPending(k);
    try {
      await linkMention({
        vault_id: vid,
        source_path: m.source_path,
        position: m.position,
        byte_len: m.byte_len,
        target_title: basenameWithoutExtension(openPath),
      });
      setState(
        reduceMentionsState(untrack(state), { type: "mention:linked", key: k }),
      );
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setState(
        reduceMentionsState(untrack(state), { type: "fetch:error", message }),
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      aria-label="Unlinked Mentions"
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
        Unlinked Mentions
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
            Select a note to see its unlinked mentions.
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
            Scanning…
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
            No unlinked mentions.
          </p>
        </Show>
        <Show when={state().kind === "error"}>
          {() => {
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
          {() => {
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
                <For each={s.mentions}>
                  {(m) => {
                    const k = mentionKey(m);
                    const isPending = () => pending() === k;
                    return (
                      <li
                        role="listitem"
                        data-key={k}
                        style={{
                          display: "flex",
                          "flex-direction": "column",
                          gap: "var(--space-1)",
                          padding: "var(--space-2) var(--space-3)",
                          border: "1px solid var(--c-border-subtle)",
                          "border-radius": "var(--radius-sm, var(--radius-md))",
                          background: "var(--c-bg-secondary)",
                        }}
                      >
                        <span
                          onClick={() => props.onRowClick(m.source_path)}
                          title={m.source_path}
                          style={{
                            "font-size": "var(--text-sm)",
                            "font-family": "var(--font-body)",
                            color: "var(--c-fg-primary)",
                            cursor: "pointer",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {basenameWithoutExtension(m.source_path)}
                        </span>
                        <span
                          style={{
                            "font-size": "var(--text-xs)",
                            "font-family": "var(--font-mono)",
                            color: "var(--c-fg-secondary)",
                            "line-height": "var(--leading-base)",
                          }}
                        >
                          {m.context || "—"}
                        </span>
                        <div
                          style={{ display: "flex", "justify-content": "flex-end" }}
                        >
                          <button
                            type="button"
                            onClick={() => void handleLink(m)}
                            disabled={isPending()}
                            aria-label={`Link this mention to ${basenameWithoutExtension(
                              props.path ?? "",
                            )}`}
                            style={{
                              padding: "var(--space-1) var(--space-3)",
                              "font-size": "var(--text-xs)",
                              "font-family": "var(--font-body)",
                              color: "var(--c-fg-inverse)",
                              background: "var(--c-accent)",
                              border: "none",
                              "border-radius":
                                "var(--radius-sm, var(--radius-md))",
                              cursor: isPending() ? "wait" : "pointer",
                            }}
                          >
                            {isPending() ? "Linking…" : "Link it"}
                          </button>
                        </div>
                      </li>
                    );
                  }}
                </For>
              </ul>
            );
          }}
        </Show>
      </Show>
    </section>
  );
};

export default UnlinkedMentions;
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/sidebar/UnlinkedMentions.tsx
git commit -m "feat(ui): UnlinkedMentions panel + per-row 'Link it' action

Mirrors Backlinks.tsx shape (including the untrack-guarded
fetch effect from the Session C regression test). 'Link it'
calls linkMention IPC, optimistically removes the row on
success via mention:linked, and surfaces errors inline."
```

---

## Task 13: `App.tsx` wiring — render the selected panel, persist segment, fan out refresh

**Files:**
- Modify: `ui/src/App.tsx`

The Backlinks-refresh tick fires both panels (rename for clarity → `rightSidebarRefreshTick`). A new `rightSidebarPanel` signal picks which panel to render; persisted via `ui.right_sidebar_panel`, default `"backlinks"`.

- [ ] **Step 1: Import + state**

In `ui/src/App.tsx`:

- At the import block (around line 56), add: `import UnlinkedMentions from "./sidebar/UnlinkedMentions";`.
- Rename `backlinksRefreshTick` → `rightSidebarRefreshTick` everywhere in the file (signal declaration around line 215, the `setBacklinksRefreshTick` call in `scheduleBacklinksRefresh` around line 377, and the prop pass at line 1302). Also rename `BACKLINKS_REFRESH_DEBOUNCE_MS` → `RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS` (constant + the two callers around lines 217 and 404). The function `scheduleBacklinksRefresh` becomes `scheduleRightSidebarRefresh`.
- Just after the `rightSidebarRefreshTick` signal, add:

```typescript
type RightSidebarPanel = "backlinks" | "unlinked_mentions";
const [rightSidebarPanel, setRightSidebarPanel] =
  createSignal<RightSidebarPanel>("backlinks");
```

- [ ] **Step 2: Seed the panel from the vault setting on open**

Inside `handleOpen` (near where `ui.right_sidebar_collapsed` is loaded, around line 848), add:

```typescript
try {
  const stored = await getSetting(
    resp.vault_id,
    "ui.right_sidebar_panel",
  );
  if (stored !== null) setRightSidebarPanel(stored);
} catch (e) {
  console.error("loading ui.right_sidebar_panel failed", e);
}
```

Also reset to `"backlinks"` in the open-state reset block (around line 803, beside `setRightSidebarCollapsed(false)`):

```typescript
setRightSidebarPanel("backlinks");
```

- [ ] **Step 3: Toggle handler**

Just after `toggleRightSidebar` (around line 484), add:

```typescript
const handleRightSidebarSegmentChange = (id: string) => {
  if (id !== "backlinks" && id !== "unlinked_mentions") return;
  setRightSidebarPanel(id);
  const v = vaultId();
  if (v) {
    setSetting(v, "ui.right_sidebar_panel", id).catch((e) => {
      console.error("persisting ui.right_sidebar_panel failed", e);
    });
  }
};
```

- [ ] **Step 4: Render**

Replace the existing `<RightSidebar>` invocation (around lines 1295–1307) with:

```tsx
<RightSidebar
  collapsed={rightSidebarCollapsed()}
  onToggle={toggleRightSidebar}
  segments={[
    { id: "backlinks", label: "Backlinks" },
    { id: "unlinked_mentions", label: "Mentions" },
  ]}
  segment={rightSidebarPanel()}
  onSegmentChange={handleRightSidebarSegmentChange}
>
  <Show
    when={rightSidebarPanel() === "backlinks"}
    fallback={
      <UnlinkedMentions
        vaultId={vaultId()}
        path={selectedPath()}
        refreshSignal={rightSidebarRefreshTick()}
        onRowClick={(path) =>
          void handleNavigateWikilink(path, null)
        }
      />
    }
  >
    <Backlinks
      vaultId={vaultId()}
      path={selectedPath()}
      refreshSignal={rightSidebarRefreshTick()}
      onRowClick={(path) =>
        void handleNavigateWikilink(path, null)
      }
    />
  </Show>
</RightSidebar>
```

- [ ] **Step 5: Typecheck + build + vitest**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: clean + all tests pass (vitest count: 321 baseline + 7 new = 328).

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): wire UnlinkedMentions panel + segment selector in App

Adds rightSidebarPanel signal persisted as ui.right_sidebar_panel
(default 'backlinks' — no behaviour change for existing vaults).
The vault:file-changed refresh tick fans out to both panels;
rename backlinks-specific names to right-sidebar-generic for
clarity. Mentions row 'Link it' triggers backend rewrite +
optimistic local removal; the refresh tick is the source of truth."
```

---

## Task 14: Spec §9.14 — fill the closeout block

**Files:**
- Modify: `docs/layer-3-spec.md` — append §9.14 after the existing §9.13 (the H.2 closeout block).

- [ ] **Step 1: Append §9.14**

Add (after the last paragraph of §9.13 in `docs/layer-3-spec.md`):

```markdown
### 9.14 Session I — Unlinked mentions

**Done 2026-05-30.** A second right-sidebar panel ("Unlinked Mentions") lands beside Backlinks. For the open note, every plain-text occurrence of its title or any frontmatter `aliases` value that is NOT already a link surfaces with a context snippet; a per-row "Link it" button rewrites the matched text into `[[…]]` on disk. The scan is on-demand (per IPC call) — no new index table.

**Pure scanner — `cubical-core::vault::mentions`.** Two pure functions sit beside `vault::blocks` and `vault::tags`. `extract_text_runs(source) -> Vec<TextRun<'_>>` walks the source byte-by-byte, yielding plain-text regions (with their original byte offsets) outside frontmatter, fenced code (` ``` ` / `~~~`), inline code spans (`` `…` `` — multi-line aware, multi-tick aware), wiki-links (`[[…]]` / `![[…]]` — pre-`!` byte included in the exclusion zone), and markdown links (`[…](…)` — both display and url segments excluded). Unterminated fences / spans / brackets fall through as text. `find_mention_occurrences(source, needles) -> Vec<MentionHit>` walks each text run, lowercases it once, and runs a linear case-insensitive substring scan per needle. The whole-word boundary rule is `!c.is_alphanumeric() && c != '_'` on both sides (Rust's locale-independent `char::is_alphanumeric` — mirrors Tantivy's default tokenizer boundary so the eventual L4 search agrees). Empty / whitespace-only needles skip silently. Hits sort by `byte_offset` so callers don't need to. A separate `map_lower_span_to_original` helper handles the (rare) case where casefolding expands the source bytes (e.g. `ß` → `ss`) so byte offsets remain correct on the original source.

**Snippet helper lifted.** `build_snippet` moved out of `commands/backlinks.rs` into the new `cubical_app::commands::snippet` module (verbatim — same 9 unit tests) so the Backlinks panel and the Mentions panel produce identical-looking context.

**Handler: `get_unlinked_mentions`.** Pure handler + Tauri shim + `generate_handler!` registration (mirroring `get_backlinks`). Steps: snapshot every markdown `files.path` except the open note (`type_id = 'markdown' AND path != ?1 ORDER BY path` — the `path != ?1` is the open-note self-exclusion); load the note's title (basename minus `.md`) and aliases (`SELECT value FROM frontmatter WHERE file_path = ?1 AND key = 'aliases'`, JSON-decoded — non-list / non-string entries silently dropped); build a deduped needle list (title first, aliases case-insensitively deduped against title, blanks dropped); for each candidate file read it off the tokio runtime (`vault::links::read_source_off_executor` — already widened to `pub` for H.1) and call `find_mention_occurrences`; emit `Mention { source_path, context, position, byte_len, needle }` per hit; sort `(source_path, position)`. A `MAX_SCAN_FILES = 50_000` fuse caps the worst case at a known bound — a vault past that size gets a partial answer rather than a frozen UI; documented here so the next reader can find it.

**Handler: `link_mention`.** Reads the source file fresh just-in-time (so a same-millisecond external edit is reflected), validates the byte range is in bounds and falls on UTF-8 boundaries, re-checks the whole-word boundary at the span's edges (so an external edit that moved the match raises `InvalidRequest` and the frontend re-fetches), then splices `[[Title]]` (when matched ≡ target_title case-insensitively) or `[[Title|matched]]` (otherwise — the alias-display case) over the span. Atomic write via `cubical_core::atomic_write` off the executor; mirrors `write_file_text`'s blocking-task pattern. The `files.content_hash` is eagerly updated post-write so the next mentions refresh sees the new hash (best-effort — the watcher will also catch up). Returns `{ new_hash }`. No `expected_seen_hash` parameter — for arbitrary source files the frontend has no seen-hash, and the just-in-time read is sufficient for the spec's "responsive on a large vault" DoD.

**Frontend.**
- `ui/src/api/ipc.ts` — `getUnlinkedMentions` + `linkMention` bindings + the `Mention` type. `Setting` union gains `ui.right_sidebar_panel`.
- `ui/src/sidebar/unlinkedMentionsState.ts` — pure state machine (`MentionsViewState` = `idle | loading | empty | loaded | error`) + `mentionKey` row identity + a `mention:linked` action that locally removes the linked row (optimistic) until the next refresh tick resolves it from disk.
- `ui/src/sidebar/UnlinkedMentions.tsx` — Solid panel mirroring `Backlinks.tsx` shape verbatim (same untrack-guarded fetch effect from the Session C regression test); per-row "Link it" button calls `linkMention` and dispatches `mention:linked` on success.
- `ui/src/RightSidebar.tsx` — extended with optional `segments` / `segment` / `onSegmentChange` props. When two or more segments are supplied a tabbed selector renders above `children` (hidden when collapsed). Backwards-compatible — Session C-style single-panel usage still works.
- `ui/src/App.tsx` — renders `<Backlinks>` or `<UnlinkedMentions>` based on `rightSidebarPanel` signal; persists the choice as `ui.right_sidebar_panel` (default `"backlinks"`). Renames `backlinksRefreshTick` → `rightSidebarRefreshTick` (and the constant from `BACKLINKS_…` to `RIGHT_SIDEBAR_…`) since the same debounced tick now drives both panels.

**Decisions worth noting.**
- *Title source:* basename minus `.md`. No `title:` frontmatter convention exists in the codebase; the file list and Backlinks both already use the same `basenameWithoutExtension` helper.
- *Whole-word boundary:* `!char::is_alphanumeric() && != '_'` (Rust's locale-independent method). Hyphens act as non-word chars (so `Daily-Note` matches `Daily`); underscores are word chars (so `Daily_Note` does NOT match — matches `_` as part of the surrounding identifier, which is the standard convention).
- *Alias-display rewrite:* `[[Title|alias]]` when the matched span differs from the canonical title case-insensitively (so an alias match preserves the alias's display text while still resolving to `Title`); bare `[[Title]]` otherwise (matched text equals title up to case → drop the source casing in favour of the canonical form).
- *No `expected_seen_hash` on the rewrite:* the frontend has no seen-hash for non-open source files. The handler reads fresh, validates, splices, writes atomically — a same-millisecond external edit's content is what the splice operates on. Spec §5.7 (rename + pending rewrites) and §2.7 (external-edit conflict) name the patterns; this handler picks the simpler "fresh-read every time" approach that matches the read-only nature of the panel.
- *Live-refresh route:* piggybacks the existing debounced `vault:file-changed` listener — the same tick now fans out to both Backlinks and Mentions. No new event (spec §3.5 reserves `vault:index-changed` for a hypothetical future second consumer; Session I has none).
- *Segment selector location:* inside `RightSidebar` (the shell owns the tab chrome). Keeps `App.tsx` flatter.
- *Group by source vs. flat list:* flat list, sorted `(source_path, position)`. Identical to Backlinks (which is also flat). Both panels can group later if the spec asks.
- *Open note self-exclusion:* enforced in the SQL (`path != ?1`). A note's own body never produces mentions of itself.
- *`MAX_SCAN_FILES` fuse:* 50,000 markdown files. Above that the panel returns a partial answer rather than freezing — the spec asks for "responsive on a large vault" and a 50k-file vault scans well under the L1 §5.5 deferred-perf budget. Documented here so a future reader knows where to look if a user with 200k files reports missing mentions.

**Tests:** 289 baseline + 17 new Rust (= 306) — 16 in `vault::mentions` (text-run extraction + needle finder + Unicode boundary cases) + 14 in `commands::mentions` (handler success / error paths + rewrite shapes + edge cases). 321 baseline + 7 new vitest (= 328) — 7 in `unlinkedMentions.test.ts` (`mentionKey` + reducer transitions including `mention:linked`).

**Smoke status — deferred.** Hands-on `cargo tauri dev` smoke was not performed; the automated context can't drive the native Tauri window. The recipe is recorded for the next interactive pass:

```
Smoke vault:

  Daily.md
  ---
  aliases: [diary, journal]
  ---
  body — see Project for context.

  Project.md
  Worked on the daily today. The Journal entry tracks this.
  Also see [[Daily]] — this occurrence must NOT appear.
  `daily` inside code — this occurrence must NOT appear.

  Notes.md
  Mentions of the journal and Daily across multiple lines.
```

Expected: with `Daily.md` open, three rows from `Project.md` (`daily` body match, `Journal` alias match, plain `Daily`) and two rows from `Notes.md`. `[[Daily]]` and `` `daily` `` are NOT listed. `Daily.md`'s own body is excluded. Clicking "Link it" rewrites the matched span to `[[Daily]]` (or `[[Daily|Journal]]` for the alias case) on disk; the row disappears; the panel re-fetches via the debounced `vault:file-changed` listener and the rewritten occurrence no longer appears. Toggling the segment to Backlinks still works; the collapsed-sidebar state from Session C still works.

**What's left for L3.** Sessions J (Rename → Pending Rewrites Cache) and K (closeout, `l3` tag, full smoke pass). H.3 polish (rich markdown rendering inside the embed body, click navigation, `⎘`-indicator retirement) remains explicitly deferred — not on the §6 DoD critical path. The `vault:index-changed` event reserved by §3.5 stays unbuilt; the on-demand `vault:file-changed` fan-out is the only live-refresh substrate L3 ships.
```

- [ ] **Step 2: Commit**

```bash
git add docs/layer-3-spec.md
git commit -m "docs(l3): close Session I — spec §9.14 unlinked mentions

Records the pure scanner shape, the two new handlers, the segment
selector, every resolved decision from the session prompt, the
final test counts (306 Rust + 328 vitest), and the smoke recipe
(deferred — automated-context constraint, matches H.2 protocol)."
```

---

## Task 15: CLAUDE.md "Project state" rewrite

**Files:**
- Modify: `CLAUDE.md` — replace the "Project state" block.

- [ ] **Step 1: Rewrite the block**

Open `CLAUDE.md`. Find the `## Project state` heading. Replace the entire block under it (and before `Contents of /Users/user/.claude/...`) with a fresh ~4-6 line rewrite. Suggested wording:

```markdown
## Project state

Current layer: 3 — Knowledge Graph (Sessions A–F done + scan perf fix + Session G full + `[[#^` block-id autocomplete + Sessions H.1 + H.2 + I done; Sessions J + K pending). Session I (`l3-session-i-unlinked-mentions`, spec §9.14): on-demand vault scan surfaces every plain-text occurrence of the open note's title / aliases that isn't already a link, in a second right-sidebar panel beside Backlinks; per-row "Link it" rewrites the span to `[[…]]` on disk. Pure scanner (`cubical-core::vault::mentions`) yields plain-text runs outside frontmatter / fenced+inline code / wiki-links / markdown links, then runs whole-word case-insensitive substring matches (`!c.is_alphanumeric() && != '_'` boundary — Tantivy-compatible for L4). Snippet helper lifted to `commands::snippet` so Backlinks + Mentions render identical context. `get_unlinked_mentions` + `link_mention` IPC handlers register via the pure-handler + thin-shim pattern; `link_mention` reads fresh just-in-time, re-validates the whole-word boundary, splices `[[Title]]` (matched ≡ title case-insensitively) or `[[Title|matched]]` (alias-display case), and writes atomically — no `expected_seen_hash` since the frontend has no seen-hash for non-open source files. Frontend mirrors Session C: `unlinkedMentionsState` reducer (+ `mention:linked` optimistic removal), `UnlinkedMentions.tsx` panel (reuses the untrack-guarded fetch effect from Session C), tabbed segment selector inside `RightSidebar` (Backlinks ↔ Unlinked Mentions, persisted as `ui.right_sidebar_panel`, default `backlinks`). `BACKLINKS_REFRESH_DEBOUNCE_MS` renamed → `RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS`; same tick fans out to both panels via the existing `vault:file-changed` listener (no new event). `MAX_SCAN_FILES=50_000` fuse for the worst case; documented in §9.14.
Earlier L3 (unchanged): backend block-refs (Session G, spec §9.8) — `create_block_ref` mints `^id`, migration 005, etc. Session H.1 (`embeds::{extract_section,extract_block,strip_frontmatter,slugify}` + `commands::embeds::get_embed`). Session H.2 (CM6 embed-widget extension, per-vault `EmbedResolver`, pure `renderEmbedBody`).
Tests: 306 Rust (+17 Session I — 16 scanner + 1 baseline parity from the snippet move) + 328 vitest (+7 Session I). L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: Session J — Rename → Pending Rewrites Cache (spec §2.10, §3.4, §8 Session J). Then K (closeout: hands-on smoke of ALL L3 surfaces incl. the I smoke vault, `l3` tag). H.3 polish (rich markdown inside embed body, click nav, `⎘` retirement) deferred — not on §2.8 DoD critical path. Smoke for Session I still pending hands-on (automated-context constraint; recipe in §9.14): vault with `Daily.md` (aliases: [diary, journal]), `Project.md` (mixed mentions + linked + code-span), `Notes.md` (cross-line mentions).
```

(The final test counts may differ — adjust after Task 16 verification.)

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md Project state — Sessions A–I done; next = J"
```

---

## Task 16: Final verification + branch finish

**Files:** none — verification only.

- [ ] **Step 1: Full cargo test + clippy + fmt**

Run in parallel where possible:
- `cargo test --workspace 2>&1 | grep -E "^test result:" | grep -oE "[0-9]+ passed" | awk '{sum+=$1} END {print sum}'` → expect 306 (289 + 17 new).
- `cargo clippy --workspace --all-targets -- -D warnings` → clean.
- `cargo fmt --all --check` → clean.

If the test count differs from 306, that's fine — record the actual number in §9.14 + CLAUDE.md before finishing.

- [ ] **Step 2: Full UI gate**

Run sequentially:
- `cd ui && npx tsc --noEmit` → clean.
- `cd ui && npm run build` → clean.
- `cd ui && npx vitest run 2>&1 | tail -10` → expect "Tests  328 passed (328)".

- [ ] **Step 3: Reconcile test counts**

If actual counts differ from the §9.14 / CLAUDE.md figures, edit them to match and amend the docs commit (or add a follow-up `docs: reconcile final test counts` commit). Do NOT amend — create a new commit per the project's "always new commits" convention.

- [ ] **Step 4: Invoke `finishing-a-development-branch`**

Per the session prompt's SESSION END PROTOCOL: default is to merge `l3-session-i-unlinked-mentions` into `main` with `--no-ff` and a commit message mirroring the H.1 / H.2 merge style:

```
merge: L3 Session I — unlinked mentions
```

Do NOT push. Do NOT skip hooks. Confirm the merge tree-state matches the branch tree-state.

- [ ] **Step 5: Final status report**

Report back: every DoD box's status, every decision deferred to / resolved in the plan, final test counts (Rust + vitest), the smoke recipe + the "deferred to hands-on" callout, and name the next session as **L3 Session J (Rename → Pending Rewrites Cache)**.

---

## Self-review — spec coverage matrix

| Session prompt step (STEP 2) | Plan task |
|---|---|
| 1. Pure scanner — `cubical-core::vault::mentions` | Tasks 1, 2, 3 |
| 2. IPC handler — `get_unlinked_mentions` | Tasks 4, 5, 6, 8 |
| 3. Rewrite action — `link_mention` | Tasks 5, 7, 8 |
| 4. Backend wiring (lib.rs, no migration, reuse `vault:file-changed`) | Task 8 (registration); refresh route in Task 13 |
| 5. IPC bindings — `ui/src/api/ipc.ts` | Task 9 |
| 6. State signal — `unlinkedMentionsState.ts` | Task 10 |
| 7. Panel — `UnlinkedMentions.tsx` | Task 12 |
| 8. Right-sidebar segment selector | Tasks 11, 13 |
| 9. App.tsx wiring | Task 13 |
| 10. Spec write-up §9.14 | Task 14 |
| 11. CLAUDE.md "Project state" rewrite | Task 15 |
| Verification + finishing | Task 16 |

| DoD box | Plan task |
|---|---|
| Branch created | (Done in STEP 0 of the session prompt — pre-plan) |
| Plan written with decisions resolved | This file |
| `vault::mentions` scanner + unit coverage | Tasks 2 + 3 |
| `get_unlinked_mentions` IPC end-to-end | Tasks 5 + 6 + 8 + 9 |
| `link_mention` IPC end-to-end + idempotency | Tasks 5 + 7 + 8 + 9 |
| Panel + empty state + Link-it + segment selector | Tasks 11 + 12 + 13 |
| Live refresh via `vault:file-changed` | Task 13 |
| §9.14 filled | Task 14 |
| CLAUDE.md Project state | Task 15 |
| All gates clean | Task 16 |
| Smoke recorded (or deferred per H.2 protocol) | Task 14 (recipe) + Task 16 (final report) |

No placeholders, no TBDs. Type names and method signatures used in later tasks all originate in earlier tasks. `mentionKey` is exported from `unlinkedMentionsState` (Task 10) and used by `UnlinkedMentions` (Task 12). `Mention` is exported from `api/ipc.ts` (Task 9) and used by `unlinkedMentionsState` (Task 10) + `UnlinkedMentions` (Task 12). `build_snippet` lives in `commands/snippet.rs` (Task 4) and is consumed by both `commands/backlinks.rs` (Task 4 refactor) and `commands/mentions.rs` (Task 6). All consistent.
