# L3 — In-bracket `[[#^` block-id autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `[[target#^pre` opens a CodeMirror dropdown of block ids defined in `target.md` whose name starts with `pre`; picking one inserts the id and (if needed) the `]]` closer.

**Architecture:** Backend adds one handler (`block_id_autocomplete`) that resolves `target_raw` like `resolve_link` and returns the file's block ids via the existing `blocks_for_file`. Frontend adds a pure `detectBlockTrigger` + `blockInsertion`, a `blockCompletionSource` mirroring `linkCompletionSource`, an injected provider method, and one entry in the editor's `autocompletion({override})` array. No new index helpers; no new tables.

**Tech Stack:** Rust (`cubical-app` handler, Tauri shim), SolidJS / TypeScript / CodeMirror 6 (`@codemirror/autocomplete`), Vitest. Reuses `cubical_index::blocks_for_file` (L3 Session G) and `cubical_core::vault::links::resolve_target`.

**Branch:** Work on a new branch `l3-blockid-autocomplete` cut from `main` (single-checkout workflow — no worktrees).

**Design:** `docs/superpowers/specs/2026-05-29-l3-blockid-autocomplete-design.md`.

---

## Background — read before touching code

You have no prior context. Read this and the referenced files before starting.

- **`blocks_for_file(conn, file_path) -> Vec<BlockRow>`** is already exported from `cubical-index` (Session G). It returns block ids ordered by `position_hint`. We just consume it.
- **`resolve_link` (`crates/cubical-app/src/commands/links.rs:24`)** is the template for resolving a wiki-link target: snapshot `SELECT path FROM files ORDER BY path` → call `cubical_core::vault::links::resolve_target(target_raw, &known)` → `Option<String>` path. Public function; nothing new to export.
- **Autocomplete handler patterns (`crates/cubical-app/src/commands/autocomplete.rs`).** `AUTOCOMPLETE_LIMIT: u32 = 50`. Handler signature: `pub async fn name(state: &AppState, req) -> Result<Resp, CubicalError>` with `state.vaults().read().await.get(&req.vault_id).ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?`. Test helpers `fresh_state_with_vault` + `seed_file(vault, rel, type_id)` (with `inode NULL` column — see lines 95–108).
- **Frontend autocomplete machinery (`ui/src/editor/autocomplete.ts`).** `Trigger { query, from }`, `detectLinkTrigger` regex `/\[\[([^\]\n|#]*)$/`, `linkInsertion(path, closerFollows) -> { insert, cursorAfter }`, `isInhibited(state, pos, denyWikiLink)` (Lezer ancestor walk over a `CODE_NODES` set; pass `false` for the block trigger since the trigger only matches *inside* a wiki-link). `linkCompletionSource(provider): CompletionSource` is the structural template — async handler returns `CompletionResult { from, options, validFor }`; option `apply` dispatches a `view` transaction with `changes: { from, to, insert }` and `selection: { anchor: from + cursorAfter }`. `lineBefore(state, pos)` reads the line up to the cursor.
- **Provider injection (`ui/src/editor/autocompleteProvider.ts`).** `AutocompleteProvider { links, tags }`; `createAutocompleteProvider(vaultId, linkIpc?, tagIpc?)` injects IPC for tests, with production defaults from `api/ipc.ts`. Failures → empty list. Extend with `blockIds` + `blockIdIpc?`.
- **Editor wiring (`ui/src/Editor.tsx`).** `autocompleteExtensionFor(provider)` lists `linkCompletionSource(provider)` + `tagCompletionSource(provider)` in `autocompletion({ override: [...] })`. Add `blockCompletionSource(provider)` to this array.
- **`@lezer/markdown` `WikiLink`.** The `isInhibited` ancestor walk treats `WikiLink` as deny-only when `denyWikiLink=true` (used for the tag trigger to ignore `#` inside `[[…]]`). For block autocomplete we **want** to be inside a WikiLink, so pass `denyWikiLink=false`.

### Scope boundaries — do NOT do these

