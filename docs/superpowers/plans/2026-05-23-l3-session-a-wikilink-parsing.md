# L3 Session A — Wiki-link parsing + the link index

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognise `[[…]]` (and `![[…]]`) wiki-links in the canonical AST on both the Rust and TS sides, persist every link in a libSQL `links` table extracted during vault scan + on file change, and expose a `resolve_link` IPC that maps a wiki-link target to a vault-relative path.

**Architecture:** Wiki-links are not CommonMark. The Rust parser (`pulldown-cmark`) and the editor's Lezer markdown parser both emit `[[…]]` runs as plain text — neither knows the syntax. L3 introduces a **post-processing tokenizer** that runs once on every `Inline::Text` produced by either pipeline, splits text-runs containing wiki-links into `Text + WikiLink + Text…` sequences, and adds the new `Inline::WikiLink` variant + `Anchor` enum to the canonical AST. Both sides ship a parallel tokenizer with the same grammar so the L1 cross-language parity contract (`parity.json` fixtures) is extended, not broken. The `links` table is a flat row-per-link index keyed by `source_path` and (when resolved) `target_path`; extraction happens inside the existing scan + watcher write paths so the index stays consistent without a separate refresh job.

**Tech Stack:** Rust (`cubical-ast`, `cubical-index`, `cubical-core`, `cubical-app`); TypeScript / Solid (`ui/src/ast`, `ui/src/api`); libSQL (`crates/cubical-index/migrations/*.sql`); pulldown-cmark (Rust parse) + Lezer (TS parse, untouched in Session A); Tauri 2 IPC.

---

## Spec references

- [`docs/layer-3-spec.md`](../../layer-3-spec.md) §1 goal 1, §2.1, §3.1, §4, §5 deviations #1–2, §8 Session A.
- [`docs/architecture/document-model.md`](../../architecture/document-model.md) §5.2 (wiki-links), §5.5 (canonical AST, "Editor decorations are a sanctioned exception" paragraph).
- L1 parity harness: `crates/cubical-ast/tests/fixtures/parity.json` (load-bearing) + `crates/cubical-ast/tests/parity_fixtures.rs` (Rust runner) + `ui/src/ast/parity.test.ts` (TS runner).

---

## File structure

**Create:**

```
crates/cubical-ast/src/wikilink.rs              # pure Rust wiki-link tokenizer
crates/cubical-index/migrations/003_links.sql   # links table schema
crates/cubical-index/src/links.rs               # links table queries
crates/cubical-core/src/vault/links.rs          # extraction from a Document
crates/cubical-app/src/commands/links.rs        # resolve_link pure handler

ui/src/ast/wikilink.ts                          # pure TS wiki-link tokenizer
ui/src/ast/wikilink.test.ts                     # vitest cases for the TS tokenizer
```

**Modify:**

```
crates/cubical-ast/src/types.rs                 # add Anchor enum + Inline::WikiLink variant
crates/cubical-ast/src/lib.rs                   # re-export wikilink module + Anchor
crates/cubical-ast/src/normalize.rs             # post-process Text inlines through tokenizer
crates/cubical-ast/tests/parity_fixtures.rs     # (no code change — drives the JSON fixtures)
crates/cubical-ast/tests/fixtures/parity.json   # add wiki-link fixtures
crates/cubical-index/src/lib.rs                 # re-export link queries
crates/cubical-index/src/migrations.rs          # register 003_links.sql
crates/cubical-core/src/vault/mod.rs            # re-export vault::links
crates/cubical-core/src/vault/scan.rs           # call link extraction during scan
crates/cubical-core/src/vault/watcher.rs        # call link extraction on file change
crates/cubical-app/src/api/types.rs             # ResolveLinkRequest/Response + ResolvedAnchor
crates/cubical-app/src/lib.rs                   # register resolve_link Tauri shim

ui/src/ast/types.ts                             # add Anchor + WikiLink to Inline union
ui/src/ast/normalize.ts                         # post-process text inlines through tokenizer
ui/src/api/ipc.ts                               # resolveLink wrapper + types

docs/layer-3-spec.md                            # fill §9.1 at session close
CLAUDE.md                                       # rewrite "Project state" at session close
```

---

## Wiki-link grammar (load-bearing)

The grammar both tokenizers implement, in order of precedence:

```
WIKILINK := "!"? "[[" TARGET ("#" ANCHOR)? ("|" DISPLAY)? "]]"
TARGET   := <chars except '[', ']', '|', '#'>          ; trimmed; empty → invalid
ANCHOR   := "^" BLOCK_ID                              ; block reference
         |  HEADING_TEXT                              ; heading reference
HEADING_TEXT := <chars except '[', ']', '|'>           ; trimmed
BLOCK_ID     := <chars except '[', ']', '|'>           ; trimmed
DISPLAY      := <chars except '[', ']'>                ; trimmed
```

**Rules:**

- The `!` prefix marks an embed (`is_embed = true`); otherwise `false`.
- Anchor `#` appears **before** the display `|`. A `#` after `|` is part of `DISPLAY`, not an anchor.
- An empty `TARGET` after trimming → tokenizer rejects the run (treats the bracketed text as plain text). This avoids spurious `[[ ]]` matches.
- Unclosed `[[` (no `]]` before end of Text) → treat as plain text.
- Wiki-links do **not** nest. The tokenizer is left-greedy: first `[[` finds the first `]]`.
- The tokenizer scans `Inline::Text` only. `Inline::Code` (inline code spans) and `Block::CodeBlock` are separate AST nodes and are not touched, satisfying the §5.6 exclusion of code spans for tag-like inline markers (and the same intuition for wiki-links).

---

## Tasks

### Task 1: Add `Anchor` + `Inline::WikiLink` to the canonical AST (Rust + TS together)

These two changes must land in the same commit so the parity harness compiles on both sides.

**Files:**

- Modify: `crates/cubical-ast/src/types.rs`
- Modify: `crates/cubical-ast/src/lib.rs` (re-export `Anchor`)
- Modify: `ui/src/ast/types.ts`

- [ ] **Step 1: Write a failing Rust round-trip test for the new variant.**

In `crates/cubical-ast/src/lib.rs` `#[cfg(test)] mod tests`:

```rust
#[test]
fn wikilink_round_trips_through_serde_json() {
    use crate::types::{Anchor, Inline};
    let wl = Inline::WikiLink {
        target: "Some Note".into(),
        display: Some("see here".into()),
        anchor: Some(Anchor::Block("intro".into())),
        embed: false,
    };
    let s = serde_json::to_string(&wl).expect("serialize");
    let back: Inline = serde_json::from_str(&s).expect("deserialize");
    assert_eq!(wl, back);
    // Wire shape must be tagged with kind="wiki_link".
    assert!(s.contains("\"kind\":\"wiki_link\""));
}
```

- [ ] **Step 2: Run it; expect a compile failure.**

```bash
cargo test -p cubical-ast wikilink_round_trips_through_serde_json
```

Expected: compile error — `Inline::WikiLink` and `types::Anchor` do not exist.

- [ ] **Step 3: Add the `Anchor` enum and the `WikiLink` variant to `types.rs`.**

Append below `Inline::LineBreak` (still inside the `pub enum Inline { … }` block):

