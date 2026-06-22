# Property Reference Interpolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a frontmatter value inline, read-only, at display time — `[[Gandalf.age]]` pulls note *Gandalf*'s top-level `age`; `[[.age]]` pulls the current note's `age`.

**Architecture:** Extend the parity-locked wiki-link tokenizer to branch on a `.` in the target, producing a new canonical AST node `Inline::PropertyRef`. Self-refs resolve synchronously from the open document's frontmatter; cross-file refs resolve on-demand through a new `get_property` IPC behind an embed-style caching resolver. A CodeMirror inline-replace widget renders the resolved scalar (broken-ref styling on miss). Gated behind a core-plugin toggle.

**Tech Stack:** Rust (`pulldown-cmark`, `serde`, Tauri commands, libSQL), TypeScript/Solid, CodeMirror 6, `@lezer/markdown`, vitest, cargo test.

## Global Constraints

- **Rust↔TS parity is load-bearing.** Every tokenizer/AST/normalize change lands in both `crates/cubical-ast/src/*.rs` and `ui/src/ast/*.ts` in the same task, and the parity harness (`crates/cubical-ast/tests/fixtures/parity.json`) must stay green.
- **Display-time only.** Never write the resolved value into the `.md`. The source keeps the literal `[[…]]` token byte-for-byte.
- **No type-registry dependency.** v1 renders the raw frontmatter scalar as text. Do not import or block on typed-properties code.
- **Top-level keys only.** Split the target at the **first** dot; the property is the remainder, looked up as a single top-level frontmatter key.
- **Resolve on-demand, never index.** Property values are not written to libSQL; cross-file resolution mirrors the embed resolver's fetch+invalidate pattern.
- Gate: `scripts/check.sh` (fmt, clippy, cargo test, tsc, vitest, build, docs) must pass before closeout.
- Spec: [`docs/superpowers/specs/2026-06-20-property-reference-interpolation-design.md`](../specs/2026-06-20-property-reference-interpolation-design.md).

---

### Task 1: Tokenizer — property-ref branch (Rust + TS)

**Files:**
- Modify: `crates/cubical-ast/src/wikilink.rs`
- Modify: `ui/src/ast/wikilink.ts`
- Test: inline `#[cfg(test)]` in `wikilink.rs`; `ui/src/ast/wikilink.test.ts`

**Interfaces:**
- Produces (Rust): new variant `TokenizedRun::PropertyRef { note: Option<String>, property: String }`.
- Produces (TS): new run `{ kind: "property_ref"; note: string | null; property: string }` added to the `TokenizedRun` union.
- Rule: in `parse_body`, after computing the trimmed `target` and `anchor` — **if `anchor` is `None` AND `target` contains `.`**: split `target` at the first `.`. `property` = trimmed remainder; if `property` is empty, return `None` (pass through as text). `note` = trimmed left side, or `None` when empty (the `[[.age]]` self form). Otherwise fall through to the existing `WikiLink` path. Display text is ignored for property refs in v1.

- [ ] **Step 1: Write failing Rust tests**

Add to the `tests` module in `crates/cubical-ast/src/wikilink.rs`:

```rust
fn pref(note: Option<&str>, property: &str) -> TokenizedRun {
    TokenizedRun::PropertyRef {
        note: note.map(|s| s.to_string()),
        property: property.to_string(),
    }
}

#[test]
fn cross_file_property_ref() {
    assert_eq!(scan_wikilinks("[[Gandalf.age]]"), vec![pref(Some("Gandalf"), "age")]);
}

#[test]
fn self_property_ref() {
    assert_eq!(scan_wikilinks("[[.age]]"), vec![pref(None, "age")]);
}

#[test]
fn property_ref_splits_on_first_dot_only() {
    // Top-level only: remainder kept verbatim, won't resolve later.
    assert_eq!(scan_wikilinks("[[a.b.c]]"), vec![pref(Some("a"), "b.c")]);
}

#[test]
fn empty_property_falls_back_to_text() {
    assert_eq!(scan_wikilinks("[[Gandalf.]]"), vec![text("[[Gandalf.]]")]);
    assert_eq!(scan_wikilinks("[[.]]"), vec![text("[[.]]")]);
}

#[test]
fn dotted_target_with_anchor_stays_wikilink() {
    // Anchor present → not a property ref (broken link later; acceptable).
    assert!(matches!(
        scan_wikilinks("[[Gandalf.age#h]]").as_slice(),
        [TokenizedRun::WikiLink { .. }]
    ));
}
```

- [ ] **Step 2: Run, verify they fail to compile / fail**

Run: `cargo test -p cubical-ast wikilink`
Expected: FAIL — `PropertyRef` variant does not exist.

- [ ] **Step 3: Add the Rust variant + branch**

In `crates/cubical-ast/src/wikilink.rs`, add to the `TokenizedRun` enum:

```rust
    /// A frontmatter property reference: `[[note.prop]]` (cross-file) or
    /// `[[.prop]]` (self, `note == None`). Top-level key only; split at
    /// the first dot.
    PropertyRef {
        /// Resolved note name, or `None` for a self-reference.
        note: Option<String>,
        /// Property (frontmatter key) name, trimmed, non-empty.
        property: String,
    },
```

Replace the tail of `parse_body` (from `let target = target_raw.trim();` onward) with:

```rust
    let target = target_raw.trim();
    if target.is_empty() {
        return None;
    }
    // Property-ref branch: a dotted target with no anchor is a frontmatter
    // reference, not a navigational link. Split at the FIRST dot.
    if anchor.is_none() {
        if let Some(dot) = target.find('.') {
            let note_raw = target[..dot].trim();
            let property = target[dot + 1..].trim();
            if property.is_empty() {
                return None;
            }
            return Some(TokenizedRun::PropertyRef {
                note: if note_raw.is_empty() {
                    None
                } else {
                    Some(note_raw.to_string())
                },
                property: property.to_string(),
            });
        }
    }
    Some(TokenizedRun::WikiLink {
        target: target.to_string(),
        display,
        anchor,
        embed: is_embed,
    })
```

- [ ] **Step 4: Run Rust tests, verify pass**

Run: `cargo test -p cubical-ast wikilink`
Expected: PASS (all, including the new five).

