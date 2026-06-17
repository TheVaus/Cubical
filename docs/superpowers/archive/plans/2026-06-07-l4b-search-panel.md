# L4-B — Persistent Left-Panel Search Results UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persistent `Files | Search` left-panel search surface that runs the L4-A Tantivy index and shows ranked, `<mark>`-highlighted results, and promote the prose fields to `STORED` so snippets are tokenizer-correct (§5 deviation #1 → option (a)).

**Architecture:** A narrow Rust change in `cubical-search` (flip STORED flags + bump `SCHEMA_VERSION`; the doc writer and `collect_snippets` already handle every field). A new Solid `SearchPanel.tsx` backed by three pure, unit-tested modules (`debounce`, `snippet`, `searchQuery`). `App.tsx` gains a left-pane mode toggle persisted as `ui.left_pane_mode`. No new IPC.

**Tech Stack:** Rust + Tantivy 0.22 (`cubical-search`); Solid + TypeScript + Vite (`ui/`); vitest; existing Tauri IPC wrappers in `ui/src/api/ipc.ts`.

**Spec:** `docs/superpowers/specs/2026-06-07-l4b-search-panel-design.md`

**Working branch:** `feat/l4b-search-panel` (already created; the design spec is committed there). Single checkout + branches — **never** `git worktree`.