```rust
    /// `[[target]]` / `[[target|display]]` / `[[target#heading]]` /
    /// `[[target#^block-id]]`, optionally prefixed `!` for an embed
    /// (`![[…]]`). Recognised by L3 — until L3 the parser emits these
    /// runs as `Inline::Text`. See `docs/layer-3-spec.md` §2.1 and
    /// `docs/architecture/document-model.md` §5.2.
    WikiLink {
        /// The bracketed target as written, with surrounding whitespace
        /// trimmed. Resolved to a vault path through the libSQL `links`
        /// index — not by this AST node.
        target: String,
        /// The optional `|display` text.
        display: Option<String>,
        /// The optional `#heading` or `#^block-id` anchor.
        anchor: Option<Anchor>,
        /// `true` when the link was written `![[…]]` (an embed).
        embed: bool,
    },
```

Add the `Anchor` enum at module top-level (above `Inline`):

```rust
/// A wiki-link anchor: a heading reference or a block-id reference.
/// `^block` distinguishes block from heading at parse time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Anchor {
    /// `[[note#heading]]`.
    Heading {
        /// The heading text after `#`, trimmed.
        value: String,
    },
    /// `[[note#^block-id]]`.
    Block {
        /// The block id after `#^`, trimmed.
        value: String,
    },
}
```

- [ ] **Step 4: Re-export `Anchor` from `lib.rs`.**

Update the existing `pub use types::{…};` line:

```rust
pub use types::{Anchor, Block, Document, Frontmatter, Inline, ListItem, Span};
```

- [ ] **Step 5: Run the Rust test, expect it to pass.**

```bash
cargo test -p cubical-ast wikilink_round_trips_through_serde_json
```

Expected: PASS. Also run the whole crate to confirm no regression:

```bash
cargo test -p cubical-ast
```

Expected: all existing tests still green.

- [ ] **Step 6: Mirror `Anchor` + `WikiLink` in `ui/src/ast/types.ts`.**

Append to the file:

```ts
/**
 * Wiki-link anchor — a heading reference or a block-id reference.
 * The `kind` discriminator mirrors `cubical_ast::Anchor`.
 */
export type Anchor =
  | { kind: "heading"; value: string }
  | { kind: "block"; value: string };
```

Extend the `Inline` union:

```ts
export type Inline =
  | { kind: "text"; value: string }
  | { kind: "emph"; children: Inline[] }
  | { kind: "strong"; children: Inline[] }
  | { kind: "code"; value: string }
  | { kind: "link"; dest: string; title: string | null; children: Inline[] }
  | { kind: "image"; dest: string; title: string | null; alt: Inline[] }
  | { kind: "line_break" }
  | {
      kind: "wiki_link";
      target: string;
      display: string | null;
      anchor: Anchor | null;
      embed: boolean;
    };
```

- [ ] **Step 7: Run TS gates to confirm parity hasn't drifted yet.**

```bash
cd ui && npx tsc --noEmit && npx vitest run
```

Expected: tsc clean, vitest still 104 (no new behaviour yet — only the type added).

- [ ] **Step 8: Commit.**

```bash
git add crates/cubical-ast/src/types.rs crates/cubical-ast/src/lib.rs ui/src/ast/types.ts
git commit -m "feat(ast): add Anchor + Inline::WikiLink variants (Rust + TS)"
```

---

### Task 2: Pure Rust wiki-link tokenizer

A single pure function `scan_wikilinks(input: &str) -> Vec<TokenizedRun>` that walks a text run and yields either text spans or parsed wiki-links.

**Files:**

- Create: `crates/cubical-ast/src/wikilink.rs`
- Modify: `crates/cubical-ast/src/lib.rs` (add `mod wikilink;`)

- [ ] **Step 1: Write the failing test file.**

Create `crates/cubical-ast/src/wikilink.rs`:

```rust
//! Pure wiki-link tokenizer. Scans an `Inline::Text` value for
//! `[[…]]` / `![[…]]` runs and yields a sequence of `TokenizedRun`s.
//!
//! Grammar in `docs/superpowers/plans/2026-05-23-l3-session-a-wikilink-parsing.md`
//! § "Wiki-link grammar". The grammar is mirrored byte-for-byte in
//! `ui/src/ast/wikilink.ts`; the L1 parity harness extends to wiki-link
//! fixtures so the two stay in lockstep.

use crate::types::Anchor;

/// One run produced by [`scan_wikilinks`].
#[derive(Debug, Clone, PartialEq)]
pub enum TokenizedRun {
    /// Plain text between (or around) wiki-links.
    Text(String),
    /// A successfully parsed wiki-link.
    WikiLink {
        target: String,
        display: Option<String>,
        anchor: Option<Anchor>,
        embed: bool,
    },
}

/// Scan a text run for `[[…]]` and `![[…]]`. Always returns at least one
/// element when `input` is non-empty (a single `Text` if no wiki-links).
/// An empty `input` returns an empty `Vec`.
pub fn scan_wikilinks(input: &str) -> Vec<TokenizedRun> {
    // Implementation lands in step 3.
    if input.is_empty() {
        Vec::new()
    } else {
        vec![TokenizedRun::Text(input.to_string())]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wl(target: &str) -> TokenizedRun {
        TokenizedRun::WikiLink {
            target: target.into(),
            display: None,
            anchor: None,
            embed: false,
        }
    }

    fn text(s: &str) -> TokenizedRun {
        TokenizedRun::Text(s.into())
    }

    #[test]
    fn plain_text_passes_through() {
        assert_eq!(scan_wikilinks("just text"), vec![text("just text")]);
    }

    #[test]
    fn empty_input_returns_empty_vec() {
        assert_eq!(scan_wikilinks(""), Vec::<TokenizedRun>::new());
    }

    #[test]
    fn simple_wikilink() {
        assert_eq!(scan_wikilinks("[[note]]"), vec![wl("note")]);
    }

    #[test]
    fn wikilink_with_display() {
        assert_eq!(
            scan_wikilinks("[[note|see here]]"),
            vec![TokenizedRun::WikiLink {
                target: "note".into(),
                display: Some("see here".into()),
                anchor: None,
                embed: false,
            }]
        );
    }

    #[test]
    fn wikilink_with_heading_anchor() {
        assert_eq!(
            scan_wikilinks("[[note#heading]]"),
            vec![TokenizedRun::WikiLink {
                target: "note".into(),
                display: None,
                anchor: Some(Anchor::Heading { value: "heading".into() }),
                embed: false,
            }]
        );
    }

    #[test]
    fn wikilink_with_block_anchor() {
        assert_eq!(
            scan_wikilinks("[[note#^intro]]"),
            vec![TokenizedRun::WikiLink {
                target: "note".into(),
                display: None,
                anchor: Some(Anchor::Block { value: "intro".into() }),
                embed: false,
            }]
        );
    }

    #[test]
    fn wikilink_anchor_then_display() {
        assert_eq!(
            scan_wikilinks("[[note#heading|nice text]]"),
            vec![TokenizedRun::WikiLink {
                target: "note".into(),
                display: Some("nice text".into()),
                anchor: Some(Anchor::Heading { value: "heading".into() }),
                embed: false,
            }]
        );
    }

    #[test]
    fn embed_wikilink() {
        assert_eq!(
            scan_wikilinks("![[diagram]]"),
            vec![TokenizedRun::WikiLink {
                target: "diagram".into(),
                display: None,
                anchor: None,
                embed: true,
            }]
        );
    }

    #[test]
    fn text_around_wikilink() {
        assert_eq!(
            scan_wikilinks("see [[note]] for context"),
            vec![text("see "), wl("note"), text(" for context")]
        );
    }

    #[test]
    fn multiple_wikilinks() {
        assert_eq!(
            scan_wikilinks("[[a]] and [[b]]"),
            vec![wl("a"), text(" and "), wl("b")]
        );
    }

    #[test]
    fn unclosed_brackets_pass_through_as_text() {
        assert_eq!(
            scan_wikilinks("text [[unclosed and more"),
            vec![text("text [[unclosed and more")]
        );
    }

    #[test]
    fn empty_target_is_rejected() {
        assert_eq!(
            scan_wikilinks("[[]] noise"),
            vec![text("[[]] noise")]
        );
    }

    #[test]
    fn whitespace_only_target_is_rejected() {
        assert_eq!(
            scan_wikilinks("[[   ]]"),
            vec![text("[[   ]]")]
        );
    }

    #[test]
    fn whitespace_inside_target_is_preserved_and_trimmed_at_edges() {
        assert_eq!(scan_wikilinks("[[ a note ]]"), vec![wl("a note")]);
    }

    #[test]
    fn hash_after_pipe_is_part_of_display_not_anchor() {
        assert_eq!(
            scan_wikilinks("[[note|see #3]]"),
            vec![TokenizedRun::WikiLink {
                target: "note".into(),
                display: Some("see #3".into()),
                anchor: None,
                embed: false,
            }]
        );
    }
}
```

- [ ] **Step 2: Wire the module into `lib.rs`.**

In `crates/cubical-ast/src/lib.rs`, alongside the other `mod` declarations:

```rust
mod wikilink;
```

(Do **not** `pub use` it yet — `scan_wikilinks` is an internal helper for `normalize.rs`. The `Anchor` type is already re-exported.)

- [ ] **Step 3: Run the tests; confirm they fail for the right reason.**

```bash
cargo test -p cubical-ast wikilink::
```

Expected: all 13 tests in `wikilink::tests` FAIL (the stub returns `Text(input)` for every non-empty case). The "plain text" and "empty input" tests will PASS — that is correct.

- [ ] **Step 4: Implement `scan_wikilinks` properly.**

Replace the stub body of `scan_wikilinks` with:

```rust
pub fn scan_wikilinks(input: &str) -> Vec<TokenizedRun> {
    let bytes = input.as_bytes();
    let mut out: Vec<TokenizedRun> = Vec::new();
    let mut cursor: usize = 0;
    let mut i: usize = 0;
    while i < bytes.len() {
        // Find the next `[[` or `![[`.
        let (open_byte, content_start, is_embed) = match find_open(bytes, i) {
            Some(found) => found,
            None => break,
        };
        // Locate the matching `]]` after `content_start`.
        let close = match find_close(bytes, content_start) {
            Some(c) => c,
            None => {
                // Unclosed: stop searching, flush rest as text.
                break;
            }
        };
        let body = &input[content_start..close];
        match parse_body(body, is_embed) {
            Some(wl) => {
                // Flush text since cursor.
                if open_byte > cursor {
                    out.push(TokenizedRun::Text(input[cursor..open_byte].to_string()));
                }
                out.push(wl);
                cursor = close + 2; // skip the closing `]]`
                i = cursor;
            }
            None => {
                // Body was unparseable (empty target etc.); skip the `[[`
                // and continue searching after it. Do not flush.
                i = content_start;
            }
        }
    }
    if cursor < bytes.len() {
        out.push(TokenizedRun::Text(input[cursor..].to_string()));
    }
    out
}

/// Find the next opening bracket from `start`. Returns
/// `(opener_byte_pos, content_byte_pos, is_embed)`.
fn find_open(bytes: &[u8], start: usize) -> Option<(usize, usize, bool)> {
    let mut i = start;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            // Check for `!` immediately before.
            if i > 0 && bytes[i - 1] == b'!' {
                return Some((i - 1, i + 2, true));
            }
            return Some((i, i + 2, false));
        }
        i += 1;
    }
    None
}