- [ ] **Step 5: Write failing TS tests**

Add to `ui/src/ast/wikilink.test.ts`:

```ts
it("parses a cross-file property ref", () => {
  expect(scanWikilinks("[[Gandalf.age]]")).toEqual([
    { kind: "property_ref", note: "Gandalf", property: "age" },
  ]);
});

it("parses a self property ref", () => {
  expect(scanWikilinks("[[.age]]")).toEqual([
    { kind: "property_ref", note: null, property: "age" },
  ]);
});

it("splits a property ref on the first dot only", () => {
  expect(scanWikilinks("[[a.b.c]]")).toEqual([
    { kind: "property_ref", note: "a", property: "b.c" },
  ]);
});

it("falls back to text for an empty property", () => {
  expect(scanWikilinks("[[Gandalf.]]")).toEqual([
    { kind: "text", value: "[[Gandalf.]]" },
  ]);
});
```

- [ ] **Step 6: Run, verify fail**

Run: `cd ui && npx vitest run src/ast/wikilink.test.ts`
Expected: FAIL — runs don't carry `property_ref`.

- [ ] **Step 7: Mirror the branch in TS**

In `ui/src/ast/wikilink.ts`, extend `TokenizedRun`:

```ts
export type TokenizedRun =
  | { kind: "text"; value: string }
  | {
      kind: "wiki_link";
      target: string;
      display: string | null;
      anchor: Anchor | null;
      embed: boolean;
    }
  | { kind: "property_ref"; note: string | null; property: string };
```

Replace the tail of `parseBody` (from `const target = targetRaw.trim();`):

```ts
  const target = targetRaw.trim();
  if (target.length === 0) return null;
  if (anchor === null) {
    const dot = target.indexOf(".");
    if (dot >= 0) {
      const noteRaw = target.slice(0, dot).trim();
      const property = target.slice(dot + 1).trim();
      if (property.length === 0) return null;
      return {
        kind: "property_ref",
        note: noteRaw.length === 0 ? null : noteRaw,
        property,
      };
    }
  }
  return { kind: "wiki_link", target, display, anchor, embed };
```

- [ ] **Step 8: Run TS tests, verify pass**

Run: `cd ui && npx vitest run src/ast/wikilink.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add crates/cubical-ast/src/wikilink.rs ui/src/ast/wikilink.ts ui/src/ast/wikilink.test.ts
git commit -m "feat(ast): tokenize [[note.prop]] / [[.prop]] as property refs"
```

---

### Task 2: Canonical AST node + normalize mapping (Rust + TS)