- **No heading autocomplete** (`[[target#headline`) — no headings index exists; deferred indefinitely. The block trigger regex requires the literal `#^`, so the two never collide.
- **Do not touch `linkCompletionSource` / `tagCompletionSource`.** The link trigger stops at `#` (regex `[^\]\n|#]*`), so it can't conflict.
- **No client-side prefix filtering re-query.** CM6's `validFor` regex filters between keystrokes; the handler returns the full per-file id list (capped at 50).
- **No new index helper.** `blocks_for_file` is sufficient.

---

## File Structure

**Create:**
- *(none — all changes extend existing files)*

**Modify:**
- `crates/cubical-app/src/api/types.rs` — `BlockIdAutocomplete{Request,Response}` wire types.
- `crates/cubical-app/src/commands/autocomplete.rs` — `block_id_autocomplete` handler + 2 unit tests.
- `crates/cubical-app/src/lib.rs` — type imports, Tauri shim, registration.
- `ui/src/api/ipc.ts` — wire types + `blockIdAutocomplete` binding.
- `ui/src/editor/autocompleteProvider.ts` — extend interface + factory with `blockIds`.
- `ui/src/editor/autocomplete.ts` — `detectBlockTrigger`, `blockInsertion`, `blockCompletionSource`.
- `ui/src/editor/autocomplete.test.ts` — tests for the three new pure functions + the source.
- `ui/src/Editor.tsx` — add `blockCompletionSource(p)` to the `override` array.
- `docs/layer-3-spec.md` — append a short §9.11.
- `CLAUDE.md` — rewrite the Project state block.

---

### Task 1: Backend handler + IPC

**Files:**
- Modify: `crates/cubical-app/src/api/types.rs`
- Modify: `crates/cubical-app/src/commands/autocomplete.rs`
- Modify: `crates/cubical-app/src/lib.rs`
- Modify: `ui/src/api/ipc.ts`

- [ ] **Step 1: Add wire types**

In `crates/cubical-app/src/api/types.rs`, append (after the existing autocomplete request/response types):

```rust
// -- block_id_autocomplete (L3 — [[#^ autocomplete) -------------------

/// Request payload for `block_id_autocomplete`.
#[derive(Debug, Clone, Deserialize)]
pub struct BlockIdAutocompleteRequest {
    /// Vault to query.
    pub vault_id: String,
    /// Wiki-link target as written (no `[[`/`]]`/`#`/`|`). Resolved to
    /// a file path via the same rules as `resolve_link`.
    pub target_raw: String,
}

/// Response payload for `block_id_autocomplete`.
#[derive(Debug, Clone, Serialize)]
pub struct BlockIdAutocompleteResponse {
    /// Block ids defined in the resolved target file, ordered by
    /// position; empty when the target doesn't resolve. Capped
    /// server-side at AUTOCOMPLETE_LIMIT.
    pub candidates: Vec<String>,
}
```

- [ ] **Step 2: Write the failing handler tests**

In `crates/cubical-app/src/commands/autocomplete.rs`, inside the `#[cfg(test)] mod tests` block, append (after the existing tests):

```rust
    #[tokio::test]
    async fn block_id_autocomplete_returns_ids_for_resolved_target() {
        use cubical_index::{replace_blocks_for_file, BlockRow};
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file(&vault, "notes/Daily.md", "markdown").await;
        replace_blocks_for_file(
            vault.index(),
            "notes/Daily.md",
            &[
                BlockRow { block_id: "intro".into(), position_hint: 0 },
                BlockRow { block_id: "summary".into(), position_hint: 10 },
            ],
        )
        .await
        .expect("seed blocks");

        let resp = block_id_autocomplete(
            &state,
            BlockIdAutocompleteRequest {
                vault_id: "v1".into(),
                target_raw: "Daily".into(),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.candidates, vec!["intro".to_string(), "summary".to_string()]);
    }

    #[tokio::test]
    async fn block_id_autocomplete_empty_when_target_unresolved() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        // No files seeded → "ghost" doesn't resolve to any path.
        let resp = block_id_autocomplete(
            &state,
            BlockIdAutocompleteRequest {
                vault_id: "v1".into(),
                target_raw: "ghost".into(),
            },
        )
        .await
        .expect("ok");
        assert!(resp.candidates.is_empty());
    }
```