/// Find the next `]]` from `start`. Returns the index of the first `]`.
fn find_close(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start;
    while i + 1 < bytes.len() {
        if bytes[i] == b']' && bytes[i + 1] == b']' {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Parse the inner body of `[[BODY]]` into a `WikiLink`. Returns `None`
/// when the body is empty after trimming.
fn parse_body(body: &str, is_embed: bool) -> Option<TokenizedRun> {
    // Split on the first `|` (display separator) — anchor is always
    // before the pipe.
    let (head, display) = match body.find('|') {
        Some(pipe) => (&body[..pipe], Some(body[pipe + 1..].trim().to_string())),
        None => (body, None),
    };
    // Split head on the first `#` (anchor separator).
    let (target_raw, anchor) = match head.find('#') {
        Some(hash) => {
            let target = &head[..hash];
            let rest = &head[hash + 1..];
            let anchor = if let Some(block) = rest.strip_prefix('^') {
                let v = block.trim();
                if v.is_empty() {
                    None
                } else {
                    Some(Anchor::Block { value: v.to_string() })
                }
            } else {
                let v = rest.trim();
                if v.is_empty() {
                    None
                } else {
                    Some(Anchor::Heading { value: v.to_string() })
                }
            };
            (target, anchor)
        }
        None => (head, None),
    };
    let target = target_raw.trim();
    if target.is_empty() {
        return None;
    }
    Some(TokenizedRun::WikiLink {
        target: target.to_string(),
        display,
        anchor,
        embed: is_embed,
    })
}
```

- [ ] **Step 5: Run the tokenizer tests; confirm GREEN.**

```bash
cargo test -p cubical-ast wikilink::
```

Expected: all 13 tests PASS.

- [ ] **Step 6: Run the whole crate to confirm no regression.**

```bash
cargo test -p cubical-ast
```

Expected: all tests green.

- [ ] **Step 7: Commit.**

```bash
git add crates/cubical-ast/src/wikilink.rs crates/cubical-ast/src/lib.rs
git commit -m "feat(ast): pure Rust wiki-link tokenizer (scan_wikilinks)"
```

---

### Task 3: Wire the Rust tokenizer into `normalize`

Post-process every `Inline::Text` emitted by the pulldown-cmark walk and split it into `Text + WikiLink + Text…` runs.

**Files:**

- Modify: `crates/cubical-ast/src/normalize.rs`

- [ ] **Step 1: Find the spot in `normalize.rs` where text inlines are flushed/emitted.**

Read the file (it produces `Inline::Text` somewhere in the inline walk). Identify the function(s) that build the final `Vec<Inline>` for a paragraph/heading.

- [ ] **Step 2: Write the failing parse-level test in `lib.rs`.**

In `crates/cubical-ast/src/lib.rs` `#[cfg(test)] mod tests`:

```rust
#[test]
fn wikilink_in_paragraph_is_extracted() {
    use crate::types::{Block, Inline};
    let doc = parse("see [[Other Note]] for more\n");
    assert_eq!(doc.blocks.len(), 1);
    let Block::Paragraph { inlines, .. } = &doc.blocks[0] else {
        panic!("expected paragraph, got {:?}", doc.blocks[0]);
    };
    // Expect: Text("see ") + WikiLink("Other Note") + Text(" for more")
    assert_eq!(inlines.len(), 3);
    assert!(matches!(&inlines[0], Inline::Text { value } if value == "see "));
    assert!(matches!(
        &inlines[1],
        Inline::WikiLink { target, display: None, anchor: None, embed: false }
            if target == "Other Note"
    ));
    assert!(matches!(&inlines[2], Inline::Text { value } if value == " for more"));
}

#[test]
fn embed_wikilink_in_paragraph() {
    use crate::types::{Block, Inline};
    let doc = parse("![[diagram]]\n");
    let Block::Paragraph { inlines, .. } = &doc.blocks[0] else { panic!() };
    assert_eq!(inlines.len(), 1);
    assert!(matches!(
        &inlines[0],
        Inline::WikiLink { embed: true, .. }
    ));
}

#[test]
fn inline_code_text_is_not_scanned_for_wikilinks() {
    // The `[[note]]` inside backticks must remain in an Inline::Code
    // value as-is — code spans are a separate AST node, not Text.
    use crate::types::{Block, Inline};
    let doc = parse("see `[[not a link]]` here\n");
    let Block::Paragraph { inlines, .. } = &doc.blocks[0] else { panic!() };
    // Expect: Text("see ") + Code("[[not a link]]") + Text(" here")
    assert!(
        inlines.iter().any(|n| matches!(n, Inline::Code { value } if value == "[[not a link]]")),
        "code span content must be preserved: {:?}",
        inlines
    );
    assert!(
        !inlines.iter().any(|n| matches!(n, Inline::WikiLink { .. })),
        "no WikiLink should be produced from inline-code content: {:?}",
        inlines
    );
}
```

- [ ] **Step 3: Run the tests; confirm FAIL.**

```bash
cargo test -p cubical-ast wikilink_in_paragraph_is_extracted embed_wikilink_in_paragraph inline_code_text_is_not_scanned_for_wikilinks
```

Expected: the two extraction tests FAIL (no WikiLink emitted yet). The code-span test PASSES (the negative case already holds because we don't scan yet).

- [ ] **Step 4: Add a post-processing pass to `normalize.rs`.**

Add a helper near the bottom of the file:

```rust
/// Walk an `Inline` sequence and split every `Inline::Text` value
/// through the wiki-link tokenizer. Other inline kinds (Code, Emph,
/// Strong, Link, Image, LineBreak) are preserved as-is.
fn split_wikilinks(inlines: Vec<crate::types::Inline>) -> Vec<crate::types::Inline> {
    use crate::types::Inline;
    use crate::wikilink::{scan_wikilinks, TokenizedRun};
    let mut out: Vec<Inline> = Vec::with_capacity(inlines.len());
    for inline in inlines {
        match inline {
            Inline::Text { value } => {
                for run in scan_wikilinks(&value) {
                    match run {
                        TokenizedRun::Text(t) => out.push(Inline::Text { value: t }),
                        TokenizedRun::WikiLink { target, display, anchor, embed } => {
                            out.push(Inline::WikiLink { target, display, anchor, embed });
                        }
                    }
                }
            }
            // Emph / Strong wrap further inlines — recurse so nested
            // text gets tokenized too. (Wiki-links inside *emph* are
            // unusual but possible.)
            Inline::Emph { children } => out.push(Inline::Emph {
                children: split_wikilinks(children),
            }),
            Inline::Strong { children } => out.push(Inline::Strong {
                children: split_wikilinks(children),
            }),
            // Link / Image children carry the link text / alt text; the
            // dest is a URL, not subject to wiki-link tokenization.
            // Recurse the visible children.
            Inline::Link { dest, title, children } => out.push(Inline::Link {
                dest,
                title,
                children: split_wikilinks(children),
            }),
            Inline::Image { dest, title, alt } => out.push(Inline::Image {
                dest,
                title,
                alt: split_wikilinks(alt),
            }),
            other => out.push(other),
        }
    }
    out
}
```

- [ ] **Step 5: Apply the pass to every block that carries inlines.**

Find the function that constructs `Block::Heading` and `Block::Paragraph` (and list items / quotes recursively through their nested blocks). Pipe their `inlines` through `split_wikilinks`. The minimal touch:

```rust
// Wherever Block::Heading { inlines, .. } is constructed:
Block::Heading {
    level,
    inlines: split_wikilinks(inlines),
    span,
}

// Wherever Block::Paragraph { inlines, .. } is constructed:
Block::Paragraph {
    inlines: split_wikilinks(inlines),
    span,
}
```

(Quotes and list items contain nested `Block`s, which themselves carry inlines — the recursion happens because each `Heading`/`Paragraph` is built through the same construction site.)

- [ ] **Step 6: Run the three tests; confirm GREEN.**

```bash
cargo test -p cubical-ast wikilink_in_paragraph_is_extracted embed_wikilink_in_paragraph inline_code_text_is_not_scanned_for_wikilinks
```

Expected: all PASS.

- [ ] **Step 7: Run the full crate suite.**

```bash
cargo test -p cubical-ast
```

Expected: every existing test still green (the only behaviour change is that text containing `[[…]]` now splits — none of the existing fixtures use wiki-link syntax in body text).

- [ ] **Step 8: Commit.**

```bash
git add crates/cubical-ast/src/normalize.rs crates/cubical-ast/src/lib.rs
git commit -m "feat(ast): post-process Inline::Text through wiki-link tokenizer"
```

---

### Task 4: Pure TS wiki-link tokenizer (parity mirror)

A line-for-line behavioural mirror of the Rust tokenizer in TS.

**Files:**

- Create: `ui/src/ast/wikilink.ts`
- Create: `ui/src/ast/wikilink.test.ts`

- [ ] **Step 1: Write the failing vitest file.**

Create `ui/src/ast/wikilink.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { scanWikilinks, type TokenizedRun } from "./wikilink";

function text(value: string): TokenizedRun {
  return { kind: "text", value };
}
function wl(target: string, extra: Partial<Omit<Extract<TokenizedRun, { kind: "wiki_link" }>, "kind" | "target">> = {}): TokenizedRun {
  return {
    kind: "wiki_link",
    target,
    display: extra.display ?? null,
    anchor: extra.anchor ?? null,
    embed: extra.embed ?? false,
  };
}

describe("scanWikilinks", () => {
  it("returns empty array for empty input", () => {
    expect(scanWikilinks("")).toEqual([]);
  });

  it("passes plain text through", () => {
    expect(scanWikilinks("just text")).toEqual([text("just text")]);
  });

  it("recognises a simple wiki-link", () => {
    expect(scanWikilinks("[[note]]")).toEqual([wl("note")]);
  });

  it("recognises a wiki-link with display", () => {
    expect(scanWikilinks("[[note|see here]]")).toEqual([
      wl("note", { display: "see here" }),
    ]);
  });

  it("recognises a heading anchor", () => {
    expect(scanWikilinks("[[note#heading]]")).toEqual([
      wl("note", { anchor: { kind: "heading", value: "heading" } }),
    ]);
  });

  it("recognises a block anchor", () => {
    expect(scanWikilinks("[[note#^intro]]")).toEqual([
      wl("note", { anchor: { kind: "block", value: "intro" } }),
    ]);
  });

  it("anchor + display together", () => {
    expect(scanWikilinks("[[note#heading|nice text]]")).toEqual([
      wl("note", {
        anchor: { kind: "heading", value: "heading" },
        display: "nice text",
      }),
    ]);
  });

  it("recognises an embed", () => {
    expect(scanWikilinks("![[diagram]]")).toEqual([
      wl("diagram", { embed: true }),
    ]);
  });

  it("splits text around a wiki-link", () => {
    expect(scanWikilinks("see [[note]] for context")).toEqual([
      text("see "),
      wl("note"),
      text(" for context"),
    ]);
  });

  it("handles multiple wiki-links", () => {
    expect(scanWikilinks("[[a]] and [[b]]")).toEqual([
      wl("a"),
      text(" and "),
      wl("b"),
    ]);
  });

  it("passes unclosed [[ through as text", () => {
    expect(scanWikilinks("text [[unclosed and more")).toEqual([
      text("text [[unclosed and more"),
    ]);
  });

  it("rejects empty target", () => {
    expect(scanWikilinks("[[]] noise")).toEqual([text("[[]] noise")]);
  });

  it("rejects whitespace-only target", () => {
    expect(scanWikilinks("[[   ]]")).toEqual([text("[[   ]]")]);
  });

  it("trims edge whitespace inside target", () => {
    expect(scanWikilinks("[[ a note ]]")).toEqual([wl("a note")]);
  });

  it("treats # after | as part of display", () => {
    expect(scanWikilinks("[[note|see #3]]")).toEqual([
      wl("note", { display: "see #3" }),
    ]);
  });
});
```

- [ ] **Step 2: Run the test; confirm FAIL.**

```bash
cd ui && npx vitest run src/ast/wikilink.test.ts
```

Expected: module-not-found error (`wikilink.ts` does not exist yet) — that counts as RED.

- [ ] **Step 3: Implement `wikilink.ts`.**

Create `ui/src/ast/wikilink.ts`:

```ts
/**
 * Pure TS wiki-link tokenizer — behavioural mirror of
 * `crates/cubical-ast/src/wikilink.rs::scan_wikilinks`.
 *
 * Scans an `Inline::Text` value for `[[…]]` / `![[…]]` runs and yields a
 * sequence of `TokenizedRun`s. Grammar is locked by the L1 parity
 * harness fixtures; both languages must produce identical output for
 * every fixture string.
 */

import type { Anchor } from "./types";

/** One run produced by {@link scanWikilinks}. */
export type TokenizedRun =
  | { kind: "text"; value: string }
  | {
      kind: "wiki_link";
      target: string;
      display: string | null;
      anchor: Anchor | null;
      embed: boolean;
    };

/**
 * Scan a text run for `[[…]]` and `![[…]]`. Returns an empty array for
 * an empty input; otherwise always at least one element.
 */
export function scanWikilinks(input: string): TokenizedRun[] {
  if (input.length === 0) return [];
  const out: TokenizedRun[] = [];
  let cursor = 0;
  let i = 0;
  while (i < input.length) {
    const open = findOpen(input, i);
    if (!open) break;
    const close = findClose(input, open.contentStart);
    if (close < 0) break;
    const body = input.slice(open.contentStart, close);
    const wl = parseBody(body, open.embed);
    if (wl) {
      if (open.openerPos > cursor) {
        out.push({ kind: "text", value: input.slice(cursor, open.openerPos) });
      }
      out.push(wl);
      cursor = close + 2;
      i = cursor;
    } else {
      // Unparseable body (empty target); skip the `[[` and keep going.
      i = open.contentStart;
    }
  }
  if (cursor < input.length) {
    out.push({ kind: "text", value: input.slice(cursor) });
  }
  return out;
}

interface Opener {
  /** Byte index of the `!` (embed) or first `[` (plain). */
  openerPos: number;
  /** Byte index where the body starts (after `[[` or `![[`). */
  contentStart: number;
  /** Whether the link was prefixed with `!`. */
  embed: boolean;
}

function findOpen(input: string, start: number): Opener | null {
  for (let i = start; i + 1 < input.length; i++) {
    if (input.charCodeAt(i) === 0x5b && input.charCodeAt(i + 1) === 0x5b) {
      if (i > 0 && input.charCodeAt(i - 1) === 0x21 /* ! */) {
        return { openerPos: i - 1, contentStart: i + 2, embed: true };
      }
      return { openerPos: i, contentStart: i + 2, embed: false };
    }
  }
  return null;
}

function findClose(input: string, start: number): number {
  for (let i = start; i + 1 < input.length; i++) {
    if (input.charCodeAt(i) === 0x5d && input.charCodeAt(i + 1) === 0x5d) {
      return i;
    }
  }
  return -1;
}

function parseBody(body: string, embed: boolean): TokenizedRun | null {
  const pipeIdx = body.indexOf("|");
  let head: string;
  let display: string | null = null;
  if (pipeIdx >= 0) {
    head = body.slice(0, pipeIdx);
    display = body.slice(pipeIdx + 1).trim();
  } else {
    head = body;
  }
  const hashIdx = head.indexOf("#");
  let targetRaw: string;
  let anchor: Anchor | null = null;
  if (hashIdx >= 0) {
    targetRaw = head.slice(0, hashIdx);
    const rest = head.slice(hashIdx + 1);
    if (rest.startsWith("^")) {
      const v = rest.slice(1).trim();
      if (v.length > 0) anchor = { kind: "block", value: v };
    } else {
      const v = rest.trim();
      if (v.length > 0) anchor = { kind: "heading", value: v };
    }
  } else {
    targetRaw = head;
  }
  const target = targetRaw.trim();
  if (target.length === 0) return null;
  return { kind: "wiki_link", target, display, anchor, embed };
}
```

- [ ] **Step 4: Run vitest; confirm GREEN.**

```bash
cd ui && npx vitest run src/ast/wikilink.test.ts
```

Expected: all 15 tests PASS.

- [ ] **Step 5: Run the whole vitest suite.**

```bash
cd ui && npx vitest run
```

Expected: 119 passed (104 baseline + 15 new). Run `npx tsc --noEmit` too — clean.

- [ ] **Step 6: Commit.**

```bash
git add ui/src/ast/wikilink.ts ui/src/ast/wikilink.test.ts
git commit -m "feat(ast): pure TS wiki-link tokenizer (scanWikilinks)"
```

---

### Task 5: Wire the TS tokenizer into `normalize.ts`

Mirror the Rust post-pass: split every `kind: "text"` inline through `scanWikilinks` and recurse into emph/strong/link/image children.

**Files:**

- Modify: `ui/src/ast/normalize.ts`

- [ ] **Step 1: Add failing tests to `normalize.test.ts` (Lezer-side parity).**

Append to `ui/src/ast/normalize.test.ts`:

```ts
import { normalize } from "./normalize";

describe("normalize — wiki-links", () => {
  it("extracts a wiki-link from a paragraph", () => {
    const doc = normalize("see [[Other Note]] for more\n");
    expect(doc.blocks.length).toBe(1);
    const p = doc.blocks[0];
    if (p.kind !== "paragraph") throw new Error("expected paragraph");
    expect(p.inlines).toEqual([
      { kind: "text", value: "see " },
      {
        kind: "wiki_link",
        target: "Other Note",
        display: null,
        anchor: null,
        embed: false,
      },
      { kind: "text", value: " for more" },
    ]);
  });

  it("emits an embed wiki-link", () => {
    const doc = normalize("![[diagram]]\n");
    const p = doc.blocks[0];
    if (p.kind !== "paragraph") throw new Error("expected paragraph");
    expect(p.inlines).toHaveLength(1);
    const wl = p.inlines[0];
    expect(wl.kind).toBe("wiki_link");
    if (wl.kind !== "wiki_link") return;
    expect(wl.embed).toBe(true);
    expect(wl.target).toBe("diagram");
  });

  it("does not scan inline-code content for wiki-links", () => {
    const doc = normalize("see `[[not a link]]` here\n");
    const p = doc.blocks[0];
    if (p.kind !== "paragraph") throw new Error("expected paragraph");
    expect(p.inlines.some((i) => i.kind === "code" && i.value === "[[not a link]]"))
      .toBe(true);
    expect(p.inlines.some((i) => i.kind === "wiki_link")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

```bash
cd ui && npx vitest run src/ast/normalize.test.ts
```

Expected: the three new tests FAIL.

- [ ] **Step 3: Add the post-pass to `normalize.ts`.**

At the top of `ui/src/ast/normalize.ts`, add the import:

```ts
import { scanWikilinks } from "./wikilink";
```

Add a helper at the bottom of the file:

```ts
/**
 * Walk an inline sequence and split every text run through the
 * wiki-link tokenizer. Mirrors `cubical_ast::normalize::split_wikilinks`.
 */
function splitWikilinks(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const inline of inlines) {
    if (inline.kind === "text") {
      for (const run of scanWikilinks(inline.value)) {
        out.push(run as Inline);
      }
    } else if (inline.kind === "emph") {
      out.push({ kind: "emph", children: splitWikilinks(inline.children) });
    } else if (inline.kind === "strong") {
      out.push({ kind: "strong", children: splitWikilinks(inline.children) });
    } else if (inline.kind === "link") {
      out.push({
        kind: "link",
        dest: inline.dest,
        title: inline.title,
        children: splitWikilinks(inline.children),
      });
    } else if (inline.kind === "image") {
      out.push({
        kind: "image",
        dest: inline.dest,
        title: inline.title,
        alt: splitWikilinks(inline.alt),
      });
    } else {
      out.push(inline);
    }
  }
  return out;
}
```

In `readBlock`, wherever a `heading` or `paragraph` block is returned, wrap `inlines` with `splitWikilinks(...)`. Specifically the two return sites:

```ts
return {
  kind: "heading",
  level,
  inlines: splitWikilinks(inlines),
  span: shift(from, end, bodyOffset),
};
```

```ts
return {
  kind: "paragraph",
  inlines: splitWikilinks(inlines),
  span: shift(from, end, bodyOffset),
};
```

- [ ] **Step 4: Run; confirm GREEN.**

```bash
cd ui && npx vitest run src/ast/normalize.test.ts && npx vitest run
```

Expected: the three new tests PASS; total 122 passed (119 prior + 3).

- [ ] **Step 5: Typecheck.**

```bash
cd ui && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add ui/src/ast/normalize.ts ui/src/ast/normalize.test.ts
git commit -m "feat(ast): post-process text inlines through wiki-link tokenizer (TS)"
```

---

### Task 6: Extend the parity harness — wiki-link fixtures

The cross-language parity harness in `crates/cubical-ast/tests/fixtures/parity.json` is the load-bearing test that the Rust parse and the TS normalize produce identical canonical AST for the same source. L3 extends the fixture set with wiki-link cases.

**Files:**

- Modify: `crates/cubical-ast/tests/fixtures/parity.json`

- [ ] **Step 1: Read the existing fixture file to learn its shape.**

```bash
head -40 crates/cubical-ast/tests/fixtures/parity.json
```

Note the shape — each fixture has `name`, `source`, and `expected` (a serialized `Document`). Use the same shape.

- [ ] **Step 2: Add five wiki-link fixtures.**

Append (inside the top-level array) the following entries (`expected.source_len` is `source.length` in bytes; `span` values cover the whole body line including its trailing newline):

```json
{
  "name": "wikilink_simple",
  "source": "see [[note]] for context\n",
  "expected": {
    "frontmatter": null,
    "blocks": [
      {
        "kind": "paragraph",
        "inlines": [
          { "kind": "text", "value": "see " },
          { "kind": "wiki_link", "target": "note", "display": null, "anchor": null, "embed": false },
          { "kind": "text", "value": " for context" }
        ],
        "span": { "start": 0, "end": 25 }
      }
    ],
    "source_len": 25
  }
},
{
  "name": "wikilink_with_display",
  "source": "[[note|see here]]\n",
  "expected": {
    "frontmatter": null,
    "blocks": [
      {
        "kind": "paragraph",
        "inlines": [
          { "kind": "wiki_link", "target": "note", "display": "see here", "anchor": null, "embed": false }
        ],
        "span": { "start": 0, "end": 18 }
      }
    ],
    "source_len": 18
  }
},
{
  "name": "wikilink_heading_anchor",
  "source": "[[note#heading]]\n",
  "expected": {
    "frontmatter": null,
    "blocks": [
      {
        "kind": "paragraph",
        "inlines": [
          {
            "kind": "wiki_link",
            "target": "note",
            "display": null,
            "anchor": { "kind": "heading", "value": "heading" },
            "embed": false
          }
        ],
        "span": { "start": 0, "end": 17 }
      }
    ],
    "source_len": 17
  }
},
{
  "name": "wikilink_block_anchor_with_display",
  "source": "[[note#^intro|see intro]]\n",
  "expected": {
    "frontmatter": null,
    "blocks": [
      {
        "kind": "paragraph",
        "inlines": [
          {
            "kind": "wiki_link",
            "target": "note",
            "display": "see intro",
            "anchor": { "kind": "block", "value": "intro" },
            "embed": false
          }
        ],
        "span": { "start": 0, "end": 26 }
      }
    ],
    "source_len": 26
  }
},
{
  "name": "wikilink_embed",
  "source": "![[diagram]]\n",
  "expected": {
    "frontmatter": null,
    "blocks": [
      {
        "kind": "paragraph",
        "inlines": [
          { "kind": "wiki_link", "target": "diagram", "display": null, "anchor": null, "embed": true }
        ],
        "span": { "start": 0, "end": 13 }
      }
    ],
    "source_len": 13
  }
}
```

(Insert these objects into the array — keep its comma-separated JSON shape valid.)

- [ ] **Step 3: Run the Rust parity test.**

```bash
cargo test -p cubical-ast --test parity_fixtures
```

Expected: PASS — the Rust parser now emits these structures.

- [ ] **Step 4: Run the TS parity test.**

```bash
cd ui && npx vitest run src/ast/parity.test.ts
```

Expected: PASS — the TS normalizer produces the same structures.

- [ ] **Step 5: Commit.**

```bash
git add crates/cubical-ast/tests/fixtures/parity.json
git commit -m "test(ast): add wiki-link fixtures to the parity harness"
```

---

### Task 7: `links` table migration

**Files:**

- Create: `crates/cubical-index/migrations/003_links.sql`
- Modify: `crates/cubical-index/src/migrations.rs`

- [ ] **Step 1: Read the existing migrations module to learn the registration pattern.**

```bash
cat crates/cubical-index/src/migrations.rs
```

Notice how `001_initial.sql` and `002_frontmatter.sql` are registered. The new migration follows the same shape.

- [ ] **Step 2: Write the failing migration test.**

Add to `crates/cubical-index/src/migrations.rs` `#[cfg(test)] mod tests` (or wherever the existing migration tests sit):

```rust
#[test]
fn migration_003_creates_links_table() {
    // The MIGRATIONS array must contain a 003 entry.
    let m = MIGRATIONS.iter().find(|m| m.version == 3);
    assert!(m.is_some(), "003 migration must be registered");
    let sql = m.unwrap().sql;
    assert!(sql.contains("CREATE TABLE links"), "must create links table");
    assert!(sql.contains("source_path"));
    assert!(sql.contains("target_path"));
    assert!(sql.contains("idx_links_source"));
    assert!(sql.contains("idx_links_target"));
}
```

- [ ] **Step 3: Run; confirm FAIL.**

```bash
cargo test -p cubical-index migration_003_creates_links_table
```

Expected: FAIL — the migration is not registered.

- [ ] **Step 4: Create the migration file.**

Create `crates/cubical-index/migrations/003_links.sql`:

```sql
-- Layer 3 wiki-link index. See docs/architecture/document-model.md §5.2
-- ("Resolution is via libSQL's link index, keyed by `file_path` pre-L7")
-- and docs/layer-3-spec.md §2.1.
--
-- One row per wiki-link occurrence. `target_path` is NULL when the link
-- could not be resolved at extraction time; the row is kept so the
-- backlinks UI can surface unresolved links and so re-resolution after
-- a rename can fill it in. `position` is the byte offset of the link's
-- opener in the source file, used for ordering and for context snippets.
--
-- ON DELETE CASCADE on `source_path` means a future `DELETE FROM files`
-- (pending-rewrites territory, Session J) cleans up its link rows.

CREATE TABLE links (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path   TEXT NOT NULL,
    target_raw    TEXT NOT NULL,
    target_path   TEXT,
    anchor_kind   TEXT,
    anchor_value  TEXT,
    display_text  TEXT,
    is_embed      INTEGER NOT NULL DEFAULT 0,
    position      INTEGER NOT NULL,
    FOREIGN KEY (source_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE INDEX idx_links_source ON links(source_path);
CREATE INDEX idx_links_target ON links(target_path);
```

- [ ] **Step 5: Register the migration in `migrations.rs`.**

Following the existing pattern (likely something like a static array `MIGRATIONS` of `Migration { version, name, sql }`), add the entry:

```rust
Migration {
    version: 3,
    name: "links",
    sql: include_str!("../migrations/003_links.sql"),
},
```

- [ ] **Step 6: Run the test; confirm GREEN.**

```bash
cargo test -p cubical-index
```

Expected: all green incl. the new test. The schema migration runner also runs against an in-memory libSQL during tests — confirm those pass too.

- [ ] **Step 7: Commit.**

```bash
git add crates/cubical-index/migrations/003_links.sql crates/cubical-index/src/migrations.rs
git commit -m "feat(index): 003_links.sql — L3 wiki-link index schema"
```

---

### Task 8: `links` table query module

Insert / replace / delete / lookup queries against the new table.

**Files:**

- Create: `crates/cubical-index/src/links.rs`
- Modify: `crates/cubical-index/src/lib.rs` (re-export)

- [ ] **Step 1: Write the failing test.**

Create `crates/cubical-index/src/links.rs` with a stub `pub struct LinkRow` + `pub fn replace_links_for_file(…)` returning a hardcoded value, and the test:

```rust
//! Queries against the L3 `links` table.

use crate::runner::IndexConn;
use crate::IndexError;

/// One row inserted into the `links` table. `target_path` may be `None`
/// at extraction time when resolution failed (e.g. the target file does
/// not exist yet).
#[derive(Debug, Clone, PartialEq)]
pub struct LinkRow {
    pub target_raw: String,
    pub target_path: Option<String>,
    pub anchor_kind: Option<String>,   // "heading" | "block"
    pub anchor_value: Option<String>,
    pub display_text: Option<String>,
    pub is_embed: bool,
    pub position: u64,
}

/// Replace the entire set of link rows for `source_path`. Atomic per
/// file: deletes the old rows then inserts the new ones in a single
/// transaction so a reader never sees a half-updated set.
pub fn replace_links_for_file(
    _conn: &mut IndexConn,
    _source_path: &str,
    _rows: &[LinkRow],
) -> Result<(), IndexError> {
    todo!()
}

/// All link rows whose `source_path` equals the argument.
pub fn links_from(_conn: &IndexConn, _source_path: &str) -> Result<Vec<LinkRow>, IndexError> {
    todo!()
}

/// All link rows whose `target_path` equals the argument (backlinks).
pub fn links_to(_conn: &IndexConn, _target_path: &str) -> Result<Vec<LinkRow>, IndexError> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_index;

    fn open_test_index() -> IndexConn {
        // Use the established test-harness helper for an in-memory
        // index. If the crate has a `for_tests()` constructor, use it;
        // otherwise open a tmpfile via `tempfile::NamedTempFile`.
        let path = std::env::temp_dir().join(format!("cubical-index-test-{}.db",
            std::process::id()));
        let _ = std::fs::remove_file(&path);
        open_index(&path).expect("open")
    }

    fn row(target_raw: &str, target_path: Option<&str>) -> LinkRow {
        LinkRow {
            target_raw: target_raw.into(),
            target_path: target_path.map(String::from),
            anchor_kind: None,
            anchor_value: None,
            display_text: None,
            is_embed: false,
            position: 0,
        }
    }

    #[test]
    fn replace_then_lookup_round_trip() {
        let mut conn = open_test_index();
        // Insert a file row so the FK is satisfied — use whatever
        // insert helper the `files` module exposes.
        crate::files::upsert_file(&mut conn, "a.md", "h", 0, 0)
            .expect("upsert file");
        let rows = vec![row("Other Note", Some("other.md"))];
        replace_links_for_file(&mut conn, "a.md", &rows).expect("replace");
        let got = links_from(&conn, "a.md").expect("lookup");
        assert_eq!(got, rows);
    }

    #[test]
    fn links_to_returns_backlinks() {
        let mut conn = open_test_index();
        crate::files::upsert_file(&mut conn, "a.md", "h", 0, 0).expect("upsert");
        crate::files::upsert_file(&mut conn, "b.md", "h", 0, 0).expect("upsert");
        let rows_a = vec![row("Target", Some("target.md"))];
        let rows_b = vec![row("Target", Some("target.md"))];
        replace_links_for_file(&mut conn, "a.md", &rows_a).expect("a");
        replace_links_for_file(&mut conn, "b.md", &rows_b).expect("b");
        let back = links_to(&conn, "target.md").expect("backlinks");
        assert_eq!(back.len(), 2);
    }

    #[test]
    fn replace_is_atomic() {
        let mut conn = open_test_index();
        crate::files::upsert_file(&mut conn, "a.md", "h", 0, 0).expect("upsert");
        replace_links_for_file(
            &mut conn,
            "a.md",
            &[row("Old", Some("old.md"))],
        ).expect("first");
        replace_links_for_file(
            &mut conn,
            "a.md",
            &[row("New", Some("new.md"))],
        ).expect("second");
        let got = links_from(&conn, "a.md").expect("lookup");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].target_raw, "New");
    }
}
```

**Important:** the test calls `crate::files::upsert_file(...)` — that helper may live in a different module name in this codebase. Adjust the test's setup to whichever existing helper inserts a `files` row; the FK is the only constraint.

- [ ] **Step 2: Wire the module + run; confirm FAIL.**

In `crates/cubical-index/src/lib.rs`:

```rust
mod links;
pub use links::{links_from, links_to, replace_links_for_file, LinkRow};
```

Then:

```bash
cargo test -p cubical-index links::
```

Expected: the three new tests FAIL (the functions are `todo!()`).

- [ ] **Step 3: Implement the queries.**

Replace the three `todo!()` bodies with libSQL queries. The exact API to use lives in `runner.rs` (`IndexConn`); read it to see whether it exposes `execute` + `query` (rusqlite-style) or a `transaction(|tx| ...)` closure. Typical shape:

```rust
pub fn replace_links_for_file(
    conn: &mut IndexConn,
    source_path: &str,
    rows: &[LinkRow],
) -> Result<(), IndexError> {
    conn.transaction(|tx| {
        tx.execute("DELETE FROM links WHERE source_path = ?1", [source_path])?;
        let mut insert = tx.prepare(
            "INSERT INTO links \
             (source_path, target_raw, target_path, anchor_kind, anchor_value, display_text, is_embed, position) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for r in rows {
            insert.execute(libsql::params![
                source_path,
                &r.target_raw,
                r.target_path.as_deref(),
                r.anchor_kind.as_deref(),
                r.anchor_value.as_deref(),
                r.display_text.as_deref(),
                r.is_embed as i64,
                r.position as i64,
            ])?;
        }
        Ok(())
    })
}

pub fn links_from(conn: &IndexConn, source_path: &str) -> Result<Vec<LinkRow>, IndexError> {
    let mut stmt = conn.prepare(
        "SELECT target_raw, target_path, anchor_kind, anchor_value, display_text, is_embed, position \
         FROM links WHERE source_path = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map([source_path], |r| {
        Ok(LinkRow {
            target_raw: r.get(0)?,
            target_path: r.get(1)?,
            anchor_kind: r.get(2)?,
            anchor_value: r.get(3)?,
            display_text: r.get(4)?,
            is_embed: r.get::<_, i64>(5)? != 0,
            position: r.get::<_, i64>(6)? as u64,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn links_to(conn: &IndexConn, target_path: &str) -> Result<Vec<LinkRow>, IndexError> {
    // Same shape as links_from but filtered on target_path.
    let mut stmt = conn.prepare(
        "SELECT target_raw, target_path, anchor_kind, anchor_value, display_text, is_embed, position \
         FROM links WHERE target_path = ?1 ORDER BY source_path, position",
    )?;
    let rows = stmt.query_map([target_path], |r| {
        Ok(LinkRow {
            target_raw: r.get(0)?,
            target_path: r.get(1)?,
            anchor_kind: r.get(2)?,
            anchor_value: r.get(3)?,
            display_text: r.get(4)?,
            is_embed: r.get::<_, i64>(5)? != 0,
            position: r.get::<_, i64>(6)? as u64,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}
```

Adjust the libSQL API calls to match what `IndexConn` actually exposes (the test failures from step 4 will tell you).

- [ ] **Step 4: Run; confirm GREEN.**

```bash
cargo test -p cubical-index
```

Expected: all green.

- [ ] **Step 5: Commit.**

```bash
git add crates/cubical-index/src/links.rs crates/cubical-index/src/lib.rs
git commit -m "feat(index): links query module (replace / from / to)"
```

---

### Task 9: Extract links from a parsed `Document`

A pure function in `cubical-core` that walks a `Document` and produces `Vec<LinkExtraction>` carrying everything `replace_links_for_file` needs.

**Files:**

- Create: `crates/cubical-core/src/vault/links.rs`
- Modify: `crates/cubical-core/src/vault/mod.rs`

- [ ] **Step 1: Write the failing test.**

Create `crates/cubical-core/src/vault/links.rs`:

```rust
//! Extract wiki-link occurrences from a parsed `cubical_ast::Document`.
//!
//! Pure: takes only the parsed document; emits one `LinkExtraction`
//! per `Inline::WikiLink` in source order. Resolution to a vault path
//! happens in the caller (the scan/watcher pipeline), which has the
//! file-list context the extractor lacks.

use cubical_ast::{Anchor, Block, Document, Inline, ListItem};

/// One wiki-link occurrence extracted from a `Document`.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkExtraction {
    pub target_raw: String,
    pub anchor: Option<Anchor>,
    pub display: Option<String>,
    pub is_embed: bool,
    /// Byte offset into the original source where the wiki-link begins.
    /// In Session A this is the start of the enclosing block's span —
    /// per-inline byte spans are post-L1 work. Good enough for the
    /// link index to order rows by appearance.
    pub position: u64,
}

/// Walk every block + inline tree in `doc` and yield the wiki-link
/// occurrences in source order.
pub fn extract_links(doc: &Document) -> Vec<LinkExtraction> {
    let mut out = Vec::new();
    for block in &doc.blocks {
        walk_block(block, &mut out);
    }
    out
}

fn walk_block(block: &Block, out: &mut Vec<LinkExtraction>) {
    match block {
        Block::Heading { inlines, span, .. } => walk_inlines(inlines, span.start as u64, out),
        Block::Paragraph { inlines, span } => walk_inlines(inlines, span.start as u64, out),
        Block::List { items, .. } => {
            for ListItem { blocks, .. } in items {
                for sub in blocks {
                    walk_block(sub, out);
                }
            }
        }
        Block::Quote { blocks, .. } => {
            for sub in blocks {
                walk_block(sub, out);
            }
        }
        Block::CodeBlock { .. } | Block::ThematicBreak { .. } | Block::Html { .. } => {}
    }
}

fn walk_inlines(inlines: &[Inline], pos: u64, out: &mut Vec<LinkExtraction>) {
    for inline in inlines {
        match inline {
            Inline::WikiLink { target, display, anchor, embed } => {
                out.push(LinkExtraction {
                    target_raw: target.clone(),
                    anchor: anchor.clone(),
                    display: display.clone(),
                    is_embed: *embed,
                    position: pos,
                });
            }
            Inline::Emph { children } | Inline::Strong { children } => {
                walk_inlines(children, pos, out);
            }
            Inline::Link { children, .. } => walk_inlines(children, pos, out),
            Inline::Image { alt, .. } => walk_inlines(alt, pos, out),
            Inline::Text { .. } | Inline::Code { .. } | Inline::LineBreak => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubical_ast::parse;

    #[test]
    fn extracts_simple_wikilink() {
        let doc = parse("see [[note]] for context\n");
        let links = extract_links(&doc);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_raw, "note");
        assert!(links[0].anchor.is_none());
        assert!(!links[0].is_embed);
    }

    #[test]
    fn extracts_embed_and_anchor() {
        let doc = parse("![[diagram]] and [[note#^id]]\n");
        let links = extract_links(&doc);
        assert_eq!(links.len(), 2);
        assert!(links[0].is_embed);
        assert!(matches!(links[1].anchor, Some(Anchor::Block { .. })));
    }

    #[test]
    fn extracts_from_headings_and_quotes() {
        let doc = parse("# Heading with [[link]]\n\n> quote with [[other]]\n");
        let links = extract_links(&doc);
        let targets: Vec<&str> = links.iter().map(|l| l.target_raw.as_str()).collect();
        assert_eq!(targets, vec!["link", "other"]);
    }
}
```

- [ ] **Step 2: Wire the module.**

In `crates/cubical-core/src/vault/mod.rs`:

```rust
pub mod links;
```

- [ ] **Step 3: Run; confirm GREEN.**

```bash
cargo test -p cubical-core vault::links::
```

Expected: all three tests PASS (the implementation is complete in the test file).

- [ ] **Step 4: Commit.**

```bash
git add crates/cubical-core/src/vault/links.rs crates/cubical-core/src/vault/mod.rs
git commit -m "feat(core): extract_links — walk a Document for WikiLink occurrences"
```

---

### Task 10: Link resolution — `target_raw → target_path`

A pure resolver. Given a `target_raw` and a slice of known vault-relative file paths, return the resolved path or `None`. Resolution order: exact match → case-insensitive basename match → unique path-suffix match.

**Files:**

- Modify: `crates/cubical-core/src/vault/links.rs` (add `resolve_target` + tests)

- [ ] **Step 1: Add the failing test.**

Append to `crates/cubical-core/src/vault/links.rs` `#[cfg(test)] mod tests`:

```rust
#[test]
fn resolve_exact_match() {
    let files = vec!["notes/Other Note.md".to_string()];
    assert_eq!(
        resolve_target("notes/Other Note.md", &files).as_deref(),
        Some("notes/Other Note.md"),
    );
}

#[test]
fn resolve_basename_case_insensitive() {
    let files = vec!["notes/other-note.md".to_string()];
    assert_eq!(
        resolve_target("Other-Note", &files).as_deref(),
        Some("notes/other-note.md"),
    );
}

#[test]
fn resolve_unique_suffix() {
    let files = vec![
        "deeply/nested/path/foo.md".to_string(),
        "bar.md".to_string(),
    ];
    assert_eq!(
        resolve_target("path/foo", &files).as_deref(),
        Some("deeply/nested/path/foo.md"),
    );
}

#[test]
fn resolve_ambiguous_returns_none() {
    let files = vec!["a/note.md".to_string(), "b/note.md".to_string()];
    assert!(resolve_target("note", &files).is_none(),
        "ambiguous basename match must not resolve");
}

#[test]
fn resolve_missing_returns_none() {
    let files = vec!["a.md".to_string()];
    assert!(resolve_target("nope", &files).is_none());
}
```

- [ ] **Step 2: Run; confirm FAIL.**

```bash
cargo test -p cubical-core vault::links::tests::resolve_
```

Expected: compile error — `resolve_target` not defined.

- [ ] **Step 3: Implement `resolve_target`.**

Add to `crates/cubical-core/src/vault/links.rs` (above the `#[cfg(test)]` block):

```rust
/// Resolve a wiki-link `target_raw` against the known vault file list.
///
/// Resolution order:
/// 1. Exact vault-relative path match (with or without `.md`).
/// 2. Unique basename match, case-insensitive (basename = last path
///    segment, with or without the `.md` suffix).
/// 3. Unique path-suffix match (`files.iter().any(ends_with)`),
///    case-insensitive.
///
/// Returns `None` for no match or for ambiguous matches at levels 2/3.
/// The file list is borrowed; the caller owns it (typically a snapshot
/// from `files` table or a `cubical-core::vault::Vault::list_files()`).
pub fn resolve_target(target_raw: &str, files: &[String]) -> Option<String> {
    let target = target_raw.trim();
    if target.is_empty() {
        return None;
    }
    // 1) exact (with or without .md)
    for f in files {
        if f == target {
            return Some(f.clone());
        }
        if let Some(stem) = f.strip_suffix(".md") {
            if stem == target {
                return Some(f.clone());
            }
        }
    }
    let target_lower = target.to_lowercase();
    // 2) unique basename (case-insensitive)
    let mut basename_matches: Vec<&String> = files
        .iter()
        .filter(|f| {
            let base = f.rsplit('/').next().unwrap_or(f);
            let base_no_ext = base.strip_suffix(".md").unwrap_or(base);
            base_no_ext.to_lowercase() == target_lower
                || base.to_lowercase() == target_lower
        })
        .collect();
    if basename_matches.len() == 1 {
        return Some(basename_matches.remove(0).clone());
    } else if basename_matches.len() > 1 {
        return None;
    }
    // 3) unique path-suffix (case-insensitive)
    let mut suffix_matches: Vec<&String> = files
        .iter()
        .filter(|f| f.to_lowercase().ends_with(&target_lower))
        .collect();
    if suffix_matches.len() == 1 {
        return Some(suffix_matches.remove(0).clone());
    }
    None
}
```

- [ ] **Step 4: Run; confirm GREEN.**

```bash
cargo test -p cubical-core vault::links::
```

Expected: all tests (extract_* + resolve_*) PASS.

- [ ] **Step 5: Commit.**

```bash
git add crates/cubical-core/src/vault/links.rs
git commit -m "feat(core): resolve_target — exact / basename-ci / unique-suffix"
```

---

### Task 11: Plumb extraction into the scan + watcher write paths

When a file is scanned or modified, parse it, extract links, resolve each one against the current file list, and `replace_links_for_file` the result.

**Files:**

- Modify: `crates/cubical-core/src/vault/scan.rs`
- Modify: `crates/cubical-core/src/vault/watcher.rs`

- [ ] **Step 1: Read both files to find the existing write site.**

The L2 work landed link-less inserts into the `files` table during scan and on watcher events. Locate the exact functions (likely `apply_watch_event_to_db` in `watcher.rs`, and a per-file write inside `scan.rs`).

- [ ] **Step 2: Write a failing integration test.**

In `crates/cubical-core/src/vault/scan.rs` (or wherever existing scan tests live), add:

```rust
#[test]
fn scan_populates_links_table() {
    use crate::vault::Vault;
    use cubical_index::links_from;
    let tmp = tempfile::tempdir().expect("tmp");
    std::fs::write(tmp.path().join("a.md"), "see [[b]] for more\n").unwrap();
    std::fs::write(tmp.path().join("b.md"), "body\n").unwrap();
    let vault = Vault::open(tmp.path()).expect("open");
    // Whichever scan API the crate exposes:
    vault.scan().expect("scan");
    let links = links_from(vault.index(), "a.md").expect("query");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "b");
    assert_eq!(links[0].target_path.as_deref(), Some("b.md"));
}
```

(Adjust the constructor names to match the actual crate surface — `Vault::open` / `vault.scan()` / `vault.index()` may be named differently. The intent is: open a small vault with two files, scan, query the links table.)

- [ ] **Step 3: Run; confirm FAIL.**

```bash
cargo test -p cubical-core scan_populates_links_table
```

Expected: FAIL (extraction not wired yet).

- [ ] **Step 4: Wire extraction into scan.**

Inside the existing per-file scan handler (after the `files`-table upsert for a given path), add:

```rust
// Extract wiki-links and update the link index for this file.
let doc = cubical_ast::parse(&file_contents);
let extractions = crate::vault::links::extract_links(&doc);
let known_files: Vec<String> = list_known_paths(conn)?;  // or whatever helper
let rows: Vec<cubical_index::LinkRow> = extractions
    .into_iter()
    .map(|e| {
        let target_path = crate::vault::links::resolve_target(&e.target_raw, &known_files);
        cubical_index::LinkRow {
            target_raw: e.target_raw,
            target_path,
            anchor_kind: e.anchor.as_ref().map(|a| match a {
                cubical_ast::Anchor::Heading { .. } => "heading".to_string(),
                cubical_ast::Anchor::Block { .. } => "block".to_string(),
            }),
            anchor_value: e.anchor.map(|a| match a {
                cubical_ast::Anchor::Heading { value } | cubical_ast::Anchor::Block { value } => value,
            }),
            display_text: e.display,
            is_embed: e.is_embed,
            position: e.position,
        }
    })
    .collect();
cubical_index::replace_links_for_file(conn, &path_str, &rows)?;
```

Use the existing helper for listing known file paths if one exists; otherwise add a small one in `crates/cubical-index/src/files.rs` (or wherever `files` queries live).

- [ ] **Step 5: Wire the same call into `watcher.rs` for Created + Modified events.**

In `apply_watch_event_to_db` (the function that already handles file-changed events), call the same extraction + `replace_links_for_file` after the existing `files` row update. For `Removed` events, the `ON DELETE CASCADE` on the FK takes care of cleanup — no explicit call needed.

For `Renamed`, the existing rename handler should update the `files.path` first; the link rows then cascade or stay as-is. Session J (Pending Rewrites) is the proper home for rename-driven link rewrites; in Session A, a rename simply leaves the link rows pointing at the old path (resolution will fail next read) — acceptable, will be fixed at Session J.

- [ ] **Step 6: Run; confirm GREEN.**

```bash
cargo test -p cubical-core scan_populates_links_table
cargo test --workspace
```

Expected: the new test PASSES, the whole workspace stays green.

- [ ] **Step 7: Commit.**

```bash
git add crates/cubical-core/src/vault/scan.rs crates/cubical-core/src/vault/watcher.rs
git commit -m "feat(core): extract + index wiki-links on scan and file change"
```

---

### Task 12: `resolve_link` IPC

A request/response IPC that takes a `target_raw` and (optionally) a `source_path` for relative resolution context, and returns the resolved path + anchor.

**Files:**

- Modify: `crates/cubical-app/src/api/types.rs`
- Create: `crates/cubical-app/src/commands/links.rs`
- Modify: `crates/cubical-app/src/lib.rs` (register the Tauri shim)
- Modify: `crates/cubical-app/src/commands/mod.rs` (if such a module exists; otherwise the `commands` directory) to expose `links`.

- [ ] **Step 1: Write the failing IPC test.**

In `crates/cubical-app/src/commands/links.rs` (new file) write the pure handler + tests stub:

```rust
//! `resolve_link` IPC — looks up a wiki-link target against the live
//! files table and returns the resolved path + anchor.

use serde::{Deserialize, Serialize};

use crate::api::types::{ResolveLinkRequest, ResolveLinkResponse, ResolvedAnchor};

/// Pure handler for `resolve_link`. Splits the request's `target_raw`
/// into its anchor (if any) and resolves the target against the vault's
/// known files via `cubical_core::vault::links::resolve_target`.
pub fn resolve_link(
    state: &crate::CommandsState,
    req: ResolveLinkRequest,
) -> Result<ResolveLinkResponse, crate::CubicalError> {
    let vault = state.vault(&req.vault_id)?;
    let known: Vec<String> = vault.list_paths()?;
    // Reuse the same grammar parsing from the AST tokenizer — invoke
    // `cubical_ast::wikilink::scan_wikilinks` and pick the first
    // (and only) WikiLink in a synthesised "[[REQ]]" input.
    // (Alternative: implement a tiny anchor splitter here. The test
    // suite below pins the behaviour either way.)
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_link_returns_path_for_known_file() {
        // Construct a CommandsState with a vault containing "b.md"
        // (use whatever test harness the crate already provides for
        // commands; the L2 write_file_text tests are the precedent).
        // Then call resolve_link with target_raw="b" and expect
        // target_path = Some("b.md").
        // …
    }

    #[test]
    fn resolve_link_returns_none_for_unknown() {
        // target_raw="nope" returns None.
    }

    #[test]
    fn resolve_link_strips_and_returns_anchor() {
        // target_raw="b#heading" returns
        // target_path=Some("b.md"), anchor=Some({heading, "heading"}).
    }
}
```

In `crates/cubical-app/src/api/types.rs`, add the wire types:

```rust
/// Request for `resolve_link`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ResolveLinkRequest {
    pub vault_id: String,
    /// The wiki-link target as written, e.g. `note`, `note#heading`,
    /// `note#^id`. Embeds drop the leading `!`.
    pub target_raw: String,
    /// Optional context for future relative resolution (unused in
    /// Session A; reserved).
    pub source_path: Option<String>,
}

/// Response for `resolve_link`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ResolveLinkResponse {
    /// Resolved vault-relative path, or `None` if no unique match.
    pub target_path: Option<String>,
    /// The parsed anchor if the target had one.
    pub anchor: Option<ResolvedAnchor>,
}

/// IPC-shape mirror of `cubical_ast::Anchor`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedAnchor {
    Heading { value: String },
    Block { value: String },
}
```

- [ ] **Step 2: Run; confirm FAIL.**

```bash
cargo test -p cubical-app resolve_link
```

Expected: compile error (`todo!()` + missing impl).

- [ ] **Step 3: Implement the handler.**

Replace the `todo!()` body. The cleanest version reuses the AST tokenizer:

```rust
pub fn resolve_link(
    state: &crate::CommandsState,
    req: ResolveLinkRequest,
) -> Result<ResolveLinkResponse, crate::CubicalError> {
    use cubical_ast::{Anchor as AstAnchor};
    let vault = state.vault(&req.vault_id)?;
    let known: Vec<String> = vault.list_paths()?;
    // Parse the target by feeding "[[REQ]]" through the same tokenizer
    // that the AST uses. This guarantees identical grammar.
    let synthetic = format!("[[{}]]", req.target_raw);
    let runs = cubical_ast::wikilink::scan_wikilinks(&synthetic);
    let (target_raw, anchor) = match runs.into_iter().next() {
        Some(cubical_ast::wikilink::TokenizedRun::WikiLink { target, anchor, .. }) => {
            (target, anchor)
        }
        _ => (req.target_raw.clone(), None),
    };
    let target_path = cubical_core::vault::links::resolve_target(&target_raw, &known);
    let resolved_anchor = anchor.map(|a| match a {
        AstAnchor::Heading { value } => ResolvedAnchor::Heading { value },
        AstAnchor::Block { value } => ResolvedAnchor::Block { value },
    });
    Ok(ResolveLinkResponse {
        target_path,
        anchor: resolved_anchor,
    })
}
```

If `cubical_ast::wikilink` is not `pub`, expose just the needed surface: add `pub mod wikilink;` in `crates/cubical-ast/src/lib.rs` (replacing the bare `mod wikilink;` from Task 2) and document that this is the L3 grammar-reuse contract.

Flesh out the three test bodies using the same `CommandsState` test harness L2 used in `write_file_text` tests — set up a vault with `b.md` (and for the anchor test, just rely on `resolve_target` returning `b.md` regardless of anchor).

- [ ] **Step 4: Register the Tauri shim.**

In `crates/cubical-app/src/lib.rs`, add the shim function and register it in `invoke_handler`:

```rust
#[tauri::command]
async fn resolve_link(
    state: tauri::State<'_, CommandsState>,
    req: ResolveLinkRequest,
) -> Result<ResolveLinkResponse, CubicalError> {
    crate::commands::links::resolve_link(&state, req)
}
```

…and in the `tauri::Builder` setup, append `resolve_link` to the `generate_handler!` list.

- [ ] **Step 5: Run; confirm GREEN.**

```bash
cargo test -p cubical-app
cargo test --workspace
```

Expected: green.

- [ ] **Step 6: Commit.**

```bash
git add crates/cubical-app/src/api/types.rs crates/cubical-app/src/commands/links.rs \
        crates/cubical-app/src/commands/mod.rs crates/cubical-app/src/lib.rs \
        crates/cubical-ast/src/lib.rs
git commit -m "feat(app): resolve_link IPC (pure handler + Tauri shim)"
```

---

### Task 13: `resolveLink` TS wrapper

The frontend's typed entry point for the new IPC.

**Files:**

- Modify: `ui/src/api/ipc.ts`

- [ ] **Step 1: Add the failing typecheck.**

There is no vitest case for IPC wrappers (they call `@tauri-apps/api/core` `invoke`); `npx tsc --noEmit` is the check. Define the wrapper first; tsc will fail if types don't align.

Add to `ui/src/api/ipc.ts` (matching the existing `writeFileText` pattern):

```ts
/** Mirror of cubical_app::api::types::ResolvedAnchor. */
export type ResolvedAnchor =
  | { kind: "heading"; value: string }
  | { kind: "block"; value: string };

export interface ResolveLinkRequest {
  vault_id: string;
  /** The wiki-link target as written (e.g. `note`, `note#heading`, `note#^id`). */
  target_raw: string;
  /** Reserved for future relative resolution; ignored in L3 Session A. */
  source_path?: string;
}

export interface ResolveLinkResponse {
  target_path: string | null;
  anchor: ResolvedAnchor | null;
}

/**
 * Resolve a wiki-link target to a vault-relative path via the libSQL
 * link index. Returns `target_path: null` when no unique match exists.
 */
export async function resolveLink(
  req: ResolveLinkRequest,
): Promise<ResolveLinkResponse> {
  // Build the request object conditionally so `exactOptionalPropertyTypes`
  // doesn't reject an explicit `undefined` source_path. (Mirrors the
  // Session A `writeFileText` wrapper's pattern.)
  const payload: Record<string, unknown> = {
    vault_id: req.vault_id,
    target_raw: req.target_raw,
  };
  if (req.source_path != null) {
    payload.source_path = req.source_path;
  }
  return invoke<ResolveLinkResponse>("resolve_link", { req: payload });
}
```

- [ ] **Step 2: Run typecheck + build.**

```bash
cd ui && npx tsc --noEmit && npm run build
```

Expected: both clean.

- [ ] **Step 3: Run vitest as a no-regression check.**

```bash
cd ui && npx vitest run
```

Expected: 122 passed.

- [ ] **Step 4: Commit.**

```bash
git add ui/src/api/ipc.ts
git commit -m "feat(ipc): resolveLink TS wrapper + ResolvedAnchor types"
```

---

### Task 14: Session A closeout — fill §9.1 + rewrite CLAUDE.md project state

**Files:**

- Modify: `docs/layer-3-spec.md` (§9.1)
- Modify: `CLAUDE.md` (project state)

- [ ] **Step 1: Run the full gate suite one final time.**

```bash
cargo test --workspace && \
  cargo clippy --workspace --all-targets -- -D warnings && \
  cargo fmt --check && \
  (cd ui && npx tsc --noEmit && npm run build && npx vitest run)
```

Expected: all green. Record the exact counts (Rust + vitest).

- [ ] **Step 2: Fill `docs/layer-3-spec.md` §9.1 with what was built.**

Replace the `*Pending.*` under "### 9.1 Session A — Wiki-link parsing + link index" with a write-up matching the L2 §9.x voice:

- Subsections to cover: AST changes (Anchor + WikiLink variant + parity), the Rust + TS tokenizers (`scan_wikilinks` / `scanWikilinks`), `normalize` integration, parity-fixture additions, the `003_links.sql` migration, the `links` query module, `extract_links` + `resolve_target` in cubical-core, the scan/watcher wiring, the `resolve_link` IPC, and the `resolveLink` TS wrapper.
- Include the final test counts and a single-line per noteworthy decision (e.g. grammar precedence — anchor before pipe; resolution order — exact / basename-ci / unique suffix).

- [ ] **Step 3: Rewrite the `CLAUDE.md` "Project state" block.**

Replace the existing block with one that records: current layer 3 — Knowledge Graph (Session A done, Sessions B–K pending), the final test counts, what Session A landed, and "Next: L3 Session B — Wiki-link Live Preview + click-to-navigate." Per the protocol: **rewrite, do not append.** Keep to 4–6 lines.

- [ ] **Step 4: Commit.**

```bash
git add docs/layer-3-spec.md CLAUDE.md
git commit -m "docs: L3 Session A complete — wiki-link parsing + link index"
```

- [ ] **Step 5: Apply the per-session tag (optional per project convention).**

L2 sessions did not tag per session (only the layer tag `l2`). Skip a per-session tag; the `l3` tag is applied at the Session K closeout.

- [ ] **Step 6: Invoke `superpowers:finishing-a-development-branch`** to merge the Session A branch back to `main` (the L2 pattern: each session = its own branch → merge with `--no-ff` into main).

---

## Self-review checklist (run inline after writing the plan)

- **Spec coverage.** Every Session A scope item from `docs/layer-3-spec.md` §8 is covered by at least one task above:
  - Rust parser extension → Tasks 1, 2, 3.
  - TS normalizer parity → Tasks 1, 4, 5, 6.
  - `links` table + migration → Task 7.
  - Link extraction on scan + change → Tasks 9, 11.
  - Link resolution → Task 10.
  - `resolve_link` IPC → Tasks 12, 13.
  - L1 parity contract maintained → Task 6.

- **Placeholder scan.** Every step shows the code/SQL/commands needed. Two carve-outs to be aware of:
  - Task 8 step 1 calls `crate::files::upsert_file` — that exact helper name may differ in this codebase. The plan flags it explicitly so the executor adjusts to the local convention.
  - Task 11 references vault constructor names (`Vault::open`, `vault.scan()`, `vault.index()`) that may not match the local API; the plan flags this in step 2.
  - Neither is a placeholder for missing design — both are honest "match the existing call site" pointers.

- **Type consistency.** `Inline::WikiLink { target, display, anchor, embed }` is the same shape in Rust and TS, and the IPC `ResolvedAnchor` mirrors `cubical_ast::Anchor` with `#[serde(tag = "kind", rename_all = "snake_case")]`. `LinkRow` fields match the `003_links.sql` columns one-for-one. `scan_wikilinks` (Rust) and `scanWikilinks` (TS) take a string and return the same `TokenizedRun` shape.

- **Migration number.** `003_links.sql` confirmed against the actual `crates/cubical-index/migrations/` contents (002 is `frontmatter.sql` from L1).

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-23-l3-session-a-wikilink-parsing.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between tasks, fast iteration. Uses `superpowers:subagent-driven-development`.

**2. Inline Execution** — execute the tasks in this session via `superpowers:executing-plans`, batched with checkpoints for review.

**Which approach?**