**Six gates (run at every commit boundary):**
- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo fmt --all --check`
- In `ui/`: `npx tsc --noEmit`
- In `ui/`: `npm run build`
- In `ui/`: `npx vitest run`

---

## File Structure

- `crates/cubical-search/src/schema.rs` — **modify.** Promote `headings`/`body`/`frontmatter`/`code` to `STORED`; add a stored-flag test.
- `crates/cubical-search/src/index.rs` — **modify.** `SCHEMA_VERSION` `1 → 2`.
- `crates/cubical-search/src/query.rs` — **modify.** No logic change; update stale comment + add per-field snippet tests.
- `ui/src/sidebar/debounce.ts` — **create.** Generic trailing-edge debounce with `.cancel()`.
- `ui/src/sidebar/debounce.test.ts` — **create.**
- `ui/src/sidebar/snippet.ts` — **create.** `pickSnippet` + `parseHighlights`.
- `ui/src/sidebar/snippet.test.ts` — **create.**
- `ui/src/sidebar/searchQuery.ts` — **create.** `buildSearchQuery` (chips → `SearchQuery`).
- `ui/src/sidebar/searchQuery.test.ts` — **create.**
- `ui/src/sidebar/SearchPanel.tsx` — **create.** The panel shell. **No component unit test** — the repo has no Solid render library and all UI components are operator-smoke-only (jsdom has no layout engine; Contract E). Its testable logic lives in the three pure modules above.
- `ui/src/App.tsx` — **modify.** Left-pane mode signal + tablist + conditional render + `ui.left_pane_mode` persistence.

Task order: Rust first (the snippet foundation the UI consumes), then the three pure UI modules, then the component, then the `App.tsx` wiring.

---

## Task 1: Promote prose fields to STORED + bump schema version

**Files:**
- Modify: `crates/cubical-search/src/query.rs` (test first)
- Modify: `crates/cubical-search/src/schema.rs`
- Modify: `crates/cubical-search/src/index.rs:14`

- [ ] **Step 1: Write the failing test — body snippet is produced**

Add to the `tests` module in `crates/cubical-search/src/query.rs` (after `snippet_contains_mark_tags`):

```rust
    #[test]
    fn body_match_produces_highlighted_snippet() {
        // Regression for L4-B (§5 deviation #1 → option (a)): once
        // `body` is STORED, a body hit must yield a <mark>-bearing
        // snippet, not just a title snippet.
        let (_t, idx) = fixture_index();
        let r = run_search(
            &idx,
            &SearchQuery {
                text: "fox".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert_eq!(r.hits[0].path, "a.md");
        let body = r.hits[0]
            .matched_fields
            .iter()
            .find(|m| m.field == "body")
            .map(|m| m.snippet.as_str())
            .expect("body field should produce a snippet once STORED");
        assert!(
            body.contains("<mark>") && body.contains("</mark>"),
            "expected <mark> highlights in body snippet, got: {body}"
        );
    }

    #[test]
    fn headings_and_code_matches_produce_snippets() {
        let (_t, idx) = fixture_index();
        let h = run_search(
            &idx,
            &SearchQuery {
                text: "Heading".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::HeadingsOnly,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert!(h.hits[0]
            .matched_fields
            .iter()
            .any(|m| m.field == "headings" && m.snippet.contains("<mark>")));

        let c = run_search(
            &idx,
            &SearchQuery {
                text: "alpha".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::CodeOnly,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert!(c.hits[0]
            .matched_fields
            .iter()
            .any(|m| m.field == "code" && m.snippet.contains("<mark>")));
    }
```

Add to the `tests` module in `crates/cubical-search/src/schema.rs`:

```rust
    #[test]
    fn prose_fields_are_stored() {
        let (schema, f) = build_schema();
        for field in [f.headings, f.body, f.code, f.frontmatter] {
            assert!(
                schema.get_field_entry(field).is_stored(),
                "expected {} to be STORED",
                schema.get_field_name(field)
            );
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p cubical-search`
Expected: FAIL — `body_match_produces_highlighted_snippet` panics on the `.expect(...)` (body not stored → empty snippet), `headings_and_code_matches_produce_snippets` fails its asserts, and `prose_fields_are_stored` fails (`is_stored()` is false).

- [ ] **Step 3: Promote the fields to STORED in `schema.rs`**

In `crates/cubical-search/src/schema.rs`, replace the options block (the `en_stem_stored` / `en_stem_not_stored` / `code_not_stored` lets and the `add_text_field` calls) with:

```rust
    let en_stem_stored = TextOptions::default()
        .set_indexing_options(en_stem_indexing.clone())
        .set_stored();
    let code_stored = TextOptions::default()
        .set_indexing_options(code_indexing)
        .set_stored();

    let path = sb.add_text_field("path", STRING | STORED);
    let title = sb.add_text_field("title", en_stem_stored.clone());
    let headings = sb.add_text_field("headings", en_stem_stored.clone());
    let body = sb.add_text_field("body", en_stem_stored.clone());
    let code = sb.add_text_field("code", code_stored);
    let tags = sb.add_text_field("tags", STRING | STORED);
    let frontmatter = sb.add_text_field("frontmatter", en_stem_stored);
    let mtime_secs = sb.add_i64_field("mtime_secs", INDEXED | STORED | FAST);
    let size_bytes = sb.add_u64_field("size_bytes", INDEXED | STORED | FAST);
```

Then update the four `Fields` doc comments so each reads `Stored.` instead of `Not stored.`:

```rust
    /// Concatenated heading text. `TEXT` + `en_stem`. Stored.
    pub headings: Field,
    /// Prose body. `TEXT` + `en_stem`. Stored.
    pub body: Field,
    /// Code text. `TEXT` + `code`. Stored.
    pub code: Field,
    /// Multi-valued lowercase tag strings. `STRING`. Stored.
    pub tags: Field,
    /// Flattened frontmatter scalars. `TEXT` + `en_stem`. Stored.
    pub frontmatter: Field,
```

- [ ] **Step 4: Bump the schema version in `index.rs`**

In `crates/cubical-search/src/index.rs`, change line 14:

```rust
pub const SCHEMA_VERSION: u32 = 2;
```

- [ ] **Step 5: Update the now-stale comment in `query.rs`**

In `crates/cubical-search/src/query.rs`, replace the multi-line comment at the top of `snippet_contains_mark_tags` (the block beginning `// `title` is the only stored text field…`) with:

```rust
        // As of L4-B all prose fields are STORED, so any matched text
        // field can yield a snippet. This test pins the title path: the
        // query matches `title` on "Alpha Notes" so we exercise the
        // `<b>` → `<mark>` post-processing on a title snippet.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p cubical-search`
Expected: PASS — all new tests green; the existing `snippet_contains_mark_tags`, schema, and index tests still pass (the version bump exercises the existing wipe+rebuild branch on open).

- [ ] **Step 7: Run the Rust gates**

Run: `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/cubical-search/src/schema.rs crates/cubical-search/src/index.rs crates/cubical-search/src/query.rs
git commit -m "feat(search): store prose fields for snippets; SCHEMA_VERSION 2

Resolves layer-4-spec §5 deviation #1 as option (a): promote
headings/body/code/frontmatter to STORED so Tantivy generates
tokenizer-correct <mark> snippets for every matched field, not just
title. Bumping SCHEMA_VERSION 1->2 triggers the existing wipe+rebuild
path in SearchIndex::open. The doc writer and collect_snippets already
handle all fields, so no query-logic change was needed.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `debounce` utility

**Files:**
- Create: `ui/src/sidebar/debounce.ts`
- Test: `ui/src/sidebar/debounce.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/sidebar/debounce.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "./debounce";

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once on the trailing edge after the delay", () => {
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("a");
    d("b");
    d("c");
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
  });

  it("cancel() prevents a pending call", () => {
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("x");
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/sidebar/debounce.test.ts`
Expected: FAIL — cannot resolve `./debounce`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/sidebar/debounce.ts`:

```ts
/**
 * Trailing-edge debounce. Returns a callable that delays `fn` until
 * `ms` has elapsed since the last invocation; `.cancel()` drops any
 * pending call. Used by the search panel to throttle keystroke-driven
 * queries.
 */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = ((...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  }) as Debounced<A>;
  debounced.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return debounced;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/sidebar/debounce.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/sidebar/debounce.ts ui/src/sidebar/debounce.test.ts
git commit -m "feat(search): debounce utility for the search panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `snippet` — pickSnippet + parseHighlights

**Files:**
- Create: `ui/src/sidebar/snippet.ts`
- Test: `ui/src/sidebar/snippet.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/sidebar/snippet.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MatchedField } from "../api/ipc";
import { parseHighlights, pickSnippet } from "./snippet";

const mf = (field: string, snippet: string): MatchedField => ({ field, snippet });

describe("pickSnippet", () => {
  it("prefers body over headings/code/frontmatter/title", () => {
    const fields = [mf("title", "t"), mf("headings", "h"), mf("body", "b")];
    expect(pickSnippet(fields)?.field).toBe("body");
  });

  it("falls through the priority order when body is absent", () => {
    expect(pickSnippet([mf("title", "t"), mf("code", "c")])?.field).toBe("code");
    expect(pickSnippet([mf("title", "t"), mf("frontmatter", "f")])?.field).toBe(
      "frontmatter",
    );
    expect(pickSnippet([mf("title", "t")])?.field).toBe("title");
  });

  it("returns null for an empty list", () => {
    expect(pickSnippet([])).toBeNull();
  });
});

describe("parseHighlights", () => {
  it("returns a single unmarked segment for plain text", () => {
    expect(parseHighlights("plain text")).toEqual([
      { text: "plain text", mark: false },
    ]);
  });

  it("marks a single highlight", () => {
    expect(parseHighlights("the <mark>quick</mark> fox")).toEqual([
      { text: "the ", mark: false },
      { text: "quick", mark: true },
      { text: " fox", mark: false },
    ]);
  });

  it("handles multiple and adjacent marks", () => {
    expect(parseHighlights("<mark>a</mark><mark>b</mark> c")).toEqual([
      { text: "a", mark: true },
      { text: "b", mark: true },
      { text: " c", mark: false },
    ]);
  });

  it("unescapes HTML entities Tantivy emits", () => {
    expect(parseHighlights("a &amp; b &lt;tag&gt; &quot;q&quot; &#x27;s&#x27;")).toEqual([
      { text: `a & b <tag> "q" 's`, mark: false },
    ]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseHighlights("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/sidebar/snippet.test.ts`
Expected: FAIL — cannot resolve `./snippet`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/sidebar/snippet.ts`:

```ts
import type { MatchedField } from "../api/ipc";

/**
 * Snippet selection + highlight parsing for the search panel.
 *
 * The backend returns one `<mark>`-highlighted snippet per matched
 * field. `pickSnippet` chooses the most context-rich field to show in a
 * one-line result row; `parseHighlights` turns the snippet HTML into
 * plain segments the component renders as text nodes + <mark> spans
 * (never via innerHTML).
 */

/** Field preference for the single snippet shown per result row. */
const FIELD_PRIORITY = ["body", "headings", "code", "frontmatter", "title"];

export function pickSnippet(matched: MatchedField[]): MatchedField | null {
  for (const field of FIELD_PRIORITY) {
    const found = matched.find((m) => m.field === field);
    if (found) return found;
  }
  return matched.length > 0 ? matched[0] : null;
}

/** One run of snippet text, flagged as highlighted or not. */
export interface HighlightSegment {
  text: string;
  mark: boolean;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&"); // last, so we don't double-unescape
}

/**
 * Split a Tantivy snippet on `<mark>` / `</mark>` into alternating
 * segments. Tantivy emits well-formed alternating tags, so a boolean
 * toggle tracks highlight state. Empty fragments are dropped but still
 * advance the toggle.
 */
export function parseHighlights(snippet: string): HighlightSegment[] {
  const parts = snippet.split(/<mark>|<\/mark>/);
  const segments: HighlightSegment[] = [];
  let mark = false;
  for (const part of parts) {
    if (part.length > 0) {
      segments.push({ text: unescapeHtml(part), mark });
    }
    mark = !mark;
  }
  return segments;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/sidebar/snippet.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/sidebar/snippet.ts ui/src/sidebar/snippet.test.ts
git commit -m "feat(search): snippet selection + highlight parsing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `searchQuery` — chips → SearchQuery

**Files:**
- Create: `ui/src/sidebar/searchQuery.ts`
- Test: `ui/src/sidebar/searchQuery.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/sidebar/searchQuery.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSearchQuery } from "./searchQuery";

describe("buildSearchQuery", () => {
  it("maps default scope and passes sort/limit/offset through, fuzzy on", () => {
    const q = buildSearchQuery({
      text: "hello world",
      sort: "relevance",
      scope: "default",
      limit: 50,
      offset: 0,
    });
    expect(q).toEqual({
      text: "hello world",
      limit: 50,
      offset: 0,
      fields: { kind: "default" },
      fuzzy: true,
      sort: "relevance",
    });
  });

  it("maps single-field scopes", () => {
    expect(
      buildSearchQuery({ text: "x", sort: "recency_desc", scope: "headings_only", limit: 50, offset: 0 }).fields,
    ).toEqual({ kind: "headings_only" });
    expect(
      buildSearchQuery({ text: "x", sort: "relevance", scope: "body_only", limit: 50, offset: 0 }).fields,
    ).toEqual({ kind: "body_only" });
    expect(
      buildSearchQuery({ text: "x", sort: "relevance", scope: "code_only", limit: 50, offset: 0 }).fields,
    ).toEqual({ kind: "code_only" });
  });

  it("splits the query box into tags for the tags scope", () => {
    expect(
      buildSearchQuery({ text: "  project/cubical   urgent ", sort: "relevance", scope: "tags", limit: 50, offset: 0 }).fields,
    ).toEqual({ kind: "tags", tags: ["project/cubical", "urgent"] });
  });

  it("yields an empty tag list when the query box is blank under tags scope", () => {
    expect(
      buildSearchQuery({ text: "   ", sort: "relevance", scope: "tags", limit: 50, offset: 0 }).fields,
    ).toEqual({ kind: "tags", tags: [] });
  });

  it("carries recency_desc sort through", () => {
    expect(
      buildSearchQuery({ text: "x", sort: "recency_desc", scope: "default", limit: 50, offset: 0 }).sort,
    ).toBe("recency_desc");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/sidebar/searchQuery.test.ts`
Expected: FAIL — cannot resolve `./searchQuery`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/sidebar/searchQuery.ts`:

```ts
import type { FieldScope, SearchQuery, SortMode } from "../api/ipc";

/**
 * Map the search panel's chip state into the wire `SearchQuery`.
 *
 * `fuzzy` is always requested; the backend only applies it to
 * single-term, ≥4-char queries under default scope, so enabling it here
 * just opts into typo tolerance where the backend allows it. The `tags`
 * scope reinterprets the query box as whitespace-separated tag names
 * (AND-matched, lowercased backend-side).
 */
export type ScopeKind =
  | "default"
  | "headings_only"
  | "body_only"
  | "code_only"
  | "tags";

export interface QueryInput {
  text: string;
  sort: SortMode;
  scope: ScopeKind;
  limit: number;
  offset: number;
}

function buildFieldScope(scope: ScopeKind, text: string): FieldScope {
  switch (scope) {
    case "headings_only":
      return { kind: "headings_only" };
    case "body_only":
      return { kind: "body_only" };
    case "code_only":
      return { kind: "code_only" };
    case "tags":
      return {
        kind: "tags",
        tags: text.split(/\s+/).filter((t) => t.length > 0),
      };
    case "default":
    default:
      return { kind: "default" };
  }
}

export function buildSearchQuery(input: QueryInput): SearchQuery {
  return {
    text: input.text,
    limit: input.limit,
    offset: input.offset,
    fields: buildFieldScope(input.scope, input.text),
    fuzzy: true,
    sort: input.sort,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/sidebar/searchQuery.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/sidebar/searchQuery.ts ui/src/sidebar/searchQuery.test.ts
git commit -m "feat(search): chip-state to SearchQuery mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `SearchPanel` component

**Files:**
- Create: `ui/src/sidebar/SearchPanel.tsx`

**No component unit test.** The repo has no Solid render library and every
UI component is operator-smoke-only — jsdom has no layout engine, so the
virtualised list, live IPC round-trip, and indexing banner can only be
exercised in `cargo tauri dev` (Contract E; see the CLAUDE.md methodology
note "don't ship editor fixes on unit tests alone"). All of the panel's
*testable* logic — the chip→query mapping, snippet selection, highlight
parsing, and debounce — is already unit-tested in Tasks 2–4. The component
is the glue that wires those plus `computeWindow` and the IPC wrappers
together; it is verified in the Task 7 operator smoke.

- [ ] **Step 1: Write the component**

Create `ui/src/sidebar/SearchPanel.tsx`:

```tsx
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import {
  search,
  searchIndexStatus,
  type IndexStatus,
  type SearchHit,
  type SortMode,
} from "../api/ipc";
import { computeWindow } from "../virtualList";
import { debounce } from "./debounce";
import { parseHighlights, pickSnippet } from "./snippet";
import { buildSearchQuery, type ScopeKind } from "./searchQuery";

/**
 * L4-B persistent search panel. Lives in the left column behind the
 * `Files | Search` toggle. Debounced query into the L4-A `search` IPC;
 * sort + scope chips drive the `SearchQuery`; results render as
 * fixed-height, virtualised, `<mark>`-highlighted cards. A polled
 * `search_index_status` banner shows while the index is still building.
 */
export interface SearchPanelProps {
  vaultId: string | null;
  onNavigate: (path: string) => void;
}

const DEBOUNCE_MS = 200;
const PAGE_LIMIT = 50;
const RESULT_ROW_HEIGHT = 80;
const RESULT_OVERSCAN = 6;
const STATUS_POLL_MS = 500;

const SORTS: { id: SortMode; label: string }[] = [
  { id: "relevance", label: "Relevance" },
  { id: "recency_desc", label: "Recent" },
];

const SCOPES: { id: ScopeKind; label: string }[] = [
  { id: "default", label: "All" },
  { id: "headings_only", label: "Headings" },
  { id: "body_only", label: "Body" },
  { id: "code_only", label: "Code" },
  { id: "tags", label: "Tags" },
];

const SearchPanel: Component<SearchPanelProps> = (props) => {
  const [queryText, setQueryText] = createSignal("");
  const [sort, setSort] = createSignal<SortMode>("relevance");
  const [scope, setScope] = createSignal<ScopeKind>("default");
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<IndexStatus | null>(null);
  const [hasQueried, setHasQueried] = createSignal(false);

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(400);
  const resultWindow = createMemo(() =>
    computeWindow(
      scrollTop(),
      viewportHeight(),
      RESULT_ROW_HEIGHT,
      hits().length,
      RESULT_OVERSCAN,
    ),
  );
  const visibleHits = createMemo(() =>
    hits().slice(resultWindow().startIndex, resultWindow().endIndex),
  );

  let statusTimer: ReturnType<typeof setInterval> | undefined;

  const building = () => status()?.state === "building";

  const pollStatus = async () => {
    const id = props.vaultId;
    if (!id) return;
    try {
      const s = await searchIndexStatus({ vault_id: id });
      setStatus(s);
      if (s.state !== "building" && statusTimer !== undefined) {
        clearInterval(statusTimer);
        statusTimer = undefined;
      }
    } catch (e) {
      console.error("searchIndexStatus failed", e);
    }
  };

  const ensurePolling = () => {
    if (statusTimer === undefined) {
      statusTimer = setInterval(() => void pollStatus(), STATUS_POLL_MS);
    }
  };

  const runQuery = async () => {
    const id = props.vaultId;
    const text = queryText().trim();
    if (!id) return;
    if (text.length === 0) {
      setHits([]);
      setHasQueried(false);
      setError(null);
      return;
    }
    setHasQueried(true);
    try {
      const resp = await search({
        vault_id: id,
        query: buildSearchQuery({
          text,
          sort: sort(),
          scope: scope(),
          limit: PAGE_LIMIT,
          offset: 0,
        }),
      });
      setHits(resp.hits);
      setError(null);
      setScrollTop(0);
      if (resp.still_indexing) ensurePolling();
    } catch (e) {
      setError(messageOf(e));
      // Keep prior hits visible rather than flashing empty.
    }
  };

  const debouncedQuery = debounce(() => void runQuery(), DEBOUNCE_MS);

  const onInput = (value: string) => {
    setQueryText(value);
    debouncedQuery();
  };

  const onSort = (id: SortMode) => {
    setSort(id);
    void runQuery();
  };

  const onScope = (id: ScopeKind) => {
    setScope(id);
    void runQuery();
  };

  onMount(() => {
    void pollStatus();
    ensurePolling();
  });

  onCleanup(() => {
    debouncedQuery.cancel();
    if (statusTimer !== undefined) clearInterval(statusTimer);
  });

  return (
    <div
      style={{
        flex: 1,
        "min-height": 0,
        display: "flex",
        "flex-direction": "column",
        gap: "var(--space-2)",
        border: "1px solid var(--c-border-subtle)",
        "border-radius": "var(--radius-md)",
        background: "var(--c-bg-secondary)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "var(--space-2)" }}>
        <input
          type="text"
          value={queryText()}
          placeholder="Search notes…"
          aria-label="Search notes"
          onInput={(e) => onInput(e.currentTarget.value)}
          style={{
            width: "100%",
            "box-sizing": "border-box",
            padding: "var(--space-2) var(--space-3)",
            "font-family": "var(--font-body)",
            "font-size": "var(--text-sm)",
            color: "var(--c-fg-primary)",
            background: "var(--c-bg-primary)",
            border: "1px solid var(--c-border-subtle)",
            "border-radius": "var(--radius-sm, var(--radius-md))",
          }}
        />
        <div
          style={{
            display: "flex",
            "flex-wrap": "wrap",
            gap: "var(--space-1)",
            "margin-top": "var(--space-2)",
          }}
        >
          <For each={SORTS}>
            {(s) => (
              <Chip
                label={s.label}
                selected={sort() === s.id}
                onClick={() => onSort(s.id)}
              />
            )}
          </For>
          <span style={{ width: "var(--space-2)" }} />
          <For each={SCOPES}>
            {(s) => (
              <Chip
                label={s.label}
                selected={scope() === s.id}
                onClick={() => onScope(s.id)}
              />
            )}
          </For>
        </div>
      </div>

      <Show when={building()}>
        <div
          role="status"
          style={{
            padding: "var(--space-1) var(--space-3)",
            "font-size": "var(--text-xs)",
            color: "var(--c-fg-secondary)",
            "border-top": "1px solid var(--c-border-subtle)",
            "border-bottom": "1px solid var(--c-border-subtle)",
          }}
        >
          Indexing… {status()!.indexed_files} / {status()!.total_files}
        </div>
      </Show>

      <Show when={error()}>
        <div
          role="alert"
          style={{
            padding: "var(--space-1) var(--space-3)",
            "font-size": "var(--text-xs)",
            color: "var(--c-error)",
          }}
        >
          {error()}
        </div>
      </Show>

      <div
        role="listbox"
        aria-label="Search results"
        ref={(el) => setViewportHeight(el.clientHeight || 400)}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          setViewportHeight(e.currentTarget.clientHeight);
        }}
        style={{
          flex: 1,
          "min-height": 0,
          "overflow-y": "auto",
          position: "relative",
        }}
      >
        <Show
          when={hits().length > 0}
          fallback={
            <div
              style={{
                padding: "var(--space-3)",
                "font-size": "var(--text-sm)",
                color: "var(--c-fg-muted)",
              }}
            >
              {hasQueried() ? "No matches" : "Type to search"}
            </div>
          }
        >
          <div
            style={{
              height: `${resultWindow().totalHeight}px`,
              position: "relative",
            }}
          >
            <div style={{ transform: `translateY(${resultWindow().offsetY}px)` }}>
              <For each={visibleHits()}>
                {(hit) => (
                  <ResultRow hit={hit} onClick={() => props.onNavigate(hit.path)} />
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
};

const Chip: Component<{
  label: string;
  selected: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    aria-pressed={props.selected}
    onClick={props.onClick}
    style={{
      padding: "var(--space-1) var(--space-2)",
      "font-family": "var(--font-body)",
      "font-size": "var(--text-xs)",
      color: props.selected ? "var(--c-fg-inverse)" : "var(--c-fg-secondary)",
      background: props.selected ? "var(--c-accent)" : "transparent",
      border: "1px solid var(--c-border-subtle)",
      "border-radius": "var(--radius-sm, var(--radius-md))",
      cursor: "pointer",
    }}
  >
    {props.label}
  </button>
);

const ResultRow: Component<{ hit: SearchHit; onClick: () => void }> = (props) => {
  const snippet = () => pickSnippet(props.hit.matched_fields);
  return (
    <div
      role="option"
      aria-selected={false}
      onClick={props.onClick}
      style={{
        height: `${RESULT_ROW_HEIGHT}px`,
        "box-sizing": "border-box",
        padding: "var(--space-2) var(--space-3)",
        "border-bottom": "1px solid var(--c-border-subtle)",
        display: "flex",
        "flex-direction": "column",
        gap: "var(--space-1)",
        cursor: "pointer",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          "font-size": "var(--text-sm)",
          color: "var(--c-fg-primary)",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {props.hit.title}
      </span>
      <Show when={snippet()}>
        {(s) => (
          <span
            style={{
              "font-size": "var(--text-xs)",
              color: "var(--c-fg-secondary)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            <For each={parseHighlights(s().snippet)}>
              {(seg) =>
                seg.mark ? (
                  <mark
                    style={{
                      background: "var(--c-accent)",
                      color: "var(--c-fg-inverse)",
                      "border-radius": "var(--radius-sm, 2px)",
                      padding: "0 2px",
                    }}
                  >
                    {seg.text}
                  </mark>
                ) : (
                  <span>{seg.text}</span>
                )
              }
            </For>
          </span>
        )}
      </Show>
      <span
        style={{
          "font-family": "var(--font-mono)",
          "font-size": "var(--text-xs)",
          color: "var(--c-fg-muted)",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {props.hit.path}
      </span>
    </div>
  );
};

function messageOf(e: unknown): string {
  return typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

export default SearchPanel;
```

- [ ] **Step 2: Run the UI gates**

Run: `cd ui && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all PASS (`tsc` and `build` confirm the component compiles and the existing suite stays green).

- [ ] **Step 3: Commit**

```bash
git add ui/src/sidebar/SearchPanel.tsx
git commit -m "feat(search): SearchPanel component

Debounced query into the L4-A search IPC; sort + scope chips; virtualised
fixed-height <mark>-highlighted result cards reusing computeWindow; polled
search_index_status indexing banner. List/IPC/banner are operator-smoke-
only (jsdom has no layout engine); pure logic is unit-tested in
debounce/snippet/searchQuery.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Wire the panel into `App.tsx` with a left-pane toggle

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Add the SearchPanel import**

In `ui/src/App.tsx`, add next to the other sidebar imports (near `import Backlinks from "./sidebar/Backlinks";`):

```tsx
import SearchPanel from "./sidebar/SearchPanel";
```

- [ ] **Step 2: Add the left-pane mode signal**

After the `rightSidebarPanel` signal block (around App.tsx:231), add:

```tsx
  // L4-B: which left-column pane is shown — the file tree or the search
  // panel. Persisted per vault as `ui.left_pane_mode` (default `files`).
  type LeftPaneMode = "files" | "search";
  const [leftPaneMode, setLeftPaneMode] = createSignal<LeftPaneMode>("files");

  const handleLeftPaneMode = (mode: LeftPaneMode) => {
    setLeftPaneMode(mode);
    const id = vaultId();
    if (id) {
      setSetting(id, "ui.left_pane_mode", mode).catch((e) => {
        console.error("persisting ui.left_pane_mode failed", e);
      });
    }
  };
```

- [ ] **Step 3: Reset the mode on vault open**

In `handleOpen`, in the reset block (alongside `setRightSidebarPanel("backlinks");` around App.tsx:924), add:

```tsx
      setLeftPaneMode("files");
```

- [ ] **Step 4: Seed the mode from settings on vault open**

In `handleOpen`, after the `ui.right_sidebar_panel` seeding block (around App.tsx:988, before the outer `catch`), add:

```tsx
      // L4-B: seed which left-column pane is selected. Absent key →
      // `files` (the file tree is the default surface).
      try {
        const stored = await getSetting(resp.vault_id, "ui.left_pane_mode");
        if (stored === "files" || stored === "search") setLeftPaneMode(stored);
      } catch (e) {
        console.error("loading ui.left_pane_mode failed", e);
      }
```

- [ ] **Step 5: Wrap the file list with the toggle + conditional render**

In `ui/src/App.tsx`, change the file-list container's `flex` so it fills the wrapper. Replace this line inside the `role="listbox"` div's style (currently App.tsx:1190):

```tsx
                flex: "0 0 18rem",
```

with:

```tsx
                flex: 1,
                "min-height": 0,
```

Then wrap the entire `<div role="listbox" …>…</div>` element (currently App.tsx:1179–1332) so it becomes the `files`-mode branch of a new left-column wrapper. Insert immediately **before** that `<div role="listbox"`:

```tsx
            <div
              style={{
                flex: "0 0 18rem",
                display: "flex",
                "flex-direction": "column",
                "min-height": 0,
                gap: "var(--space-2)",
              }}
            >
              <div
                role="tablist"
                aria-label="Left pane"
                style={{
                  display: "flex",
                  gap: "var(--space-1)",
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={leftPaneMode() === "files"}
                  onClick={() => handleLeftPaneMode("files")}
                  style={{
                    flex: 1,
                    padding: "var(--space-1) var(--space-2)",
                    "font-family": "var(--font-body)",
                    "font-size": "var(--text-xs)",
                    "text-transform": "uppercase",
                    "letter-spacing": "0.05em",
                    color:
                      leftPaneMode() === "files"
                        ? "var(--c-fg-inverse)"
                        : "var(--c-fg-secondary)",
                    background:
                      leftPaneMode() === "files"
                        ? "var(--c-accent)"
                        : "transparent",
                    border: "1px solid var(--c-border-subtle)",
                    "border-radius": "var(--radius-sm, var(--radius-md))",
                    cursor: "pointer",
                  }}
                >
                  Files
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={leftPaneMode() === "search"}
                  onClick={() => handleLeftPaneMode("search")}
                  style={{
                    flex: 1,
                    padding: "var(--space-1) var(--space-2)",
                    "font-family": "var(--font-body)",
                    "font-size": "var(--text-xs)",
                    "text-transform": "uppercase",
                    "letter-spacing": "0.05em",
                    color:
                      leftPaneMode() === "search"
                        ? "var(--c-fg-inverse)"
                        : "var(--c-fg-secondary)",
                    background:
                      leftPaneMode() === "search"
                        ? "var(--c-accent)"
                        : "transparent",
                    border: "1px solid var(--c-border-subtle)",
                    "border-radius": "var(--radius-sm, var(--radius-md))",
                    cursor: "pointer",
                  }}
                >
                  Search
                </button>
              </div>
              <Show
                when={leftPaneMode() === "files"}
                fallback={
                  <SearchPanel
                    vaultId={vaultId()}
                    onNavigate={(path) =>
                      void handleNavigateWikilink(path, null)
                    }
                  />
                }
              >
```

And insert immediately **after** the matching closing `</div>` of that `role="listbox"` element (currently App.tsx:1332):

```tsx
              </Show>
            </div>
```

The result: a `0 0 18rem` left column containing the `Files | Search` tablist, then either the (now `flex: 1`) file listbox or the `SearchPanel`.

- [ ] **Step 6: Type-check and build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: PASS. (If `tsc` flags an unbalanced JSX tag, re-check the wrapper open/close placement around the listbox element.)

- [ ] **Step 7: Run all UI tests**

Run: `cd ui && npx vitest run`
Expected: PASS (full suite, including the new L4-B tests).

- [ ] **Step 8: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(search): Files|Search left-pane toggle wiring

Adds a segmented Files|Search control to the left column, conditionally
rendering the file tree or the SearchPanel; persists the choice as
ui.left_pane_mode per vault (seeded on open, default files). Navigation
reuses handleNavigateWikilink so autosave/seenHash plumbing stays
correct.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Full gate sweep + operator smoke (Contract E)

**Files:** none (verification only).

- [ ] **Step 1: Run the full six-gate sweep**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cd ui && npx tsc --noEmit && npm run build && npx vitest run
```
Expected: all green.

- [ ] **Step 2: Boot the app**

Run: `cargo tauri dev`
Expected: app launches.

- [ ] **Step 3: `open_vault` re-open LockBusy smoke (pending from 2026-06-06)**

Open a vault folder. Then File → Open Vault the **same** folder again. Expected: **no** `search index error: … LockBusy`; the app stays on that vault. Open a **different** folder → distinct vault id. Record the outcome in `docs/superpowers/specs/2026-06-06-idempotent-open-vault-design.md` (Definition of Done) and flip the CLAUDE.md "operator smoke pending" line to confirmed.

- [ ] **Step 4: Search panel smoke**

Switch the left pane to **Search**. Confirm:
- Typing debounces, then returns ranked results with highlighted snippets for body / heading / code / frontmatter / title matches (not just title).
- Sort chips (Relevance / Recent) and scope chips (All / Headings / Body / Code / Tags) change results; Tags scope treats the box as space-separated tag names.
- A large result set scrolls smoothly (virtualization) with no blank flashes.
- Clicking a result opens that file and returns to the editor view.
- Switching back to **Files** restores the tree; the mode survives an app reload (persistence).

- [ ] **Step 5: Indexing banner smoke (§9.1 Recipe 11)**

Open a fresh/large vault; while the scan runs, confirm the "Indexing… N/M" banner shows and results converge as indexing completes.

- [ ] **Step 6: L4-A search recipes 1–11 backfill**

Run `docs/layer-4-spec.md` §9.1 Recipes 1–11 against `~/Developer/sandbox/cubical-l4a-smoke/`. Record results in the L4-B closeout.

- [ ] **Step 7: Update docs + project state**

- Tick the L4-B row in `docs/layer-4-spec.md` §6 and write a §9.3 closeout (what landed, tests, smoke results, the §5 deviation #1 resolution).
- Rewrite the `CLAUDE.md` Project state block (4–6 lines; never append).

- [ ] **Step 8: Commit the docs**

```bash
git add docs/layer-4-spec.md CLAUDE.md docs/superpowers/specs/2026-06-06-idempotent-open-vault-design.md
git commit -m "docs(l4b): closeout, smoke results, project state

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 9: Integrate the branch**

Use `superpowers:finishing-a-development-branch` to merge `feat/l4b-search-panel` into `main` and push. Tag `l4b` **only after** the executed smoke above (Contract E).

---

## Notes for the implementer

- **Why no `doc.rs`/`index.rs` doc-writer change in Task 1:** `index.rs` already writes `headings`/`body`/`code`/`frontmatter` into the Tantivy document, and `collect_snippets` (`query.rs`) already iterates all five text fields. They returned empty snippets only because the schema marked the fields non-stored; flipping the flag is the whole fix.
- **`is_stored()` API:** `schema.get_field_entry(field).is_stored()` (tantivy 0.22).
- **Tantivy `<b>` → `<mark>`:** the backend already rewrites `<b>`/`</b>` to `<mark>`/`</mark>` in `collect_snippets`, so the UI only ever sees `<mark>`.
- **Virtualization reuse:** `computeWindow` assumes a uniform row height — that is exactly why result rows are a fixed `RESULT_ROW_HEIGHT`. Do not introduce variable-height rows without switching virtualizers.
- **No worktrees:** single checkout + branches (per CLAUDE.md and user preference).
```