Also extend the existing `use crate::api::types::{...}` line at the top of the `mod tests` (or the file) to include the new types. If the imports are inside `mod tests`, add:

```rust
    use crate::api::types::{BlockIdAutocompleteRequest, BlockIdAutocompleteResponse};
```

Otherwise add them to the file-level `use` block.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p cubical-app commands::autocomplete::tests::block_id_autocomplete 2>&1 | tail`
Expected: FAIL to compile — `block_id_autocomplete` is undefined.

- [ ] **Step 4: Implement the handler**

In `crates/cubical-app/src/commands/autocomplete.rs`:

(a) Extend the `use` block at the top of the file to add the imports needed:

```rust
use cubical_core::vault::links::resolve_target;
use cubical_index::{blocks_for_file, files_for_link_query, tag_paths_for_prefix};
```

(replace the existing `use cubical_index::{files_for_link_query, tag_paths_for_prefix};` with the second line; add the first line).

Add to the file-level `use crate::api::types::{...}`:

```rust
    BlockIdAutocompleteRequest, BlockIdAutocompleteResponse,
```

(b) Add the handler after `tag_autocomplete`:

```rust
/// Block ids defined in the resolved target file. The target is resolved
/// the same way `resolve_link` does (exact vault path → unique basename
/// → unique suffix). Returns an empty list when the target doesn't
/// resolve. Capped server-side at `AUTOCOMPLETE_LIMIT`. See spec §9.11.
pub async fn block_id_autocomplete(
    state: &AppState,
    req: BlockIdAutocompleteRequest,
) -> Result<BlockIdAutocompleteResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let vault = open.vault.clone();
    drop(guard);

    let conn = vault.index().connection();
    let mut rows = conn
        .query("SELECT path FROM files ORDER BY path", ())
        .await?;
    let mut known: Vec<String> = Vec::new();
    while let Some(row) = rows.next().await? {
        known.push(row.get(0)?);
    }

    let target_path = match resolve_target(&req.target_raw, &known) {
        Some(p) => p,
        None => return Ok(BlockIdAutocompleteResponse { candidates: vec![] }),
    };

    let blocks = blocks_for_file(vault.index(), &target_path).await?;
    let candidates: Vec<String> = blocks
        .into_iter()
        .map(|b| b.block_id)
        .take(AUTOCOMPLETE_LIMIT as usize)
        .collect();
    Ok(BlockIdAutocompleteResponse { candidates })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p cubical-app commands::autocomplete -- --nocapture 2>&1 | tail`
Expected: PASS (new 2 + existing 3 = 5). Then `cargo clippy -p cubical-app --all-targets -- -D warnings` + `cargo fmt --all`.

- [ ] **Step 6: Add the Tauri shim + registration**

In `crates/cubical-app/src/lib.rs`:

(a) Extend the `use crate::api::types::{...}` block to add the new types alongside the other autocomplete types:

```rust
    BlockIdAutocompleteRequest, BlockIdAutocompleteResponse,
```

(b) Add the shim near the other `*_autocomplete` shims:

```rust
/// Tauri shim — see [`commands::autocomplete::block_id_autocomplete`].
#[tauri::command]
async fn block_id_autocomplete(
    state: tauri::State<'_, AppState>,
    req: BlockIdAutocompleteRequest,
) -> Result<BlockIdAutocompleteResponse, CubicalError> {
    commands::autocomplete::block_id_autocomplete(state.inner(), req).await
}
```

(c) Register in `generate_handler![...]` next to `tag_autocomplete,`:

```rust
            block_id_autocomplete,
```

- [ ] **Step 7: Add the IPC binding**

In `ui/src/api/ipc.ts`, append (after the existing autocomplete bindings, near the tag one):

```ts
// ---------------------------------------------------------------------------
// block_id_autocomplete (L3 — [[#^ block-id completion)
// ---------------------------------------------------------------------------

export interface BlockIdAutocompleteRequest {
  vault_id: string;
  /** Wiki-link target as written (no `[[`/`]]`/`#`/`|`). */
  target_raw: string;
}

export interface BlockIdAutocompleteResponse {
  /** Block ids in the resolved target file (ordered, capped). */
  candidates: string[];
}