**Files:**
- Modify: `crates/cubical-ast/src/types.rs` (add `Inline::PropertyRef`)
- Modify: `crates/cubical-ast/src/normalize.rs` (`split_inlines` mapping + the test's exhaustive match)
- Modify: `ui/src/ast/types.ts` (add `property_ref` to `Inline` union)
- Modify: `ui/src/ast/normalize.ts` (`splitInlines` mapping)
- Test: inline Rust test in `normalize.rs`; `ui/src/ast/normalize.test.ts`

**Interfaces:**
- Produces (Rust): `Inline::PropertyRef { note: Option<String>, property: String }`, `#[serde(tag = "kind", rename_all = "snake_case")]` → wire shape `{"kind":"property_ref","note":...,"property":...}`.
- Produces (TS): `{ kind: "property_ref"; note: string | null; property: string }` in the `Inline` union.
- Consumes: `TokenizedRun::PropertyRef` / `{ kind: "property_ref" }` from Task 1.

- [ ] **Step 1: Write failing Rust test**

Add to the `tests` module in `crates/cubical-ast/src/normalize.rs`:

```rust
#[test]
fn property_refs_become_inline_nodes() {
    let doc = parse("Age: [[Gandalf.age]] and [[.level]].\n");
    let Block::Paragraph { inlines, .. } = &doc.blocks[0] else {
        panic!("expected paragraph");
    };
    let refs: Vec<(Option<&str>, &str)> = inlines
        .iter()
        .filter_map(|i| match i {
            Inline::PropertyRef { note, property } => {
                Some((note.as_deref(), property.as_str()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(refs, vec![(Some("Gandalf"), "age"), (None, "level")]);
}
```

- [ ] **Step 2: Run, verify fail to compile**

Run: `cargo test -p cubical-ast property_refs_become_inline_nodes`
Expected: FAIL — `Inline::PropertyRef` does not exist; the existing `kinds` match in `emph_strong_link_image_inlines_round_trip` will also need an arm (compiler will flag).

- [ ] **Step 3: Add the Rust `Inline` variant**

In `crates/cubical-ast/src/types.rs`, add to the `Inline` enum (after `WikiLink`):

```rust
    /// `[[note.prop]]` / `[[.prop]]` — a read-only frontmatter value
    /// reference, resolved at display time. `note == None` is a
    /// self-reference (current note). Top-level key only. See
    /// `docs/superpowers/specs/2026-06-20-property-reference-interpolation-design.md`.
    PropertyRef {
        /// Target note name, or `None` for a self-reference.
        note: Option<String>,
        /// Top-level frontmatter key to read.
        property: String,
    },
```

- [ ] **Step 4: Map the run in `split_inlines` (Rust)**

In `crates/cubical-ast/src/normalize.rs`, inside `split_inlines`, add an arm to the `match run` over `WikiRun`:

```rust
                        WikiRun::PropertyRef { note, property } => {
                            out.push(Inline::PropertyRef { note, property });
                        }
```

Also add the missing arm to the test helper match in `emph_strong_link_image_inlines_round_trip`:

```rust
                Inline::PropertyRef { .. } => "property_ref",
```

- [ ] **Step 5: Run Rust tests, verify pass**

Run: `cargo test -p cubical-ast`
Expected: PASS. If the compiler flags other exhaustive `match` over `Inline` elsewhere in `cubical-ast`, add a `PropertyRef` arm mirroring the `WikiLink` arm's behavior.

- [ ] **Step 6: Write failing TS test**

Add to `ui/src/ast/normalize.test.ts`:

```ts
it("normalizes property refs into inline nodes", () => {
  const doc = normalize("Age: [[Gandalf.age]] and [[.level]].\n");
  const para = doc.blocks[0];
  if (para.kind !== "paragraph") throw new Error("expected paragraph");
  const refs = para.inlines.filter((i) => i.kind === "property_ref");
  expect(refs).toEqual([
    { kind: "property_ref", note: "Gandalf", property: "age" },
    { kind: "property_ref", note: null, property: "level" },
  ]);
});
```

- [ ] **Step 7: Run, verify fail**

Run: `cd ui && npx vitest run src/ast/normalize.test.ts`
Expected: FAIL.

- [ ] **Step 8: Add the TS `Inline` variant + mapping**

In `ui/src/ast/types.ts`, add to the `Inline` union:

```ts
  | { kind: "property_ref"; note: string | null; property: string }
```

In `ui/src/ast/normalize.ts`, inside `splitInlines`, the loop that walks `scanWikilinks(inline.value)` runs only handles `"text"` and the else (wiki_link). Replace that inner branch so property refs pass through:

```ts
      for (const wikiRun of scanWikilinks(inline.value)) {
        if (wikiRun.kind === "text") {
          for (const tagRun of scanTags(wikiRun.value)) {
            out.push(tagRun as Inline);
          }
        } else if (wikiRun.kind === "property_ref") {
          out.push(wikiRun as Inline);
        } else {
          out.push(wikiRun as Inline);
        }
      }
```

- [ ] **Step 9: Run TS tests, verify pass**

Run: `cd ui && npx vitest run src/ast/normalize.test.ts`
Expected: PASS. Run `cd ui && npx tsc --noEmit` and fix any exhaustive-union errors over `Inline` (render paths added in later tasks; until then, a `property_ref` arm that renders its raw `[[…]]` text is the safe fallback).

- [ ] **Step 10: Commit**

```bash
git add crates/cubical-ast/src/types.rs crates/cubical-ast/src/normalize.rs ui/src/ast/types.ts ui/src/ast/normalize.ts ui/src/ast/normalize.test.ts
git commit -m "feat(ast): add Inline::PropertyRef and normalize mapping"
```

---

### Task 3: Cross-language parity fixtures

**Files:**
- Modify: `crates/cubical-ast/tests/fixtures/parity.json`
- Test: the existing parity harness (`cargo test -p cubical-ast` parity test + the TS parity test that reads the same fixtures — locate via `rg -l parity.json ui/`).

**Interfaces:** Consumes the AST shape from Tasks 1–2. No new code.

- [ ] **Step 1: Inspect the fixture format**

Run: `rg -n "property_ref|wiki_link" crates/cubical-ast/tests/fixtures/parity.json | head` and open the file to copy the exact entry shape (each fixture is a source string the harness parses on both sides and compares).

- [ ] **Step 2: Add fixture source strings**

Append these source strings as new fixture entries (matching the file's existing structure):

- `"Age is [[Gandalf.age]] today."`
- `"My level: [[.level]]."`
- `"Deep [[a.b.c]] ref."`
- `"Link to [[2026.06.20]] daily."` (a dotted target → property ref `note=2026, property=06.20`; documents that dotted filenames aren't link targets)
- `"Edge [[Gandalf.]] and [[.]] noise."` (both fall back to text)

- [ ] **Step 3: Run the parity harness (Rust + TS), verify pass**

Run: `cargo test -p cubical-ast` and `cd ui && npx vitest run` (parity test file).
Expected: PASS — identical AST from both normalizers for every new fixture.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-ast/tests/fixtures/parity.json
git commit -m "test(ast): parity fixtures for property refs"
```

---

### Task 4: Backend `get_property` IPC handler

**Files:**
- Create: `crates/cubical-app/src/commands/property_ref.rs`
- Modify: `crates/cubical-app/src/commands/mod.rs` (register the module)
- Modify: `crates/cubical-app/src/api/types.rs` (request/response types)
- Test: inline `#[cfg(test)]` in `property_ref.rs` (mirror `embeds.rs` test harness)

**Interfaces:**
- Produces: `pub async fn get_property(state: &AppState, req: GetPropertyRequest) -> Result<GetPropertyResponse, CubicalError>`.
- Types (in `api/types.rs`):
```rust
GetPropertyRequest  { vault_id: String, note_raw: String, property: String }
GetPropertyResponse { kind: PropertyRefKind, value: Option<String> }
enum PropertyRefKind { Resolved, NoteUnresolved, PropertyMissing }  // serde snake_case
```
- Consumes: `resolve_target`, `read_source_off_executor`, `materialize_on_read` (same imports as `embeds.rs`); `cubical_ast::parse` for frontmatter.
- Note: **cross-file only** — `note_raw` is always a concrete note name; self-refs (`note == None`) never reach IPC (resolved on the frontend in Task 8).

- [ ] **Step 1: Add the API types**

In `crates/cubical-app/src/api/types.rs`, mirroring `GetEmbedRequest`/`GetEmbedResponse`/`EmbedKind` (same derives + serde attrs):

```rust
#[derive(Debug, Clone, serde::Deserialize)]
pub struct GetPropertyRequest {
    pub vault_id: String,
    pub note_raw: String,
    pub property: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyRefKind {
    Resolved,
    NoteUnresolved,
    PropertyMissing,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GetPropertyResponse {
    pub kind: PropertyRefKind,
    /// The scalar rendered to a display string. `None` unless `Resolved`.
    pub value: Option<String>,
}
```

- [ ] **Step 2: Write the failing handler test**

Create `crates/cubical-app/src/commands/property_ref.rs` with the test module first (copy the `state_with_vault_at` + `scan` helpers from `embeds.rs`):

```rust
#[tokio::test]
async fn get_property_returns_scalar_value() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("Gandalf.md"), "---\nage: 2019\n---\nbody\n").unwrap();
    let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
    scan(&vault).await;
    let resp = get_property(&state, GetPropertyRequest {
        vault_id: "v1".into(), note_raw: "Gandalf".into(), property: "age".into(),
    }).await.expect("ok");
    assert!(matches!(resp.kind, PropertyRefKind::Resolved));
    assert_eq!(resp.value.as_deref(), Some("2019"));
}

#[tokio::test]
async fn get_property_missing_key() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("Gandalf.md"), "---\nage: 2019\n---\n").unwrap();
    let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
    scan(&vault).await;
    let resp = get_property(&state, GetPropertyRequest {
        vault_id: "v1".into(), note_raw: "Gandalf".into(), property: "ghost".into(),
    }).await.expect("ok");
    assert!(matches!(resp.kind, PropertyRefKind::PropertyMissing));
    assert!(resp.value.is_none());
}

#[tokio::test]
async fn get_property_unresolved_note() {
    let dir = tempdir().unwrap();
    let (_v, state) = state_with_vault_at(dir.path(), "v1").await;
    let resp = get_property(&state, GetPropertyRequest {
        vault_id: "v1".into(), note_raw: "Nobody".into(), property: "age".into(),
    }).await.expect("ok");
    assert!(matches!(resp.kind, PropertyRefKind::NoteUnresolved));
}
```

- [ ] **Step 3: Run, verify fail to compile**

Run: `cargo test -p cubical-app get_property`
Expected: FAIL — `get_property` undefined.

- [ ] **Step 4: Implement the handler**

Above the test module in `property_ref.rs` (file-doc + imports mirror `embeds.rs`, minus the anchor/block extractors):

```rust
//! Property-reference resolver (cross-file). Resolves `[[note.prop]]` to
//! the target note's top-level frontmatter scalar, rendered to a display
//! string. Self-refs (`[[.prop]]`) are resolved on the frontend and never
//! reach this command.

use cubical_ast::parse;
use cubical_core::vault::links::{read_source_off_executor, resolve_target};
use cubical_core::vault::pending::materialize_on_read;

use crate::api::types::{GetPropertyRequest, GetPropertyResponse, PropertyRefKind};
use crate::error::CubicalError;
use crate::state::AppState;

pub async fn get_property(
    state: &AppState,
    req: GetPropertyRequest,
) -> Result<GetPropertyResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let vault = open.vault.clone();
    drop(guard);

    let conn = vault.index().connection();
    let mut rows = conn.query("SELECT path FROM files ORDER BY path", ()).await?;
    let mut known: Vec<String> = Vec::new();
    while let Some(row) = rows.next().await? {
        known.push(row.get(0)?);
    }

    let Some(target_path) = resolve_target(&req.note_raw, &known) else {
        return Ok(GetPropertyResponse { kind: PropertyRefKind::NoteUnresolved, value: None });
    };

    let abs = vault.root().join(&target_path);
    let Some(on_disk) = read_source_off_executor(&abs).await else {
        return Ok(GetPropertyResponse { kind: PropertyRefKind::NoteUnresolved, value: None });
    };
    let source = materialize_on_read(vault.index(), &target_path, &on_disk).await?;

    let Some(fm) = parse(&source).frontmatter else {
        return Ok(GetPropertyResponse { kind: PropertyRefKind::PropertyMissing, value: None });
    };
    match fm.entries.iter().find(|(k, _)| k == &req.property) {
        Some((_, v)) => match scalar_to_display(v) {
            Some(value) => Ok(GetPropertyResponse { kind: PropertyRefKind::Resolved, value: Some(value) }),
            None => Ok(GetPropertyResponse { kind: PropertyRefKind::PropertyMissing, value: None }),
        },
        None => Ok(GetPropertyResponse { kind: PropertyRefKind::PropertyMissing, value: None }),
    }
}

/// Render a frontmatter scalar to display text. Strings pass through;
/// numbers/bools stringify; arrays of scalars join with ", "; objects and
/// null are treated as "not a scalar" (PropertyMissing). v1 — no typing.
fn scalar_to_display(v: &serde_json::Value) -> Option<String> {
    use serde_json::Value;
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(scalar_to_display).collect();
            if parts.is_empty() { None } else { Some(parts.join(", ")) }
        }
        Value::Object(_) | Value::Null => None,
    }
}
```

Register the module in `crates/cubical-app/src/commands/mod.rs`:

```rust
pub mod property_ref;
```

- [ ] **Step 5: Run, verify pass**

Run: `cargo test -p cubical-app get_property`
Expected: PASS (all three).

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-app/src/commands/property_ref.rs crates/cubical-app/src/commands/mod.rs crates/cubical-app/src/api/types.rs
git commit -m "feat(ipc): get_property handler for cross-file property refs"
```

---

### Task 5: Register the Tauri command + TS binding

**Files:**
- Modify: `crates/cubical-app/src/lib.rs` (the `#[tauri::command]` wrapper + `invoke_handler` list — follow the `get_embed` registration exactly; `rg -n "get_embed" crates/cubical-app/src/lib.rs`)
- Modify: `ui/src/api/ipc.ts` (add `getProperty` + request/response types, mirroring `getEmbed`)
- Test: `ui/src/api/property_ref.test.ts` (smoke, mirror `ui/src/api/dataview.test.ts`)

**Interfaces:**
- Produces (TS): `getProperty(req: GetPropertyRequest): Promise<GetPropertyResponse>` where
  `GetPropertyRequest = { vault_id: string; note_raw: string; property: string }` and
  `GetPropertyResponse = { kind: "resolved" | "note_unresolved" | "property_missing"; value: string | null }`.

- [ ] **Step 1: Register the Rust command**

In `crates/cubical-app/src/lib.rs`, add a `#[tauri::command]` wrapper next to the `get_embed` one (same async/state-extraction shape), e.g.:

```rust
#[tauri::command]
async fn get_property(
    state: tauri::State<'_, AppState>,
    req: crate::api::types::GetPropertyRequest,
) -> Result<crate::api::types::GetPropertyResponse, String> {
    crate::commands::property_ref::get_property(&state, req)
        .await
        .map_err(|e| e.to_string())
}
```

Add `get_property` to the `tauri::generate_handler![…]` list.

- [ ] **Step 2: Write the failing TS smoke test**

Create `ui/src/api/property_ref.test.ts` mirroring `dataview.test.ts` (mock `@tauri-apps/api/core` `invoke`):

```ts
import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { getProperty } from "./ipc";

describe("getProperty", () => {
  it("invokes get_property and returns the response", async () => {
    invoke.mockResolvedValueOnce({ kind: "resolved", value: "2019" });
    const resp = await getProperty({ vault_id: "v1", note_raw: "Gandalf", property: "age" });
    expect(invoke).toHaveBeenCalledWith("get_property", {
      req: { vault_id: "v1", note_raw: "Gandalf", property: "age" },
    });
    expect(resp).toEqual({ kind: "resolved", value: "2019" });
  });
});
```

(Confirm the arg-wrapping convention — `{ req }` vs flat — against how `getEmbed` calls `invoke` in `ipc.ts`, and match it.)

- [ ] **Step 3: Run, verify fail**

Run: `cd ui && npx vitest run src/api/property_ref.test.ts`
Expected: FAIL — `getProperty` not exported.

- [ ] **Step 4: Add the TS binding**

In `ui/src/api/ipc.ts`, next to `getEmbed`:

```ts
export interface GetPropertyRequest {
  vault_id: string;
  note_raw: string;
  property: string;
}
export interface GetPropertyResponse {
  kind: "resolved" | "note_unresolved" | "property_missing";
  value: string | null;
}
export function getProperty(req: GetPropertyRequest): Promise<GetPropertyResponse> {
  return invoke<GetPropertyResponse>("get_property", { req });
}
```

- [ ] **Step 5: Run, verify pass**

Run: `cd ui && npx vitest run src/api/property_ref.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-app/src/lib.rs ui/src/api/ipc.ts ui/src/api/property_ref.test.ts
git commit -m "feat(ipc): register get_property command + TS binding"
```

---

### Task 6: Cross-file property resolver (frontend cache)

**Files:**
- Create: `ui/src/editor/propertyResolver.ts`
- Test: `ui/src/editor/propertyResolver.test.ts`

**Interfaces:**
- Produces: `createPropertyResolver(vaultId, ipc?)` returning a `PropertyResolver` with the same shape as `EmbedResolver` but keyed on a composite string `"<note> <property>"`:
  - `get(note, property): GetPropertyResponse | undefined`
  - `fetch(note, property): void`
  - `resolve(note, property): Promise<GetPropertyResponse>`
  - `invalidate(): void`, `onUpdate(fn): () => void`, `version(): number`
- Consumes: `getProperty` from Task 5.

- [ ] **Step 1: Write failing test**

Create `ui/src/editor/propertyResolver.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createPropertyResolver } from "./propertyResolver";

describe("propertyResolver", () => {
  it("fetches once and caches per (note, property)", async () => {
    const ipc = vi.fn().mockResolvedValue({ kind: "resolved", value: "2019" });
    const r = createPropertyResolver("v1", ipc);
    const a = await r.resolve("Gandalf", "age");
    const b = await r.resolve("Gandalf", "age");
    expect(a.value).toBe("2019");
    expect(b.value).toBe("2019");
    expect(ipc).toHaveBeenCalledTimes(1);
  });

  it("bumps version and clears cache on invalidate", async () => {
    const ipc = vi.fn().mockResolvedValue({ kind: "resolved", value: "x" });
    const r = createPropertyResolver("v1", ipc);
    await r.resolve("N", "p");
    const v0 = r.version();
    r.invalidate();
    expect(r.version()).toBeGreaterThan(v0);
    expect(r.get("N", "p")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd ui && npx vitest run src/editor/propertyResolver.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the resolver**

Create `ui/src/editor/propertyResolver.ts` — adapt `embedResolver.ts` (drop the Contract-4a debug/event/abort surface; keep cache, in-flight dedupe, `notify`, `version`). Key helper:

```ts
import { getProperty as defaultGetProperty, type GetPropertyRequest, type GetPropertyResponse } from "../api/ipc";

const key = (note: string, property: string) => `${note} ${property}`;

export interface PropertyResolver {
  get(note: string, property: string): GetPropertyResponse | undefined;
  fetch(note: string, property: string): void;
  resolve(note: string, property: string): Promise<GetPropertyResponse>;
  invalidate(): void;
  onUpdate(handler: () => void): () => void;
  version(): number;
}

export function createPropertyResolver(
  vaultId: string,
  ipc: (req: GetPropertyRequest) => Promise<GetPropertyResponse> = defaultGetProperty,
): PropertyResolver {
  const cache = new Map<string, GetPropertyResponse>();
  const inFlight = new Set<string>();
  const subscribers = new Set<() => void>();
  let cacheVersion = 0;
  const notify = () => { for (const fn of subscribers) fn(); };

  const resolver: PropertyResolver = {
    get(note, property) { return cache.get(key(note, property)); },
    fetch(note, property) {
      const k = key(note, property);
      if (cache.has(k) || inFlight.has(k)) return;
      inFlight.add(k);
      ipc({ vault_id: vaultId, note_raw: note, property })
        .then((resp) => { cache.set(k, resp); cacheVersion++; })
        .catch(() => { cache.set(k, { kind: "note_unresolved", value: null }); cacheVersion++; })
        .finally(() => { inFlight.delete(k); notify(); });
    },
    resolve(note, property) {
      const k = key(note, property);
      const hit = cache.get(k);
      if (hit !== undefined) return Promise.resolve(hit);
      resolver.fetch(note, property);
      return new Promise((res) => {
        const unsub = resolver.onUpdate(() => {
          const entry = cache.get(k);
          if (entry !== undefined) { unsub(); res(entry); }
          else if (!inFlight.has(k)) resolver.fetch(note, property);
        });
      });
    },
    invalidate() { cache.clear(); cacheVersion++; notify(); },
    onUpdate(handler) { subscribers.add(handler); return () => subscribers.delete(handler); },
    version() { return cacheVersion; },
  };
  return resolver;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd ui && npx vitest run src/editor/propertyResolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/propertyResolver.ts ui/src/editor/propertyResolver.test.ts
git commit -m "feat(editor): cross-file property resolver cache"
```

---

### Task 7: Render helper (value → DOM)

**Files:**
- Create: `ui/src/editor/propertyRefRender.ts`
- Test: `ui/src/editor/propertyRefRender.test.ts`

**Interfaces:**
- Produces: `renderPropertyRef(state: PropertyRefRenderState): HTMLElement` where
```ts
type PropertyRefRenderState =
  | { status: "resolved"; value: string }
  | { status: "loading" }
  | { status: "broken"; raw: string };
```
  Returns a `<span class="cm-md-propref">` for resolved (text = value), `cm-md-propref-loading` for loading (text = the raw token), and `cm-md-propref-broken` for broken (text = the raw `[[…]]` token). Pure DOM, no CM imports — unit-testable with jsdom.

- [ ] **Step 1: Write failing test**

Create `ui/src/editor/propertyRefRender.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderPropertyRef } from "./propertyRefRender";

describe("renderPropertyRef", () => {
  it("renders a resolved value", () => {
    const el = renderPropertyRef({ status: "resolved", value: "2019" });
    expect(el.textContent).toBe("2019");
    expect(el.className).toContain("cm-md-propref");
    expect(el.className).not.toContain("broken");
  });
  it("renders broken refs with the raw token and a broken class", () => {
    const el = renderPropertyRef({ status: "broken", raw: "[[Ghost.age]]" });
    expect(el.textContent).toBe("[[Ghost.age]]");
    expect(el.className).toContain("cm-md-propref-broken");
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd ui && npx vitest run src/editor/propertyRefRender.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `ui/src/editor/propertyRefRender.ts`:

```ts
export type PropertyRefRenderState =
  | { status: "resolved"; value: string }
  | { status: "loading"; raw: string }
  | { status: "broken"; raw: string };

export function renderPropertyRef(state: PropertyRefRenderState): HTMLElement {
  const span = document.createElement("span");
  if (state.status === "resolved") {
    span.className = "cm-md-propref";
    span.textContent = state.value;
  } else if (state.status === "loading") {
    span.className = "cm-md-propref cm-md-propref-loading";
    span.textContent = state.raw;
  } else {
    span.className = "cm-md-propref cm-md-propref-broken";
    span.textContent = state.raw;
  }
  return span;
}
```

(Update the test's `loading` case is omitted; the `loading` variant carries `raw`. If you kept the test as written, it doesn't exercise loading — fine.)

- [ ] **Step 4: Run, verify pass**

Run: `cd ui && npx vitest run src/editor/propertyRefRender.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/propertyRefRender.ts ui/src/editor/propertyRefRender.test.ts
git commit -m "feat(editor): property-ref render helper"
```

---

### Task 8: CodeMirror inline widget + decoration field

**Files:**
- Create: `ui/src/editor/propertyRef.ts`
- Test: `ui/src/editor/propertyRef.test.ts` (decoration-build unit test on a constructed `EditorState`, mirror any existing `*.test.ts` for `embed`/decorations if present; otherwise test the helper functions exported from this module)

**Interfaces:**
- Produces: `propertyRefExtension: Extension`; facets `propertyResolverFacet` (`PropertyResolver | null`), `openNoteFrontmatterFacet` (`string | null` — the current document source, for self-ref frontmatter parsing); `propertyResolverUpdated: StateEffect`.
- Consumes: `scanWikilinks` (Task 1), `createPropertyResolver` (Task 6), `renderPropertyRef` (Task 7), `parseFrontmatterYaml`/`splitFrontmatter` from `../ast/frontmatter` for self-refs.
- Behavior: iterate `WikiLink` Lezer nodes (same as `embed.ts`); for runs where `scanWikilinks(raw)[0].kind === "property_ref"`, emit an **inline** `Decoration.replace({ widget })` over the token range (NOT block — property refs are inline). Cursor-line suppression: skip when the cursor is on the token's line (expose raw text for editing), matching the Link/Emphasis pattern. Register ranges as `atomicRanges`.

- [ ] **Step 0: Verify the Lezer tree exposes the dotted token**

Run: `rg -n "WikiLink|\\[\\[" ui/src/editor/wikilink.ts` and confirm the wiki-link Lezer extension emits a `WikiLink` node spanning the full `[[Gandalf.age]]` (dots included). If it stops at a `.`, extend its char class to include `.` so the node covers the whole token. Add a note in this task if a change was needed.

- [ ] **Step 1: Write failing decoration test**

Create `ui/src/editor/propertyRef.test.ts`. Build an `EditorState` with the doc `Age: [[Gandalf.age]].` plus a stub resolver returning `{ kind: "resolved", value: "2019" }` cached, and assert the field produces exactly one replace decoration covering the token range. (Use the same `EditorState.create({ doc, extensions })` harness as the embed/decorations tests; if none exists, test the exported `buildPropertyDecorations(state)` pure function directly.)

```ts
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { buildPropertyDecorations, propertyResolverFacet } from "./propertyRef";
import { createPropertyResolver } from "./propertyResolver";

describe("property-ref decorations", () => {
  it("replaces a resolved cross-file ref token", async () => {
    const resolver = createPropertyResolver("v1", async () => ({ kind: "resolved", value: "2019" }));
    await resolver.resolve("Gandalf", "age"); // warm cache
    const state = EditorState.create({
      doc: "Age: [[Gandalf.age]].",
      extensions: [propertyResolverFacet.of(resolver)],
    });
    const deco = buildPropertyDecorations(state);
    let count = 0;
    deco.between(0, state.doc.length, () => { count++; });
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd ui && npx vitest run src/editor/propertyRef.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the widget + field**

Create `ui/src/editor/propertyRef.ts` adapting `embed.ts`, with these differences: inline (not block) replace; self-ref resolves synchronously from the doc's own frontmatter; cross-ref uses the resolver. Sketch of the core (full file follows the embed structure):

```ts
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { Facet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { scanWikilinks } from "../ast/wikilink";
import { splitFrontmatter, parseFrontmatterYaml } from "../ast/frontmatter";
import type { PropertyResolver } from "./propertyResolver";
import { renderPropertyRef, type PropertyRefRenderState } from "./propertyRefRender";

export const propertyResolverFacet = Facet.define<PropertyResolver | null, PropertyResolver | null>({
  combine: (v) => v[0] ?? null,
});
export const propertyResolverUpdated = StateEffect.define<null>();

/** Look up a top-level key in the open doc's own frontmatter (self-ref). */
function selfValue(docText: string, property: string): string | null {
  const split = splitFrontmatter(docText);
  if (split.yaml === null || split.span === null) return null;
  const fm = parseFrontmatterYaml(split.yaml, split.span);
  const entry = fm?.entries.find(([k]) => k === property);
  if (!entry) return null;
  const v = entry[1];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.filter((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean");
    return parts.length ? parts.map(String).join(", ") : null;
  }
  return null;
}

class PropertyRefWidget extends WidgetType {
  constructor(private readonly render: PropertyRefRenderState) { super(); }
  override toDOM() { return renderPropertyRef(this.render); }
  override eq(o: PropertyRefWidget) { return JSON.stringify(this.render) === JSON.stringify(o.render); }
  override ignoreEvent() { return false; }
}

export function buildPropertyDecorations(state: EditorState): DecorationSet {
  const resolver = state.facet(propertyResolverFacet);
  const tree = syntaxTree(state);
  const doc = state.doc;
  const docText = doc.toString();
  const activeLine = doc.lineAt(state.selection.main.head).number;
  const ranges: Range<Decoration>[] = [];
  tree.iterate({
    enter: (node) => {
      if (node.name !== "WikiLink") return;
      const raw = doc.sliceString(node.from, node.to);
      const tok = scanWikilinks(raw)[0];
      if (!tok || tok.kind !== "property_ref") return;
      if (doc.lineAt(node.from).number === activeLine) return; // cursor-line suppression
      let rstate: PropertyRefRenderState;
      if (tok.note === null) {
        const v = selfValue(docText, tok.property);
        rstate = v === null ? { status: "broken", raw } : { status: "resolved", value: v };
      } else {
        const hit = resolver?.get(tok.note, tok.property);
        if (!hit) { resolver?.fetch(tok.note, tok.property); rstate = { status: "loading", raw }; }
        else if (hit.kind === "resolved" && hit.value !== null) rstate = { status: "resolved", value: hit.value };
        else rstate = { status: "broken", raw };
      }
      ranges.push(Decoration.replace({ widget: new PropertyRefWidget(rstate) }).range(node.from, node.to));
    },
  });
  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

export const propertyRefField = StateField.define<DecorationSet>({
  create: buildPropertyDecorations,
  update: (deco, tr) => {
    const resolverChanged = tr.effects.some((e) => e.is(propertyResolverUpdated));
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const facetChanged = tr.startState.facet(propertyResolverFacet) !== tr.state.facet(propertyResolverFacet);
    const activeLineChanged =
      tr.startState.doc.lineAt(tr.startState.selection.main.head).number !==
      tr.state.doc.lineAt(tr.state.selection.main.head).number;
    if (!tr.docChanged && !treeChanged && !resolverChanged && !facetChanged && !activeLineChanged) return deco;
    return buildPropertyDecorations(tr.state);
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
  ],
});

export const propertyRefBaseTheme = EditorView.baseTheme({
  ".cm-md-propref": { color: "var(--c-accent)" },
  ".cm-md-propref-loading": { color: "var(--c-fg-muted)", fontStyle: "italic" },
  ".cm-md-propref-broken": { color: "var(--c-warning, var(--c-fg-muted))", textDecoration: "underline dashed" },
});

export const propertyRefExtension: Extension = [propertyRefField, propertyRefBaseTheme];
```

- [ ] **Step 4: Run, verify pass**

Run: `cd ui && npx vitest run src/editor/propertyRef.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/propertyRef.ts ui/src/editor/propertyRef.test.ts
git commit -m "feat(editor): inline property-ref widget + decoration field"
```

---

### Task 9: Wire into the editor + invalidate on file change

**Files:**
- Modify: `ui/src/Editor.tsx` (add `propertyRefExtension`; provide `propertyResolverFacet` via the same Compartment pattern as `embedResolverFacet`; dispatch `propertyResolverUpdated` on `resolver.onUpdate`)
- Modify: `ui/src/App.tsx` (construct the resolver per open vault; call `resolver.invalidate()` from the existing `vault:file-changed` listener — `rg -n "invalidate\\(\\)|file-changed" ui/src/App.tsx`)
- Test: covered by existing editor integration tests + the manual smoke (Task 12).

**Interfaces:** Consumes `propertyRefExtension`, `propertyResolverFacet`, `propertyResolverUpdated`, `createPropertyResolver`.

- [ ] **Step 1: Construct + thread the resolver**

In `App.tsx`, wherever `createEmbedResolver(vaultId)` is created, add `createPropertyResolver(vaultId)` alongside it; pass it down to `Editor` the same way; in the `vault:file-changed` handler that calls `embedResolver.invalidate()`, also call `propertyResolver.invalidate()`.

- [ ] **Step 2: Register in the editor**

In `Editor.tsx`, add `propertyRefExtension` to the extension list and reconfigure `propertyResolverFacet.of(props.propertyResolver)` in the same Compartment used for `embedResolverFacet`. Subscribe to `propertyResolver.onUpdate(() => view.dispatch({ effects: propertyResolverUpdated.of(null) }))` (mirror the embed `onUpdate` → `embedResolverUpdated` wiring).

- [ ] **Step 3: Verify build + types**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/Editor.tsx ui/src/App.tsx
git commit -m "feat(editor): wire property-ref resolver + invalidation"
```

---

### Task 10: Core-plugin toggle + setting key

**Files:**
- Modify: `ui/src/settings/corePlugins.ts` (add the `CORE_PLUGINS` entry)
- Modify: `ui/src/api/ipc.ts` (add `plugins.property_refs_enabled` to the `Setting` union — `rg -n "plugins.dataview_enabled" ui/src/api/ipc.ts`)
- Modify: Rust settings registry (every site that knows `plugins.dataview_enabled` — `rg -rn "dataview_enabled" crates/`; mirror the key + its default)
- Modify: `ui/src/Editor.tsx` (gate `propertyRefExtension` on the resolved setting, the same way the dataview extension is gated)
- Test: extend `ui/src/settings/corePlugins.test.ts` if present (assert the new entry + default).

**Interfaces:** New boolean setting `plugins.property_refs_enabled`, default `true`. Plugin id `property-refs`.

- [ ] **Step 1: Add the plugin entry**

In `corePlugins.ts`, append to `CORE_PLUGINS`:

```ts
  {
    id: "property-refs",
    name: "Property references",
    description: "Render [[note.prop]] / [[.prop]] as inline frontmatter values.",
    settingKey: "plugins.property_refs_enabled",
    defaultEnabled: true,
  },
```

- [ ] **Step 2: Register the setting key (Rust + TS)**

Run `rg -rn "dataview_enabled" crates/ ui/src` and, at every site, add the `plugins.property_refs_enabled` analogue (the `Setting`/`SettingKey` enum or union, its default value, and any validation list). Keep the default `true`.

- [ ] **Step 3: Gate the extension**

In `Editor.tsx`, where the dataview extension is conditionally included based on `corePluginEnabled(state, dataviewPlugin)`, include `propertyRefExtension` only when the `property-refs` plugin resolves enabled. When disabled, the field emits no decorations and `[[…]]` shows as raw text.

- [ ] **Step 4: Verify**

Run: `cd ui && npx tsc --noEmit && npx vitest run` and `cargo test -p cubical-app settings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/corePlugins.ts ui/src/api/ipc.ts ui/src/Editor.tsx crates/
git commit -m "feat(settings): property-refs core-plugin toggle"
```

---

### Task 11: Dotted-filename UI guard (separable)

**Files:**
- Create: `ui/src/vault/noteName.ts` — `isValidNoteName(name: string): boolean` (rejects a `.` before the `.md` extension) + `noteNameError(name)` message.
- Modify: the note **create** flow (locate: `rg -n "create.*[Nn]ote|new note|createFile" ui/src`) to reject invalid names with the message.
- Modify: the **rename** flow (`crates/cubical-app/src/commands/rename.rs` consumer in the UI — `rg -n "rename" ui/src`) to reject invalid target names.
- Flag existing dotted notes in the file tree (locate the tree item component; add a small badge/title when `name` contains a dot before `.md`).
- Test: `ui/src/vault/noteName.test.ts`.

**Interfaces:** Produces `isValidNoteName`, `noteNameError`. Pure, UI-agnostic.

- [ ] **Step 1: Write failing test**

Create `ui/src/vault/noteName.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isValidNoteName } from "./noteName";

describe("isValidNoteName", () => {
  it("accepts a plain name", () => {
    expect(isValidNoteName("Gandalf")).toBe(true);
    expect(isValidNoteName("Gandalf.md")).toBe(true);
  });
  it("rejects a dotted name (would shadow property-ref syntax)", () => {
    expect(isValidNoteName("2026.06.20")).toBe(false);
    expect(isValidNoteName("v1.2")).toBe(false);
    expect(isValidNoteName("2026.06.20.md")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd ui && npx vitest run src/vault/noteName.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `ui/src/vault/noteName.ts`:

```ts
/** Reject a `.` anywhere except the trailing `.md` — a dotted note name
 * would be unreachable by `[[ ]]` because the dot is the property-ref
 * separator. See the property-reference-interpolation design §5. */
export function isValidNoteName(name: string): boolean {
  const base = name.endsWith(".md") ? name.slice(0, -3) : name;
  return base.length > 0 && !base.includes(".");
}

export function noteNameError(name: string): string {
  return `"${name}" can't contain a dot — dots are reserved for property references like [[note.prop]].`;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd ui && npx vitest run src/vault/noteName.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into create/rename + tree badge**

Call `isValidNoteName` in the create and rename submit handlers; block submit and surface `noteNameError(name)`. In the tree item, when `!isValidNoteName(entry.name)`, add `title={noteNameError(entry.name)}` and a muted badge class. Verify with `npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/vault/noteName.ts ui/src/vault/noteName.test.ts ui/src
git commit -m "feat(vault): block dotted note names, flag existing ones"
```

---

### Task 12: Full gate + docs closeout + manual smoke

**Files:**
- Modify: `docs/architecture/planned.md` (add a §-pointer for property-ref interpolation, "designed; v1 raw-scalar, registry-independent")
- Modify: `docs/build-order.md` (record the feature under the relevant layer if it lists features)
- Modify: `CLAUDE.md` Project state block (rewrite per the session protocol)
- Modify: the relevant layer spec "What was built" (terse)

- [ ] **Step 1: Run the full gate**

Run: `bash scripts/check.sh`
Expected: PASS (fmt, clippy, cargo test, tsc, vitest, build, docs).

- [ ] **Step 2: Manual smoke (operator)**

In `cargo tauri dev`: create `Gandalf.md` with frontmatter `age: 2019`; in another note type `Gandalf is [[Gandalf.age]]` → renders `2019` off the cursor line, raw token on the cursor line. Add `level: 5` to the current note and type `[[.level]]` → renders `5`. Type `[[Ghost.age]]` → broken-ref style. Edit `Gandalf.md`'s `age` → the reference updates without reload. Toggle the "Property references" plugin off → tokens show as raw text. Try to create a note named `a.b` → blocked.

- [ ] **Step 3: Docs + project-state rewrite**

Update the four docs above. Keep the Project-state block to three short blocks per the session protocol.

- [ ] **Step 4: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs: record property-reference interpolation"
```

---

## Self-Review

- **Spec coverage:** §2 syntax → Task 1; AST node → Task 2; parity → Task 3; cross-file resolution (§3.3) → Tasks 4–6; render + broken-ref (§2 on-miss) → Tasks 7–8; reactivity (§3.3) → Tasks 6/9; toggle (§3.5) → Task 10; dotted-name guard (§3.6, §5) → Task 11; raw-scalar/registry independence (§1) → Task 4 `scalar_to_display`; testing (§7) → distributed + Task 12. All covered.
- **Placeholder scan:** none — every code step carries real code; "locate via `rg`" steps name the exact search and the change to make.
- **Type consistency:** `PropertyRef { note: Option<String>/string|null, property }` is identical across tokenizer (Task 1), AST (Task 2), and fixtures (Task 3). IPC `GetPropertyRequest`/`Response` + `PropertyRefKind` (snake_case `resolved`/`note_unresolved`/`property_missing`) consistent Task 4 ↔ 5 ↔ 6. Resolver `get/fetch/resolve/invalidate/version` consistent Task 6 ↔ 8. `PropertyRefRenderState` consistent Task 7 ↔ 8.
- **Known verification points folded into steps:** Lezer `WikiLink` node covering dots (Task 8 Step 0); `invoke` arg-wrapping convention (Task 5 Step 2); setting-key registration sites (Task 10 Step 2). Each is a `rg` + mirror, not a placeholder.