/**
 * Block ids defined in the resolved target file, for the `[[…#^` editor
 * dropdown. Empty when the target doesn't resolve.
 */
export function blockIdAutocomplete(
  req: BlockIdAutocompleteRequest,
): Promise<BlockIdAutocompleteResponse> {
  return invoke("block_id_autocomplete", { req });
}
```

- [ ] **Step 8: Build + typecheck**

```bash
cargo build -p cubical-app
( cd ui && npx tsc --noEmit )
```
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add crates/cubical-app/src/api/types.rs crates/cubical-app/src/commands/autocomplete.rs crates/cubical-app/src/lib.rs ui/src/api/ipc.ts
git commit -m "feat(app): block_id_autocomplete handler + IPC"
```

---

### Task 2: Pure trigger detector + insertion helper

**Files:**
- Modify: `ui/src/editor/autocomplete.ts`
- Modify: `ui/src/editor/autocomplete.test.ts`

- [ ] **Step 1: Write the failing tests**

In `ui/src/editor/autocomplete.test.ts`, add a new describe block at the end (the import line at the top already pulls from `./autocomplete` — extend it to include `detectBlockTrigger` and `blockInsertion`):

```ts
describe("detectBlockTrigger", () => {
  it("matches an empty prefix right after `[[target#^`", () => {
    const got = detectBlockTrigger("see [[note#^", 12);
    expect(got).toEqual({ target: "note", from: 12 });
  });

  it("matches with a partial id and reports `from` at the prefix start", () => {
    const got = detectBlockTrigger("see [[note#^pre", 15);
    expect(got).toEqual({ target: "note", from: 12 });
  });

  it("accepts a nested path target", () => {
    const got = detectBlockTrigger("[[a/b#^_x-1", 11);
    expect(got).toEqual({ target: "a/b", from: 6 });
  });

  it("rejects when target is empty", () => {
    expect(detectBlockTrigger("[[#^x", 5)).toBeNull();
  });

  it("rejects when there is no `#^`", () => {
    expect(detectBlockTrigger("[[note#pre", 10)).toBeNull();
    expect(detectBlockTrigger("[[note^pre", 10)).toBeNull();
  });

  it("rejects outside any `[[`", () => {
    expect(detectBlockTrigger("text^pre", 8)).toBeNull();
  });
});

describe("blockInsertion", () => {
  it("appends `]]` when no closer follows and lands the caret past it", () => {
    expect(blockInsertion("intro", false)).toEqual({
      insert: "intro]]",
      cursorAfter: 7,
    });
  });

  it("leaves the closer alone when it already follows", () => {
    expect(blockInsertion("intro", true)).toEqual({
      insert: "intro",
      cursorAfter: 5,
    });
  });
});
```

Update the import at the top of `autocomplete.test.ts` to include the two new functions:

```ts
import {
  blockInsertion,
  detectBlockTrigger,
  detectLinkTrigger,
  detectTagTrigger,
  isInhibited,
  linkCompletionSource,
  linkInsertion,
  tagCompletionSource,
} from "./autocomplete";
```

(Keep any other existing imports — only add the two names.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ui && npx vitest run src/editor/autocomplete.test.ts 2>&1 | tail`
Expected: FAIL — `detectBlockTrigger` / `blockInsertion` are not exported.

- [ ] **Step 3: Implement the helpers**

In `ui/src/editor/autocomplete.ts`, add a new exported interface + the two functions after `linkInsertion`:

```ts
/** Output of {@link detectBlockTrigger}: which target's blocks to query. */
export interface BlockTrigger {
  /** Wiki-link target as typed (between `[[` and `#^`). */
  target: string;
  /** Absolute doc offset where the partial id starts (completion `from`). */
  from: number;
}

/**
 * Detect a `[[target#^prefix` trigger ending at `pos`. Returns the
 * target text (whatever sits between `[[` and `#^`) and the offset
 * where the partial id begins, or `null` when no match (including
 * empty target). The regex deliberately requires the literal `#^` so
 * it never collides with heading completion (`[[target#heading`,
 * deferred — no headings index).
 */
export function detectBlockTrigger(
  before: string,
  pos: number,
): BlockTrigger | null {
  const m = /\[\[([^\]\n|#]+)#\^([A-Za-z0-9_-]*)$/.exec(before);
  if (!m) return null;
  const target = m[1] ?? "";
  if (target.trim().length === 0) return null;
  const prefix = m[2] ?? "";
  return { target, from: pos - prefix.length };
}

/**
 * Build the text to insert when a block-id candidate is chosen. Mirrors
 * {@link linkInsertion} but the inserted string is just the id (the
 * user has already typed `^`). Appends `]]` unless it already follows.
 */
export function blockInsertion(
  id: string,
  closerFollows: boolean,
): { insert: string; cursorAfter: number } {
  const insert = closerFollows ? id : `${id}]]`;
  return { insert, cursorAfter: id.length + (closerFollows ? 0 : 2) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/editor/autocomplete.test.ts 2>&1 | grep -E "Tests |FAIL" | tail -2`
Expected: all green (existing + 8 new in the two describe blocks).

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/autocomplete.ts ui/src/editor/autocomplete.test.ts
git commit -m "feat(ui): pure detectBlockTrigger + blockInsertion for [[#^ autocomplete"
```

---

### Task 3: `blockCompletionSource` + provider extension + Editor wire

**Files:**
- Modify: `ui/src/editor/autocompleteProvider.ts`
- Modify: `ui/src/editor/autocomplete.ts`
- Modify: `ui/src/editor/autocomplete.test.ts`
- Modify: `ui/src/Editor.tsx`

- [ ] **Step 1: Extend the provider interface + factory**

In `ui/src/editor/autocompleteProvider.ts`:

(a) Extend the IPC imports:

```ts
import {
  blockIdAutocomplete as defaultBlockIdAutocomplete,
  linkAutocomplete as defaultLinkAutocomplete,
  tagAutocomplete as defaultTagAutocomplete,
  type BlockIdAutocompleteRequest,
  type BlockIdAutocompleteResponse,
  type LinkAutocompleteRequest,
  type LinkAutocompleteResponse,
  type LinkCandidate,
  type TagAutocompleteRequest,
  type TagAutocompleteResponse,
} from "../api/ipc";
```

(b) Add to the interface:

```ts
export interface AutocompleteProvider {
  /** Files matching `query` (substring). Empty array on failure. */
  links: (query: string) => Promise<LinkCandidate[]>;
  /** Tags matching `query` (prefix). Empty array on failure. */
  tags: (query: string) => Promise<string[]>;
  /** Block ids in `target` (resolved server-side). Empty on failure. */
  blockIds: (target: string) => Promise<string[]>;
}
```

(c) Extend the factory:

```ts
export function createAutocompleteProvider(
  vaultId: string,
  linkIpc: (
    req: LinkAutocompleteRequest,
  ) => Promise<LinkAutocompleteResponse> = defaultLinkAutocomplete,
  tagIpc: (
    req: TagAutocompleteRequest,
  ) => Promise<TagAutocompleteResponse> = defaultTagAutocomplete,
  blockIdIpc: (
    req: BlockIdAutocompleteRequest,
  ) => Promise<BlockIdAutocompleteResponse> = defaultBlockIdAutocomplete,
): AutocompleteProvider {
  return {
    async links(query) {
      try {
        const resp = await linkIpc({ vault_id: vaultId, query });
        return resp.candidates;
      } catch {
        return [];
      }
    },
    async tags(query) {
      try {
        const resp = await tagIpc({ vault_id: vaultId, query });
        return resp.candidates;
      } catch {
        return [];
      }
    },
    async blockIds(target) {
      try {
        const resp = await blockIdIpc({ vault_id: vaultId, target_raw: target });
        return resp.candidates;
      } catch {
        return [];
      }
    },
  };
}
```

- [ ] **Step 2: Implement `blockCompletionSource`**

In `ui/src/editor/autocomplete.ts`, append after `tagCompletionSource`:

```ts
/** `[[…#^` block-id completion source backed by `provider.blockIds`. */
export function blockCompletionSource(
  provider: AutocompleteProvider,
): CompletionSource {
  return async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const before = lineBefore(context.state, context.pos);
    const trig = detectBlockTrigger(before, context.pos);
    if (!trig) return null;
    // Inside a WikiLink is expected here, so denyWikiLink=false.
    if (isInhibited(context.state, context.pos, false)) return null;

    const candidates = await provider.blockIds(trig.target);
    if (candidates.length === 0) return null;

    const after = context.state.sliceDoc(context.pos, context.pos + 2);
    const closerFollows = after === "]]";

    return {
      from: trig.from,
      options: candidates.map((id) => ({
        label: id,
        apply: (
          view: import("@codemirror/view").EditorView,
          _completion: import("@codemirror/autocomplete").Completion,
          from: number,
          to: number,
        ) => {
          const { insert, cursorAfter } = blockInsertion(id, closerFollows);
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + cursorAfter },
          });
        },
      })),
      validFor: /^[A-Za-z0-9_-]*$/,
    };
  };
}
```

- [ ] **Step 3: Extend the test `fakeProvider` to carry `blockIds`**

In `ui/src/editor/autocomplete.test.ts`, the existing helper `fakeProvider(links, tags)` builds an `AutocompleteProvider` with only `links` + `tags`. After Task 3 Step 1 extends the interface with `blockIds`, this helper no longer compiles. Update it to take a third arg + return a `blockIds` method:

```ts
const fakeProvider = (
  links: { path: string; title: string }[],
  tags: string[],
  blockIdsByTarget: Record<string, string[]> = {},
): AutocompleteProvider => ({
  links: async () => links,
  tags: async () => tags,
  blockIds: async (target) => blockIdsByTarget[target] ?? [],
});
```

The existing `linkCompletionSource` / `tagCompletionSource` test call sites (`fakeProvider([...], [...])`) keep working — the new arg defaults to `{}`.

- [ ] **Step 4: Add headless `blockCompletionSource` tests**

In the same file, append a new describe block (mirror the existing `linkCompletionSource` block — uses `ctxAt(doc, pos)`):

```ts
describe("blockCompletionSource", () => {
  it("returns the target's block ids inside `[[…#^`", async () => {
    const src = blockCompletionSource(
      fakeProvider([], [], { note: ["intro", "summary"] }),
    );
    // Doc is "see [[note#^"; cursor at pos 12 (right after the caret).
    const res = await src(ctxAt("see [[note#^", 12));
    expect(res).not.toBeNull();
    expect(res!.options.map((o) => o.label)).toEqual(["intro", "summary"]);
    expect(res!.from).toBe(12);
  });

  it("is suppressed inside a fenced code block", async () => {
    const src = blockCompletionSource(
      fakeProvider([], [], { note: ["intro"] }),
    );
    const doc = "```\n[[note#^\n```\n";
    // Inside the fence, right after the caret on line 2.
    const pos = 4 + "[[note#^".length;
    const res = await src(ctxAt(doc, pos));
    expect(res).toBeNull();
  });

  it("returns null when the target resolves to no blocks", async () => {
    const src = blockCompletionSource(fakeProvider([], [], {}));
    const res = await src(ctxAt("[[ghost#^", 9));
    expect(res).toBeNull();
  });
});
```

Also add `blockCompletionSource` to the imports from `./autocomplete`:

```ts
import {
  blockCompletionSource,
  blockInsertion,
  detectBlockTrigger,
  detectLinkTrigger,
  detectTagTrigger,
  isInhibited,
  linkCompletionSource,
  linkInsertion,
  tagCompletionSource,
} from "./autocomplete";
```

- [ ] **Step 5: Run vitest to verify**

Run: `cd ui && npx vitest run src/editor/autocomplete.test.ts 2>&1 | grep -E "Tests |FAIL" | tail -2`
Expected: all green.

- [ ] **Step 6: Wire into the Editor**

In `ui/src/Editor.tsx`, extend the import from `./editor/autocomplete`:

```ts
import {
  blockCompletionSource,
  linkCompletionSource,
  tagCompletionSource,
} from "./editor/autocomplete";
```

And add the source to the `override` array in `autocompleteExtensionFor`:

```ts
const autocompleteExtensionFor = (
  provider: AutocompleteProvider | null | undefined,
) =>
  provider
    ? autocompletion({
        override: [
          linkCompletionSource(provider),
          tagCompletionSource(provider),
          blockCompletionSource(provider),
        ],
      })
    : [];
```

- [ ] **Step 7: Typecheck + full vitest**

```bash
cd ui && npx tsc --noEmit && npx vitest run 2>&1 | grep -E "Tests |FAIL" | tail -2
```
Expected: tsc clean; vitest all green.

- [ ] **Step 8: Commit**

```bash
git add ui/src/editor/autocomplete.ts ui/src/editor/autocomplete.test.ts ui/src/editor/autocompleteProvider.ts ui/src/Editor.tsx
git commit -m "feat(ui): blockCompletionSource — [[…#^ block-id dropdown"
```

---

### Task 4: Verify + docs + finish branch

**Files:**
- Modify: `docs/layer-3-spec.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full gates**

```bash
cargo test --workspace 2>&1 | grep -E "test result: FAILED|^test result: ok" | tail
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --all --check
( cd ui && npx tsc --noEmit && npx vitest run && npm run build )
```
Expected: Rust 273 (was 271 + 2 handler tests) green; clippy clean; fmt clean; vitest ≈ 291 (was 282 + ~9) green; build OK (pre-existing chunk-size warning is fine). If `runner::tests::schema_too_new_is_rejected` trips, it's a known parallel-run flake — re-run in isolation.

- [ ] **Step 2: Real-app smoke (best-effort)**

```bash
cargo build -p cubical-app
# then: cargo tauri dev, open a sandbox vault.
#  - In note A, type "[[B#^" where B.md already has ^intro and ^summary
#    (use Cmd/Ctrl+Shift+B on B's paragraphs first if needed).
#  - Confirm the dropdown lists `intro`, `summary`.
#  - Type `i` — list filters to `intro`. Hit Enter — buffer reads
#    "[[B#^intro]]" with the caret past the closer.
#  - Type "[[ghost#^" with no ghost.md — no dropdown.
#  - Confirm no dropdown inside a ``` fenced code block.
```
Same automated-context constraint as prior frontend sessions — the pure logic is fully unit-tested; the live dropdown is verified by hands-on smoke.

- [ ] **Step 3: Update docs + state**

- Append `### 9.11 [[#^ block-id autocomplete` to `docs/layer-3-spec.md` (mirror §9.7/§9.10 style): new `block_id_autocomplete` handler resolving target like `resolve_link` + `blocks_for_file`, capped at `AUTOCOMPLETE_LIMIT`; pure `detectBlockTrigger` regex `/\[\[([^\]\n|#]+)#\^([A-Za-z0-9_-]*)$/`, `blockInsertion` mirroring `linkInsertion`, `blockCompletionSource` joining the editor's `override` array, `validFor /^[A-Za-z0-9_-]*$/` for inter-keystroke filtering, `denyWikiLink=false` in `isInhibited` (inside-WikiLink is expected). Note heading autocomplete stays deferred (no headings index).
- Rewrite the `CLAUDE.md` "Project state" block (do not append): block-id autocomplete done; update test counts (Rust 273, vitest ≈ 291); set "Next: **Session H — Embeds**."

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch.

---

## Self-review notes (for the executor)

- **The trigger regex requires `#^` literally.** That prevents collision with any future heading completion (`[[target#headline`). Don't broaden it.
- **`denyWikiLink=false` in `isInhibited`** — the block source *wants* to be inside a `WikiLink`. The tag source passes `true` for the opposite reason.
- **`validFor` filters between keystrokes** — do not re-query per keypress. The handler returns the full per-file id list (capped server-side at 50); CM6 filters locally.
- **Provider failures resolve to `[]`** — same pattern as `links`/`tags`. The dropdown silently shows nothing rather than throwing.
- **No new index helper** — `blocks_for_file` (Session G) is all the backend needs. Resolution goes through the public `resolve_target` (same path `resolve_link` uses).
- **Out of scope:** heading completion, "create new block here" affordance in the dropdown, cross-vault completion. YAGNI.
```
