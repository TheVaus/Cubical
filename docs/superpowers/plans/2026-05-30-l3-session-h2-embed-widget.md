# L3 Session H.2 — Embed widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Frontend half of Session H — a Live-Preview block widget below each `![[…]]` token that calls `get_embed`, renders the embedded content as preserved-newline plain text inside a styled callout frame, recursively renders nested `![[…]]` inside that content up to depth 4 (beyond → styled link), detects cycles via a chain of resolved paths (cycle → styled link), and renders a styled placeholder for unresolved targets and missing anchors.

**Architecture:**
- New `EmbedResolver` (per-vault cache over `get_embed`) mirrors the L3 Session B `WikiLinkResolver` shape: `get` / `fetch` / `resolve` / `invalidate` / `onUpdate`, injected IPC, cache-miss + dedupe semantics, kebab-friendly `target_raw` cache key.
- Pure `renderEmbedBody(ctx)` returns a `DocumentFragment` — handles cold-cache placeholder, depth cap, cycle detection, unresolved / missing-anchor placeholders, content rendering with nested `![[…]]` recursion (cap = 4, default chain seeded with the open note's path).
- CM6 extension in `ui/src/editor/embed.ts` — a `StateField<DecorationSet>` (block decorations cannot come from a `ViewPlugin`) that walks the Lezer tree on every doc / facet / cache change and produces one `Decoration.widget({ block: true, side: 1 })` per `WikiLink` node whose token is an embed (`![[…]]`). The widget mounts the renderer.
- Resolver plumbed through `Editor.tsx` via `embedResolverFacet` + `embedResolverCompartment` + `embedResolverUpdated` `StateEffect`, exactly mirroring the wiki-link wiring.
- `App.tsx` owns one `EmbedResolver` per open vault; resets it on vault open, invalidates it on every `vault:file-changed`.
- The existing inline `mark-wikilink-embed` indicator (`⎘`) in `decorations.ts` is **kept** unchanged. The block widget renders below the source line; the inline glyph remains as a marker on the source token. H.3 can decide whether to retire it.

**Tech Stack:** TypeScript, Solid (App / Editor wiring only — the widget is plain DOM), CodeMirror 6 (`StateField`, `Decoration.widget`, `WidgetType`, `Facet`, `Compartment`, `StateEffect`), Lezer (`syntaxTree`, `WikiLink` node from L3 Session B's grammar rule), Vitest (jsdom). Backend already shipped in Session H.1.

**Branch:** `l3-session-h2-embed-widget` cut from `main` (single-checkout workflow — no worktrees).

**Spec:** `docs/layer-3-spec.md` §2.8 (DoD), §9.12 (H.1 — backend, done), §9.13 (this session — to append).
**Architecture:** `docs/architecture/document-model.md` §5.4 (max depth 4 default).

---

## Background — read before touching code

You have no prior context. Read this and the referenced files before starting.

- **Spec §2.8 (`docs/layer-3-spec.md:106`).** Embeds resolve through the same link index as wiki-links (`is_embed = 1` — already populated by L3 Session A). Recursion is bounded — default max depth 4. Beyond the depth, the embed renders as a styled link. Unresolved embeds render a placeholder.
- **`document-model.md` §5.4.** Confirms the default max depth = 4.
- **Backend (H.1) is done.** `get_embed { vault_id, target_raw }` → `GetEmbedResponse { kind, target_path, content }` where `kind` is `"note" | "section" | "block" | "unresolved" | "missing-anchor"`. `target_path` is `null` only for `"unresolved"`. `content` is `null` for `"unresolved"` and `"missing-anchor"`. Wire types + IPC binding already in [ui/src/api/ipc.ts:483-508](ui/src/api/ipc.ts:483).
- **Wiki-link resolver is the model.** Read [ui/src/editor/wikilinkResolver.ts](ui/src/editor/wikilinkResolver.ts) end-to-end before writing the embed resolver. The embed resolver copies its surface verbatim, renaming `resolveLink` → `getEmbed` and `WikiLinkResolution` → `EmbedResolution`. Its tests at [ui/src/editor/wikilinkResolver.test.ts](ui/src/editor/wikilinkResolver.test.ts) are the parallel template for `embedResolver.test.ts`.
- **The `WikiLink` Lezer node.** L3 Session B registered a `MarkdownConfig` extension at [ui/src/editor/wikilink.ts](ui/src/editor/wikilink.ts) that emits a single `WikiLink` node spanning the entire `[[…]]` or `![[…]]` token. The slice between `node.from` and `node.to` is the literal source text; re-tokenise it with `scanWikilinks` from [ui/src/ast/wikilink.ts](ui/src/ast/wikilink.ts) to extract `{ target, display, anchor, embed }` (this is what [decorations.ts:381](ui/src/editor/decorations.ts:381) does for the existing inline indicator).
- **`resolverKey(tok)` shape.** The cache key for a wiki-link target is `target` if `anchor === null`, else `${target}${anchor.kind === "block" ? "#^" : "#"}${anchor.value}`. The embed resolver uses the **same** key shape — `target_raw` is the wire field name on `GetEmbedRequest`. Define a local `embedKey` helper in `embedResolver.ts` rather than importing from `decorations.ts` (`decorations.ts`' helper is module-private).
- **Block decorations + `StateField`.** Block decorations cannot be supplied by a `ViewPlugin` ("Block decorations may not be specified via plugins"). See `frontmatterHideField` at [decorations.ts:680](ui/src/editor/decorations.ts:680) for the existing `StateField<DecorationSet>` pattern in this codebase. The embed extension follows that pattern.
- **Editor plumbing precedent.** See:
  - `wikilinkResolverFacet` / `wikilinkResolverUpdated` / `WikiLinkResolverFacetValue` at [decorations.ts:87-109](ui/src/editor/decorations.ts:87).
  - `wikilinkResolverCompartment` + `facetValueFor` + `subscribeResolver` at [Editor.tsx:64-86](ui/src/Editor.tsx:64), [Editor.tsx:220-232](ui/src/Editor.tsx:220), [Editor.tsx:351-353](ui/src/Editor.tsx:351), [Editor.tsx:421](ui/src/Editor.tsx:421), [Editor.tsx:526-543](ui/src/Editor.tsx:526).
  - App-side resolver lifecycle: [App.tsx:170 (signal)](ui/src/App.tsx:170), [App.tsx:668 (invalidate on `vault:file-changed`)](ui/src/App.tsx:668), [App.tsx:788 (reset to null)](ui/src/App.tsx:788), [App.tsx:797 (create on open)](ui/src/App.tsx:797).
- **The open note's path.** `App.tsx` exposes `selectedPath()` (a `string | null` signal). The seed chain for the top-level embed-widget rendering must include the open note's resolved path so that `![[OpenNote]]` inside itself is caught as a cycle. Pipe the open-note path into the editor (already implicitly known via the editor's own buffer — but the editor doesn't carry a path prop today). **Add a new `openNotePath?: string | null` prop on `Editor` and feed it through to the embed widget via a separate `openNotePathFacet`.** Don't widen the resolver facet shape with this — it's a separate concern.
- **Cycle detection chain semantics.** When the renderer recurses into a nested `![[X]]`, the chain it passes down is `[...chain, parent.target_path]` where `parent.target_path` is the resolved path of the embed currently being rendered. The seed chain at the top level is `[openNotePath]` when the open note path is known, else `[]`. A cycle is detected when the about-to-render embed's resolved target_path is already in the chain. Depth cap is detected when `chain.length >= maxDepth`.
- **Plain-text rendering.** The widget renders `content` as **preserved-newline plain text** inside a `<pre class="cm-md-embed-body">` or `<div>` with `white-space: pre-wrap`. **No markdown rendering inside the widget** (that is H.3). Only nested `![[…]]` tokens within the content are recognized and replaced with recursive embed sub-elements; everything else is text.
- **Styled-link "beyond-depth / cycle" form.** Render as `<a class="cm-md-embed-link cm-md-embed-link-{cycle|depth}">![[target]]</a>` carrying the raw `target_raw`. Not interactive in H.2 — purely a visual fallback.
- **Placeholder form.** Render as `<div class="cm-md-embed-placeholder cm-md-embed-placeholder-{unresolved|missing-anchor}">⚠ {message}</div>`. Messages: `"Couldn't resolve [[target]]"` / `"Anchor not found in [[target]]"`.
- **Test environment.** Vitest is configured with jsdom — `document.createElement` works in tests. The renderer is the pure unit (input: ctx; output: `DocumentFragment`); the CM6 extension is integration-tested with a real `EditorView` (see existing patterns in [decorations.test.ts](ui/src/editor/decorations.test.ts) for `EditorView` construction).
- **Solid is not used inside the widget.** CM6 owns the widget DOM; building plain DOM is simpler and easier to test than mounting a Solid root. Resolver subscriptions trigger a `StateEffect` that rebuilds the `StateField`; CM6 then re-mounts the widget DOM. This matches how the wiki-link decorations rebuild on resolver updates.

### Scope boundaries — do NOT do these

- **No markdown formatting inside the embed body.** Headings, emphasis, code, lists — all render as plain text. That's H.3.
- **No click navigation on embed-body content.** Clicks inside the body don't open the source note. Defer to H.3 or a future polish session.
- **No editing inside the widget.** The widget is read-only; the user edits the `![[…]]` source line above it.
- **No new IPC.** `get_embed` already does the work.
- **No removal or reshape of the existing `EmbedIndicatorWidget` glyph.** Decorations.ts is touched only to confirm the inline `⎘` indicator stays. The block widget is added alongside.
- **No depth-cap configurability.** Hard-coded `MAX_EMBED_DEPTH = 4` from `document-model.md` §5.4. A `settings.ts` exposure is a later session.
- **No backend changes.** H.1 shipped the backend.

---

## File Structure

**Create:**
- `ui/src/editor/embedResolver.ts` — per-vault `EmbedResolver` cache over `getEmbed`.
- `ui/src/editor/embedResolver.test.ts` — resolver unit tests.
- `ui/src/editor/embedRender.ts` — pure DOM renderer (`renderEmbedBody`, `renderPlaceholder`, `renderDepthOrCycleLink`).
- `ui/src/editor/embedRender.test.ts` — renderer unit tests against jsdom.
- `ui/src/editor/embed.ts` — CM6 extension: `embedResolverFacet`, `embedResolverUpdated`, `openNotePathFacet`, `EmbedBlockWidget` class, `embedBlockField` (`StateField<DecorationSet>`), `embedExtension` bundle (field + base theme).
- `ui/src/editor/embed.test.ts` — CM6 integration tests (decoration emitted at right positions; tree-walk shape).

**Modify:**
- `ui/src/Editor.tsx` — add `embedResolver` + `openNotePath` props; add `embedResolverCompartment` + `openNotePathCompartment`; subscribe to resolver updates and dispatch `embedResolverUpdated`; include `embedExtension` in the `EditorState.extensions` list; add the swap-on-prop-change `createEffect`s.
- `ui/src/App.tsx` — add `embedResolver` signal; reset to `null` in vault close; instantiate `createEmbedResolver(vault_id)` on vault open; invalidate on `vault:file-changed`; pass to `<Editor embedResolver={…} openNotePath={…} />`.
- `docs/layer-3-spec.md` — append §9.13.
- `CLAUDE.md` — rewrite the Project state block.

**Do not touch:**
- `crates/cubical-*` — Rust is done.
- `ui/src/api/ipc.ts` — binding is already in place.
- `ui/src/editor/decorations.ts` — inline `mark-wikilink-embed` glyph stays as-is.
- `ui/src/ast/wikilink.ts` — tokenizer is reused as-is.

---

### Task 1: Embed resolver (`ui/src/editor/embedResolver.ts`)

**Files:**
- Create: `ui/src/editor/embedResolver.ts`
- Create: `ui/src/editor/embedResolver.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

Create `ui/src/editor/embedResolver.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { createEmbedResolver } from "./embedResolver";
import type { GetEmbedRequest, GetEmbedResponse } from "../api/ipc";

function makeIpc(
  resp: GetEmbedResponse | Error,
): (req: GetEmbedRequest) => Promise<GetEmbedResponse> {
  return vi.fn().mockImplementation(() =>
    resp instanceof Error ? Promise.reject(resp) : Promise.resolve(resp),
  );
}

const RESOLVED: GetEmbedResponse = {
  kind: "note",
  target_path: "notes/Daily.md",
  content: "hello world\n",
};

describe("createEmbedResolver", () => {
  it("returns undefined for an uncached target", () => {
    const r = createEmbedResolver("v1", makeIpc(RESOLVED));
    expect(r.get("Daily")).toBeUndefined();
  });

  it("populates the cache after fetch", async () => {
    const ipc = makeIpc(RESOLVED);
    const r = createEmbedResolver("v1", ipc);
    await r.resolve("Daily");
    expect(r.get("Daily")).toEqual(RESOLVED);
    expect(ipc).toHaveBeenCalledTimes(1);
    expect(ipc).toHaveBeenCalledWith({ vault_id: "v1", target_raw: "Daily" });
  });

  it("dedupes concurrent fetches for the same target", async () => {
    const ipc = makeIpc(RESOLVED);
    const r = createEmbedResolver("v1", ipc);
    r.fetch("Daily");
    r.fetch("Daily");
    await r.resolve("Daily");
    expect(ipc).toHaveBeenCalledTimes(1);
  });

  it("caches IPC failures as an unresolved entry", async () => {
    const ipc = makeIpc(new Error("boom"));
    const r = createEmbedResolver("v1", ipc);
    const entry = await r.resolve("Ghost");
    expect(entry).toEqual({
      kind: "unresolved",
      target_path: null,
      content: null,
    });
    expect(r.get("Ghost")).toEqual(entry);
  });

  it("notifies subscribers on fetch completion and on invalidate", async () => {
    const ipc = makeIpc(RESOLVED);
    const r = createEmbedResolver("v1", ipc);
    const fn = vi.fn();
    const unsub = r.onUpdate(fn);
    await r.resolve("Daily");
    expect(fn).toHaveBeenCalledTimes(1);
    r.invalidate();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r.get("Daily")).toBeUndefined();
    unsub();
    r.invalidate();
    expect(fn).toHaveBeenCalledTimes(2); // unsubscribed — no extra call
  });

  it("keeps separate cache entries per anchor", async () => {
    const ipc = vi.fn().mockImplementation((req: GetEmbedRequest) =>
      Promise.resolve({
        ...RESOLVED,
        content: `for ${req.target_raw}`,
      }),
    );
    const r = createEmbedResolver("v1", ipc);
    await r.resolve("Daily");
    await r.resolve("Daily#Intro");
    expect(r.get("Daily")?.content).toBe("for Daily");
    expect(r.get("Daily#Intro")?.content).toBe("for Daily#Intro");
  });
});
```

- [ ] **Step 2: Run the tests, verify failure**

Run: `cd ui && npx vitest run src/editor/embedResolver.test.ts`
Expected: FAIL — module `./embedResolver` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `ui/src/editor/embedResolver.ts`:

```typescript
/**
 * Per-vault embed resolution cache (L3 Session H.2, spec §2.8).
 *
 * A small in-memory store over the L3 Session H.1 `get_embed` IPC.
 * Each editor session is given one resolver bound to the open vault;
 * the resolver caches answers keyed on the wiki-link target string (as
 * written in the source, including any `#anchor`), dedupes concurrent
 * fetches, and notifies subscribers when the cache changes.
 *
 * Mirrors the L3 Session B `WikiLinkResolver` shape so the editor wiring
 * is symmetrical: a Facet supplies `{ get, fetch }` to the decoration
 * `StateField`, an `onUpdate` subscription dispatches a `StateEffect`
 * back into the view to trigger rebuilds, and `invalidate()` is called
 * from `App.tsx`'s `vault:file-changed` listener so freshly-resolvable
 * targets re-render without a reload.
 *
 * Failures cache an `unresolved` entry so a failing target does not
 * re-enter the IPC on every rebuild.
 */

import {
  getEmbed as defaultGetEmbed,
  type GetEmbedRequest,
  type GetEmbedResponse,
} from "../api/ipc";

export type EmbedResolution = GetEmbedResponse;

const UNRESOLVED: EmbedResolution = {
  kind: "unresolved",
  target_path: null,
  content: null,
};

export interface EmbedResolver {
  /** Sync lookup. Returns `undefined` for targets not yet fetched. */
  get(targetRaw: string): EmbedResolution | undefined;
  /** Kick off (or skip if already pending/cached) an async fetch. */
  fetch(targetRaw: string): void;
  /** Awaitable lookup. Resolves to the cached entry, fetching if cold. */
  resolve(targetRaw: string): Promise<EmbedResolution>;
  /** Drop the entire cache and notify subscribers. */
  invalidate(): void;
  /** Subscribe to cache-change notifications. Returns unsubscribe. */
  onUpdate(handler: () => void): () => void;
}

export function createEmbedResolver(
  vaultId: string,
  ipc: (req: GetEmbedRequest) => Promise<GetEmbedResponse> = defaultGetEmbed,
): EmbedResolver {
  const cache = new Map<string, EmbedResolution>();
  const inFlight = new Set<string>();
  const subscribers = new Set<() => void>();

  const notify = () => {
    for (const fn of subscribers) fn();
  };

  const resolver: EmbedResolver = {
    get(targetRaw) {
      return cache.get(targetRaw);
    },
    fetch(targetRaw) {
      if (cache.has(targetRaw) || inFlight.has(targetRaw)) return;
      inFlight.add(targetRaw);
      ipc({ vault_id: vaultId, target_raw: targetRaw })
        .then((resp) => {
          cache.set(targetRaw, resp);
        })
        .catch(() => {
          cache.set(targetRaw, UNRESOLVED);
        })
        .finally(() => {
          inFlight.delete(targetRaw);
          notify();
        });
    },
    resolve(targetRaw) {
      const hit = cache.get(targetRaw);
      if (hit !== undefined) return Promise.resolve(hit);
      resolver.fetch(targetRaw);
      return new Promise((resolveFn) => {
        const unsub = resolver.onUpdate(() => {
          const entry = cache.get(targetRaw);
          if (entry !== undefined) {
            unsub();
            resolveFn(entry);
          }
        });
      });
    },
    invalidate() {
      cache.clear();
      notify();
    },
    onUpdate(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };

  return resolver;
}
```

- [ ] **Step 4: Run the tests, verify pass**

Run: `cd ui && npx vitest run src/editor/embedResolver.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full TS test + typecheck**

Run: `cd ui && npx vitest run && npx tsc --noEmit`
Expected: every test + tsc clean.

- [ ] **Step 6: Commit**

```bash
git checkout -b l3-session-h2-embed-widget
git add ui/src/editor/embedResolver.ts ui/src/editor/embedResolver.test.ts
git commit -m "feat(l3): embed resolver — per-vault cache over get_embed

Mirrors WikiLinkResolver shape: get/fetch/resolve/invalidate/onUpdate
over the H.1 IPC. Cache key = target_raw (target + optional #anchor).
Failures cache as unresolved so they don't re-fire.

Part of L3 Session H.2."
```

---

### Task 2: Pure DOM renderer (`ui/src/editor/embedRender.ts`)

**Files:**
- Create: `ui/src/editor/embedRender.ts`
- Create: `ui/src/editor/embedRender.test.ts`

The renderer is the pure unit of the widget. It returns a `DocumentFragment`. CodeMirror handles the host element. Five cases:

1. **Cycle.** Resolved target_path is already in the chain → styled link.
2. **Depth.** `chain.length >= maxDepth` → styled link.
3. **Cold.** Resolver returns `undefined` → "Loading…" placeholder + `resolver.fetch(targetRaw)` side effect.
4. **Unresolved / Missing-anchor.** Warning placeholder.
5. **Resolved.** Render `content` as preserved-newline text; replace each nested `![[…]]` with a recursive sub-render call, threading the chain.

- [ ] **Step 1: Write the failing renderer tests**

Create `ui/src/editor/embedRender.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { MAX_EMBED_DEPTH, renderEmbedBody } from "./embedRender";
import type { EmbedResolver, EmbedResolution } from "./embedResolver";

function stubResolver(entries: Record<string, EmbedResolution>): {
  resolver: EmbedResolver;
  fetched: string[];
} {
  const fetched: string[] = [];
  return {
    fetched,
    resolver: {
      get: (t) => entries[t],
      fetch: (t) => fetched.push(t),
      resolve: () => Promise.reject(new Error("not used")),
      invalidate: () => undefined,
      onUpdate: () => () => undefined,
    },
  };
}

describe("renderEmbedBody", () => {
  it("renders a 'Loading…' placeholder and kicks a fetch on cache miss", () => {
    const { resolver, fetched } = stubResolver({});
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Daily",
      chain: [],
    });
    expect(frag.querySelector(".cm-md-embed-loading")).not.toBeNull();
    expect(fetched).toEqual(["Daily"]);
  });

  it("renders preserved-newline text for a resolved note embed", () => {
    const { resolver } = stubResolver({
      Daily: {
        kind: "note",
        target_path: "Daily.md",
        content: "line 1\nline 2\n",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Daily",
      chain: [],
    });
    const body = frag.querySelector(".cm-md-embed-body");
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe("line 1\nline 2\n");
  });

  it("renders an unresolved placeholder", () => {
    const { resolver } = stubResolver({
      Ghost: { kind: "unresolved", target_path: null, content: null },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Ghost",
      chain: [],
    });
    const ph = frag.querySelector(".cm-md-embed-placeholder-unresolved");
    expect(ph).not.toBeNull();
    expect(ph!.textContent).toContain("[[Ghost]]");
  });

  it("renders a missing-anchor placeholder", () => {
    const { resolver } = stubResolver({
      "Daily#Ghost": {
        kind: "missing-anchor",
        target_path: "Daily.md",
        content: null,
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Daily#Ghost",
      chain: [],
    });
    const ph = frag.querySelector(".cm-md-embed-placeholder-missing-anchor");
    expect(ph).not.toBeNull();
    expect(ph!.textContent).toContain("[[Daily#Ghost]]");
  });

  it("renders a cycle link when the target_path is already in the chain", () => {
    const { resolver } = stubResolver({
      Self: { kind: "note", target_path: "Self.md", content: "(unused)" },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Self",
      chain: ["Self.md"],
    });
    const link = frag.querySelector(".cm-md-embed-link-cycle");
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe("![[Self]]");
  });

  it("renders a depth link when chain length reaches the cap", () => {
    const { resolver } = stubResolver({
      Deep: { kind: "note", target_path: "Deep.md", content: "(unused)" },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Deep",
      chain: ["a.md", "b.md", "c.md", "d.md"],
    });
    expect(MAX_EMBED_DEPTH).toBe(4);
    const link = frag.querySelector(".cm-md-embed-link-depth");
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe("![[Deep]]");
  });

  it("recursively renders nested ![[…]] within content", () => {
    const { resolver, fetched } = stubResolver({
      Outer: {
        kind: "note",
        target_path: "Outer.md",
        content: "before ![[Inner]] after",
      },
      Inner: { kind: "note", target_path: "Inner.md", content: "INNER" },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Outer",
      chain: [],
    });
    const body = frag.querySelector(".cm-md-embed-body")!;
    // Nested embed renders as its own sub-fragment alongside surrounding
    // text. The DOM contains the inner content somewhere inside.
    expect(body.textContent).toContain("before");
    expect(body.textContent).toContain("after");
    expect(body.textContent).toContain("INNER");
    expect(fetched).toEqual([]); // both cached, none kicked
  });

  it("leaves a non-embed `[[…]]` (no leading `!`) as plain text inside content", () => {
    const { resolver } = stubResolver({
      Outer: {
        kind: "note",
        target_path: "Outer.md",
        content: "see [[Other]] here",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Outer",
      chain: [],
    });
    const body = frag.querySelector(".cm-md-embed-body")!;
    expect(body.textContent).toBe("see [[Other]] here");
  });

  it("threads the chain through nested recursion (cycle within content)", () => {
    const { resolver } = stubResolver({
      A: {
        kind: "note",
        target_path: "A.md",
        content: "loop: ![[B]]",
      },
      B: {
        kind: "note",
        target_path: "B.md",
        content: "back: ![[A]]",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "A",
      chain: ["host.md"],
    });
    // The inner `![[A]]` would put A.md in the chain twice — render
    // the cycle link.
    const cycleLink = frag.querySelector(".cm-md-embed-link-cycle");
    expect(cycleLink).not.toBeNull();
    expect(cycleLink!.textContent).toBe("![[A]]");
  });

  it("renders a section embed body the same way as a note embed body", () => {
    const { resolver } = stubResolver({
      "Daily#Intro": {
        kind: "section",
        target_path: "Daily.md",
        content: "Intro paragraph\n",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Daily#Intro",
      chain: [],
    });
    const body = frag.querySelector(".cm-md-embed-body");
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe("Intro paragraph\n");
  });

  it("renders a block embed body the same way", () => {
    const { resolver } = stubResolver({
      "Daily#^abc123": {
        kind: "block",
        target_path: "Daily.md",
        content: "single block line ^abc123",
      },
    });
    const frag = renderEmbedBody({
      resolver,
      targetRaw: "Daily#^abc123",
      chain: [],
    });
    const body = frag.querySelector(".cm-md-embed-body");
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe("single block line ^abc123");
  });
});
```

- [ ] **Step 2: Run the tests, verify failure**

Run: `cd ui && npx vitest run src/editor/embedRender.test.ts`
Expected: FAIL — `./embedRender` does not export `renderEmbedBody`.

- [ ] **Step 3: Implement the renderer**

Create `ui/src/editor/embedRender.ts`:

```typescript
/**
 * Pure DOM renderer for an embed widget body (L3 Session H.2, spec §2.8).
 *
 * The CodeMirror block widget is a thin host: its `toDOM()` constructs
 * a wrapper element and asks this module to fill it. Keeping the
 * renderer separate keeps it testable in isolation against jsdom, and
 * lets the recursive `![[…]]` walker stay a plain function.
 *
 * Five branches:
 *   1. cycle      — `target_path ∈ chain` → styled cycle link.
 *   2. depth      — `chain.length >= MAX_EMBED_DEPTH` → styled depth link.
 *   3. cold       — `resolver.get(target) === undefined` → "Loading…"
 *                   placeholder + `resolver.fetch(target)` side effect.
 *   4. unresolved
 *      / missing  — `kind === "unresolved" | "missing-anchor"` →
 *                   ⚠ styled placeholder.
 *   5. resolved   — render `content` as preserved-newline plain text;
 *                   replace nested `![[…]]` with recursive sub-renders.
 *
 * Cycle detection: pass the resolved `target_path` of the *current*
 * embed when recursing into a nested one, so the chain grows by one
 * per level. The seed chain is supplied by the caller (the CM6 widget
 * passes the open note's path so a self-embed is caught).
 *
 * Depth: hard-coded `MAX_EMBED_DEPTH = 4` from `document-model.md` §5.4.
 *
 * NB: this module deliberately does not parse markdown. Headings,
 * emphasis, code, lists — all render as plain text. H.3 owns rich
 * rendering inside the body.
 */

import { scanWikilinks } from "../ast/wikilink";
import type { EmbedResolver } from "./embedResolver";

export const MAX_EMBED_DEPTH = 4;

export interface RenderEmbedCtx {
  resolver: EmbedResolver;
  /** The wiki-link target_raw — what the resolver was keyed on. */
  targetRaw: string;
  /** Resolved paths from the open note down to (but not including) the
   *  embed we're about to render. Cycle = `target_path ∈ chain`. */
  chain: string[];
  /** Override the cap. Defaults to {@link MAX_EMBED_DEPTH}. */
  maxDepth?: number;
}

/**
 * Render the body of one embed token. Returns a `DocumentFragment`
 * that the widget host appends. The fragment carries exactly one
 * top-level element (a body div, a placeholder div, a cold-loading
 * div, or a styled link), wrapped so the caller can always treat the
 * result as "the content of the widget".
 */
export function renderEmbedBody(ctx: RenderEmbedCtx): DocumentFragment {
  const frag = document.createDocumentFragment();
  const maxDepth = ctx.maxDepth ?? MAX_EMBED_DEPTH;

  // Depth cap before any cache lookup — cheaper, and matches the
  // "the chain is full, render link" contract regardless of cache state.
  if (ctx.chain.length >= maxDepth) {
    frag.appendChild(depthOrCycleLink(ctx.targetRaw, "depth"));
    return frag;
  }

  const entry = ctx.resolver.get(ctx.targetRaw);
  if (entry === undefined) {
    ctx.resolver.fetch(ctx.targetRaw);
    frag.appendChild(loadingPlaceholder(ctx.targetRaw));
    return frag;
  }

  switch (entry.kind) {
    case "unresolved":
      frag.appendChild(warningPlaceholder("unresolved", ctx.targetRaw));
      return frag;
    case "missing-anchor":
      frag.appendChild(warningPlaceholder("missing-anchor", ctx.targetRaw));
      return frag;
    case "note":
    case "section":
    case "block": {
      // Cycle check uses the *resolved* path — `target_path` is non-null
      // for every resolved kind (H.1 §9.12).
      const here = entry.target_path;
      if (here !== null && ctx.chain.includes(here)) {
        frag.appendChild(depthOrCycleLink(ctx.targetRaw, "cycle"));
        return frag;
      }
      const body = document.createElement("div");
      body.className = "cm-md-embed-body";
      const nextChain = here === null ? ctx.chain : [...ctx.chain, here];
      appendContentWithNestedEmbeds(body, entry.content ?? "", {
        resolver: ctx.resolver,
        chain: nextChain,
        maxDepth,
      });
      frag.appendChild(body);
      return frag;
    }
  }
}

interface NestedCtx {
  resolver: EmbedResolver;
  chain: string[];
  maxDepth: number;
}

/**
 * Walk `content`, emitting text spans verbatim and recursively
 * rendering nested `![[…]]` tokens. Non-embed `[[…]]` tokens (no
 * leading `!`) stay as literal text — spec §2.8 only inlines embeds.
 */
function appendContentWithNestedEmbeds(
  host: HTMLElement,
  content: string,
  ctx: NestedCtx,
): void {
  const runs = scanWikilinks(content);
  for (const run of runs) {
    if (run.kind === "text") {
      host.appendChild(document.createTextNode(run.value));
      continue;
    }
    if (!run.embed) {
      // Plain wiki-link inside an embed body: stays as literal source.
      // Reconstruct `[[target|display]]` / `[[target#anchor]]` form.
      host.appendChild(document.createTextNode(reconstructLiteral(run, false)));
      continue;
    }
    const nestedTargetRaw = reconstructTargetRaw(run);
    const sub = renderEmbedBody({
      resolver: ctx.resolver,
      targetRaw: nestedTargetRaw,
      chain: ctx.chain,
      maxDepth: ctx.maxDepth,
    });
    host.appendChild(sub);
  }
}

/**
 * Reconstruct the `target_raw` cache key for a nested wiki-link.
 * Mirrors the wiki-link resolver key shape: `target` + optional
 * `#heading` or `#^block-id`.
 */
function reconstructTargetRaw(
  tok: Extract<ReturnType<typeof scanWikilinks>[number], { kind: "wiki_link" }>,
): string {
  if (tok.anchor === null) return tok.target;
  const prefix = tok.anchor.kind === "block" ? "#^" : "#";
  return `${tok.target}${prefix}${tok.anchor.value}`;
}

/** Reconstruct the literal source form for a non-embed wiki-link run. */
function reconstructLiteral(
  tok: Extract<ReturnType<typeof scanWikilinks>[number], { kind: "wiki_link" }>,
  embed: boolean,
): string {
  const open = embed ? "![[" : "[[";
  const target = tok.target;
  const anchor =
    tok.anchor === null
      ? ""
      : (tok.anchor.kind === "block" ? "#^" : "#") + tok.anchor.value;
  const display = tok.display === null ? "" : `|${tok.display}`;
  return `${open}${target}${anchor}${display}]]`;
}

function depthOrCycleLink(
  targetRaw: string,
  kind: "depth" | "cycle",
): HTMLElement {
  const a = document.createElement("a");
  a.className = `cm-md-embed-link cm-md-embed-link-${kind}`;
  a.textContent = `![[${targetRaw}]]`;
  a.setAttribute("aria-label", `embed-${kind}`);
  return a;
}

function loadingPlaceholder(targetRaw: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "cm-md-embed-placeholder cm-md-embed-loading";
  d.textContent = `Loading [[${targetRaw}]]…`;
  return d;
}

function warningPlaceholder(
  kind: "unresolved" | "missing-anchor",
  targetRaw: string,
): HTMLElement {
  const d = document.createElement("div");
  d.className = `cm-md-embed-placeholder cm-md-embed-placeholder-${kind}`;
  const msg =
    kind === "unresolved"
      ? `⚠ Couldn't resolve [[${targetRaw}]]`
      : `⚠ Anchor not found in [[${targetRaw}]]`;
  d.textContent = msg;
  return d;
}
```

- [ ] **Step 4: Run the tests, verify pass**

Run: `cd ui && npx vitest run src/editor/embedRender.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/editor/embedRender.ts ui/src/editor/embedRender.test.ts
git commit -m "feat(l3): pure DOM renderer for embed widget body

renderEmbedBody handles five branches: cycle, depth, cold-cache,
unresolved/missing-anchor, resolved. Resolved branch renders content
as preserved-newline text and recursively walks nested ![[…]] via
scanWikilinks, threading a chain of resolved paths. Non-embed wiki-links
inside the body stay as literal text (spec §2.8 only inlines embeds).

MAX_EMBED_DEPTH = 4 per document-model.md §5.4.

Part of L3 Session H.2."
```

---

### Task 3: CM6 extension (`ui/src/editor/embed.ts`)

**Files:**
- Create: `ui/src/editor/embed.ts`
- Create: `ui/src/editor/embed.test.ts`

This task wires the renderer into CodeMirror as a `StateField<DecorationSet>` that emits one block-widget decoration per `![[…]]` `WikiLink` Lezer node, attached at the **end of the line** containing the token, side `1` (after the line). The widget's `toDOM()` builds a wrapper `<div class="cm-md-embed-frame">` and appends `renderEmbedBody(...)`.

The field rebuilds when:
1. The doc changes.
2. The Lezer tree changes (async parse completion).
3. The `embedResolverFacet` value changes (vault swap → handled by `Compartment` reconfigure).
4. The `openNotePathFacet` value changes.
5. An `embedResolverUpdated` `StateEffect` lands (cache changed → repaint).

- [ ] **Step 1: Write the failing extension tests**

Create `ui/src/editor/embed.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";

import { wikilinkExtension } from "./wikilink";
import {
  embedExtension,
  embedResolverFacet,
  openNotePathFacet,
  embedResolverUpdated,
} from "./embed";
import type { EmbedResolver, EmbedResolution } from "./embedResolver";

function stubResolver(entries: Record<string, EmbedResolution>): EmbedResolver {
  return {
    get: (t) => entries[t],
    fetch: () => undefined,
    resolve: () => Promise.reject(new Error("not used")),
    invalidate: () => undefined,
    onUpdate: () => () => undefined,
  };
}

function makeView(doc: string, resolver: EmbedResolver | null): EditorView {
  const host = document.createElement("div");
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [wikilinkExtension] }),
        embedResolverFacet.of(resolver),
        openNotePathFacet.of(null),
        embedExtension,
      ],
    }),
  });
  return view;
}

function widgetCount(view: EditorView): number {
  let n = 0;
  view.contentDOM
    .querySelectorAll(".cm-md-embed-frame")
    .forEach(() => {
      n++;
    });
  return n;
}

describe("embedExtension", () => {
  it("emits no widget when the doc has no ![[…]]", () => {
    const r = stubResolver({});
    const view = makeView("plain text\n", r);
    expect(widgetCount(view)).toBe(0);
    view.destroy();
  });

  it("emits a widget for an ![[…]] token", () => {
    const r = stubResolver({
      Daily: { kind: "note", target_path: "Daily.md", content: "hi" },
    });
    const view = makeView("see ![[Daily]] please\n", r);
    expect(widgetCount(view)).toBe(1);
    view.destroy();
  });

  it("does not emit a widget for a plain [[…]] token (no embed flag)", () => {
    const r = stubResolver({});
    const view = makeView("see [[Daily]] please\n", r);
    expect(widgetCount(view)).toBe(0);
    view.destroy();
  });

  it("emits one widget per ![[…]] on a multi-embed line", () => {
    const r = stubResolver({
      A: { kind: "note", target_path: "A.md", content: "a" },
      B: { kind: "note", target_path: "B.md", content: "b" },
    });
    const view = makeView("![[A]] and ![[B]]\n", r);
    expect(widgetCount(view)).toBe(2);
    view.destroy();
  });

  it("rebuilds on embedResolverUpdated effect (no doc change)", () => {
    // Cold cache first — widget renders a Loading placeholder.
    const entries: Record<string, EmbedResolution> = {};
    const r: EmbedResolver = {
      get: (t) => entries[t],
      fetch: () => undefined,
      resolve: () => Promise.reject(new Error("not used")),
      invalidate: () => undefined,
      onUpdate: () => () => undefined,
    };
    const view = makeView("![[Daily]]\n", r);
    expect(
      view.contentDOM.querySelector(".cm-md-embed-loading"),
    ).not.toBeNull();

    // Populate the cache and fire the effect — widget should repaint
    // to the resolved body.
    entries.Daily = {
      kind: "note",
      target_path: "Daily.md",
      content: "hi",
    };
    view.dispatch({ effects: embedResolverUpdated.of(null) });
    expect(view.contentDOM.querySelector(".cm-md-embed-body")).not.toBeNull();
    expect(view.contentDOM.querySelector(".cm-md-embed-loading")).toBeNull();
    view.destroy();
  });

  it("renders a cycle link when openNotePathFacet matches the embed target", () => {
    const r = stubResolver({
      Self: { kind: "note", target_path: "Self.md", content: "x" },
    });
    const host = document.createElement("div");
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "![[Self]]\n",
        extensions: [
          markdown({ extensions: [wikilinkExtension] }),
          embedResolverFacet.of(r),
          openNotePathFacet.of("Self.md"),
          embedExtension,
        ],
      }),
    });
    expect(
      view.contentDOM.querySelector(".cm-md-embed-link-cycle"),
    ).not.toBeNull();
    view.destroy();
  });

  // Sanity that the markdown grammar + wikilink extension still parses
  // an embed token as a WikiLink node — guards against an upstream
  // regression that would silently hide the widget.
  it("parses ![[…]] as a single WikiLink node", () => {
    const view = makeView("![[Daily]]\n", null);
    const tree = syntaxTree(view.state);
    let found = 0;
    tree.iterate({
      enter: (node) => {
        if (node.name === "WikiLink") found++;
      },
    });
    expect(found).toBe(1);
    view.destroy();
  });
});
```

- [ ] **Step 2: Run the tests, verify failure**

Run: `cd ui && npx vitest run src/editor/embed.test.ts`
Expected: FAIL — module `./embed` does not exist.

- [ ] **Step 3: Implement the extension**

Create `ui/src/editor/embed.ts`:

```typescript
/**
 * Live-Preview embed widget (L3 Session H.2, spec §2.8).
 *
 * Walks the Lezer tree for every `WikiLink` node whose raw source is an
 * embed token (`![[…]]`) and emits one block-widget decoration per
 * token, attached at the end of the token's *line* with `side: 1`. The
 * widget mounts a frame and asks `renderEmbedBody` to fill it.
 *
 * Block decorations can only come from a `StateField` (CM6 forbids
 * them in `ViewPlugin`s). The field rebuilds on doc / tree changes
 * and on the `embedResolverUpdated` `StateEffect` — that effect is
 * dispatched by `Editor.tsx`'s `onUpdate` subscription whenever the
 * `EmbedResolver` cache changes (fetch completion or `invalidate()`).
 *
 * Resolver and open-note-path live in Facets so a vault swap (handled
 * by `Compartment.reconfigure` in `Editor.tsx`) flows the new resolver
 * and seed-chain entry to the widget without rebuilding the editor.
 *
 * The inline `mark-wikilink-embed` `⎘` glyph in `decorations.ts` is
 * unchanged — it stays as a marker on the source token; this widget
 * adds the *content* below.
 */

import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  Facet,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { scanWikilinks } from "../ast/wikilink";
import type { EmbedResolver } from "./embedResolver";
import { renderEmbedBody } from "./embedRender";

/**
 * Per-editor embed resolver supplied via {@link embedResolverFacet}.
 * `null` when no vault is open — the field emits no widgets in that
 * case (rather than rendering a forest of loading placeholders).
 */
export const embedResolverFacet = Facet.define<
  EmbedResolver | null,
  EmbedResolver | null
>({
  combine: (values) => values[0] ?? null,
});

/**
 * Open-note absolute vault-relative path (e.g. `notes/Daily.md`), so
 * the renderer can seed the cycle chain with the host note. `null`
 * when no note is selected (top-level embeds still render; only
 * self-embeds inside the open note rely on this seed).
 */
export const openNotePathFacet = Facet.define<string | null, string | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * StateEffect dispatched by `Editor.tsx` whenever the resolver's cache
 * changes. The StateField watches transactions for this effect and
 * rebuilds.
 */
export const embedResolverUpdated = StateEffect.define<null>();

/** Reconstruct the wiki-link `target_raw` cache key from a tokenized run. */
function targetRawOf(
  tok: Extract<ReturnType<typeof scanWikilinks>[number], { kind: "wiki_link" }>,
): string {
  if (tok.anchor === null) return tok.target;
  const prefix = tok.anchor.kind === "block" ? "#^" : "#";
  return `${tok.target}${prefix}${tok.anchor.value}`;
}

class EmbedBlockWidget extends WidgetType {
  constructor(
    private readonly resolver: EmbedResolver,
    private readonly targetRaw: string,
    private readonly openNotePath: string | null,
    // Carried for `eq()` cheap identity — the field tears down widgets
    // and reconstructs on resolver-cache changes, so we don't need
    // value comparison beyond identity + targetRaw.
    private readonly stamp: number,
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const frame = document.createElement("div");
    frame.className = "cm-md-embed-frame";
    const seedChain = this.openNotePath === null ? [] : [this.openNotePath];
    frame.appendChild(
      renderEmbedBody({
        resolver: this.resolver,
        targetRaw: this.targetRaw,
        chain: seedChain,
      }),
    );
    return frame;
  }

  override eq(other: EmbedBlockWidget): boolean {
    return (
      this.targetRaw === other.targetRaw &&
      this.openNotePath === other.openNotePath &&
      this.stamp === other.stamp
    );
  }

  override get estimatedHeight(): number {
    // Best-effort guess so CM6's scroll calculations don't thrash; the
    // widget rerenders on resolver updates and CM6 will measure for
    // real on layout.
    return 60;
  }

  override ignoreEvent(): boolean {
    // The widget is read-only — let clicks / keystrokes pass through to
    // CM6's host (no internal interactivity in H.2).
    return false;
  }
}

function buildDecorations(state: import("@codemirror/state").EditorState, stamp: number): DecorationSet {
  const resolver = state.facet(embedResolverFacet);
  if (!resolver) return Decoration.none;
  const openNotePath = state.facet(openNotePathFacet);
  const tree = syntaxTree(state);
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name !== "WikiLink") return;
      const raw = doc.sliceString(node.from, node.to);
      const tok = scanWikilinks(raw).find((t) => t.kind === "wiki_link");
      if (!tok || tok.kind !== "wiki_link" || !tok.embed) return;
      const line = doc.lineAt(node.from);
      const widget = new EmbedBlockWidget(
        resolver,
        targetRawOf(tok),
        openNotePath,
        stamp,
      );
      ranges.push(
        Decoration.widget({
          widget,
          block: true,
          side: 1,
        }).range(line.to),
      );
    },
  });

  // CM6 requires the range set sorted by `from`, then by side.
  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

/**
 * The field-managed decoration set. Rebuilds on:
 *   - doc changes (text edits)
 *   - tree changes (async Lezer parse completion)
 *   - the `embedResolverUpdated` effect (cache mutated)
 *   - any facet change reaching it (vault swap via Compartment)
 *
 * The `stamp` counter forces widget identity to flip on each rebuild,
 * which makes CM6 tear down and recreate the DOM — the cleanest way to
 * pick up resolver updates without diffing widget innards.
 */
const embedBlockField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state, 0),
  update: (deco, tr) => {
    const resolverChanged = tr.effects.some((e) => e.is(embedResolverUpdated));
    const treeChanged =
      syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const facetChanged =
      tr.startState.facet(embedResolverFacet) !==
        tr.state.facet(embedResolverFacet) ||
      tr.startState.facet(openNotePathFacet) !==
        tr.state.facet(openNotePathFacet);
    if (
      !tr.docChanged &&
      !treeChanged &&
      !resolverChanged &&
      !facetChanged
    ) {
      return deco;
    }
    return buildDecorations(tr.state, Date.now());
  },
  provide: (f) => EditorView.decorations.from(f),
});

const embedBaseTheme = EditorView.baseTheme({
  ".cm-md-embed-frame": {
    margin: "var(--space-2) 0",
    padding: "var(--space-2) var(--space-3)",
    borderLeft: "var(--space-1) solid var(--c-accent)",
    background: "var(--c-bg-secondary)",
    borderRadius: "var(--radius-sm)",
    fontSize: "0.95em",
  },
  ".cm-md-embed-body": {
    whiteSpace: "pre-wrap",
    color: "var(--c-fg-secondary)",
  },
  ".cm-md-embed-placeholder": {
    color: "var(--c-fg-muted)",
    fontStyle: "italic",
  },
  ".cm-md-embed-placeholder-unresolved, .cm-md-embed-placeholder-missing-anchor":
    {
      color: "var(--c-warning, var(--c-fg-muted))",
    },
  ".cm-md-embed-loading": {
    color: "var(--c-fg-muted)",
    fontStyle: "italic",
  },
  ".cm-md-embed-link": {
    color: "var(--c-accent)",
    textDecoration: "underline dashed",
  },
});

export const embedExtension: Extension = [embedBlockField, embedBaseTheme];
```

- [ ] **Step 4: Run the tests, verify pass**

Run: `cd ui && npx vitest run src/editor/embed.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Full TS test + typecheck**

Run: `cd ui && npx vitest run && npx tsc --noEmit`
Expected: every test + tsc clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/editor/embed.ts ui/src/editor/embed.test.ts
git commit -m "feat(l3): CM6 embed-widget extension

Block-widget StateField that emits one widget per ![[…]] WikiLink Lezer
node, attached at line end with side: 1. Widget hosts renderEmbedBody.
Rebuilds on doc/tree/facet changes and on embedResolverUpdated effect.

embedResolverFacet flows the per-vault resolver; openNotePathFacet seeds
the cycle chain. embedBaseTheme styles the frame, body, placeholders,
and depth/cycle links via design tokens.

Part of L3 Session H.2."
```

---

### Task 4: Editor.tsx wiring

**Files:**
- Modify: `ui/src/Editor.tsx`

Add `embedResolver` + `openNotePath` props, two new Compartments (one per facet), an `onUpdate` subscription that dispatches `embedResolverUpdated` into the view, the new extensions in the `EditorState.extensions` list, and the two reactive prop-swap `createEffect`s.

- [ ] **Step 1: Add the imports**

Open `ui/src/Editor.tsx`. After the existing wikilink-related imports (around line 29), add:

```typescript
import type { EmbedResolver } from "./editor/embedResolver";
import {
  embedExtension,
  embedResolverFacet,
  embedResolverUpdated,
  openNotePathFacet,
} from "./editor/embed";
```

- [ ] **Step 2: Add two Compartments**

After the existing `wikilinkResolverCompartment` declaration (around line 64), add:

```typescript
/**
 * Holds the per-editor embed resolver supplied to the embed widget via
 * {@link embedResolverFacet}. Reconfigured whenever the parent's
 * `embedResolver` prop changes.
 */
const embedResolverCompartment = new Compartment();

/**
 * Holds the open-note vault-relative path supplied to the embed widget
 * via {@link openNotePathFacet}. Reconfigured whenever the parent's
 * `openNotePath` prop changes — used to seed the cycle chain.
 */
const openNotePathCompartment = new Compartment();
```

- [ ] **Step 3: Extend `EditorProps`**

In the `EditorProps` interface, alongside `wikilinkResolver`, add:

```typescript
/**
 * Per-vault resolver for embed content (L3 Session H.2). `null` when
 * no vault is open — the embed widget renders nothing in that state.
 */
embedResolver?: EmbedResolver | null;

/**
 * Vault-relative path of the currently open note (e.g. `notes/Daily.md`),
 * supplied so the embed widget can seed its cycle-detection chain. `null`
 * when no note is selected.
 */
openNotePath?: string | null;
```

- [ ] **Step 4: Add an `unsubEmbedResolver` handle + `subscribeEmbedResolver`**

After the existing `subscribeResolver` helper (around line 232), add:

```typescript
  // Unsubscribe handle for the embed resolver's onUpdate notifications.
  let unsubEmbedResolver: (() => void) | undefined;

  const subscribeEmbedResolver = (
    resolver: EmbedResolver | null | undefined,
    targetView: EditorView | undefined,
  ) => {
    unsubEmbedResolver?.();
    unsubEmbedResolver = undefined;
    if (resolver && targetView) {
      unsubEmbedResolver = resolver.onUpdate(() => {
        targetView.dispatch({ effects: embedResolverUpdated.of(null) });
      });
    }
  };
```

- [ ] **Step 5: Install the new extensions and seed compartments**

Inside the `EditorView`'s `EditorState.create({ extensions: [...] })` array, after the existing `wikilinkResolverCompartment.of(...)` line (around line 351-353), add:

```typescript
          embedResolverCompartment.of(
            embedResolverFacet.of(props.embedResolver ?? null),
          ),
          openNotePathCompartment.of(
            openNotePathFacet.of(props.openNotePath ?? null),
          ),
          embedExtension,
```

- [ ] **Step 6: Subscribe to the embed resolver on mount**

After the existing `subscribeResolver(props.wikilinkResolver, view);` call (around line 421), add:

```typescript
    subscribeEmbedResolver(props.embedResolver, view);
```

- [ ] **Step 7: Add the swap-on-prop-change createEffects**

After the existing `wikilinkResolver` `createEffect` (around line 530-543), add:

```typescript
  // Swap the embed resolver when the parent's prop changes (a different
  // vault is open). Reconfigure the facet via the compartment and
  // re-bind the onUpdate subscription so cache notifications dispatch
  // into the right view.
  createEffect(
    on(
      () => props.embedResolver,
      (resolver) => {
        view?.dispatch({
          effects: embedResolverCompartment.reconfigure(
            embedResolverFacet.of(resolver ?? null),
          ),
        });
        subscribeEmbedResolver(resolver, view);
      },
      { defer: true },
    ),
  );

  // Swap the open-note path facet when the parent's prop changes. The
  // embed widget reads this as the seed of its cycle-detection chain;
  // every navigation between notes flips the value.
  createEffect(
    on(
      () => props.openNotePath,
      (path) => {
        view?.dispatch({
          effects: openNotePathCompartment.reconfigure(
            openNotePathFacet.of(path ?? null),
          ),
        });
      },
      { defer: true },
    ),
  );
```

- [ ] **Step 8: Unsubscribe in onCleanup**

In the existing `onCleanup` (around line 562-567), add `unsubEmbedResolver?.();` next to the existing `unsubResolver?.();`:

```typescript
  onCleanup(() => {
    unsubResolver?.();
    unsubEmbedResolver?.();
    if (astPending !== undefined) clearTimeout(astPending);
    view?.destroy();
    view = undefined;
  });
```

- [ ] **Step 9: Typecheck + run tests**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add ui/src/Editor.tsx
git commit -m "feat(l3): wire embed resolver + openNotePath through Editor

Two new props (embedResolver, openNotePath), two new Compartments, an
onUpdate subscription dispatching embedResolverUpdated, and reactive
prop-swap createEffects. Mirrors the L3 Session B wikilink-resolver
wiring so the lifecycles are symmetrical.

Part of L3 Session H.2."
```

---

### Task 5: App.tsx wiring

**Files:**
- Modify: `ui/src/App.tsx`

Own one `EmbedResolver` per open vault; reset on close; invalidate on `vault:file-changed`; pass to `<Editor />` along with `selectedPath()` as `openNotePath`.

- [ ] **Step 1: Add the import**

After the existing wikilinkResolver import (around line 37), add:

```typescript
import {
  createEmbedResolver,
  type EmbedResolver,
} from "./editor/embedResolver";
```

- [ ] **Step 2: Add the signal**

After the existing `wikilinkResolver` signal declaration (around line 170-172), add:

```typescript
  // L3 Session H.2 — per-vault embed resolver (mirrors wikilinkResolver
  // lifecycle). Created in `handleOpen`, cleared in close, invalidated
  // on every `vault:file-changed` so a freshly-resolvable embed flips
  // from "Couldn't resolve" to its content without a reload.
  const [embedResolver, setEmbedResolver] =
    createSignal<EmbedResolver | null>(null);
```

- [ ] **Step 3: Invalidate on vault:file-changed**

Next to the existing `wikilinkResolver()?.invalidate();` call in the `onVaultFileChanged` listener (around line 668), add:

```typescript
      // L3 Session H.2: any vault file change may have altered embed
      // targets or their contents. Drop the resolver cache so the next
      // widget rebuild re-fetches.
      embedResolver()?.invalidate();
```

- [ ] **Step 4: Reset on vault close**

Next to the existing `setWikilinkResolver(null);` line (around line 788), add:

```typescript
      setEmbedResolver(null);
```

- [ ] **Step 5: Create on vault open**

Next to the existing `setWikilinkResolver(createWikiLinkResolver(resp.vault_id));` line (around line 797), add:

```typescript
      setEmbedResolver(createEmbedResolver(resp.vault_id));
```

- [ ] **Step 6: Pass to `<Editor />`**

Find the `<Editor>` element (the only one — search for `wikilinkResolver={wikilinkResolver()}`). Add the two new props alongside it:

```typescript
            wikilinkResolver={wikilinkResolver()}
            embedResolver={embedResolver()}
            openNotePath={selectedPath()}
```

- [ ] **Step 7: Typecheck + run tests**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: clean.

- [ ] **Step 8: Build + lint**

Run: `cd ui && npm run build`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(l3): own per-vault embed resolver; pass openNotePath to Editor

Mirrors wikilinkResolver lifecycle: created in handleOpen, reset on
close, invalidated on every vault:file-changed event. selectedPath()
flows through as openNotePath so the widget seeds its cycle chain
with the host note.

Part of L3 Session H.2."
```

---

### Task 6: Full verification

- [ ] **Step 1: Full Rust + TS sweep**

Run:
```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cd ui && npx tsc --noEmit && npx vitest run && npm run build
```

Expected: every command clean. Rust counts unchanged from L3 §9.12 (289). Vitest count = 293 (Session §9.12 baseline) + 6 (embedResolver) + 11 (embedRender) + 7 (embed) = **317 passing**.

- [ ] **Step 2: Status check**

Run: `git status && git log --oneline main..HEAD`
Expected: 5 commits on `l3-session-h2-embed-widget`, working tree clean.

---

### Task 7: Docs

**Files:**
- Modify: `docs/layer-3-spec.md` — append §9.13.
- Modify: `CLAUDE.md` — rewrite the Project state block.

- [ ] **Step 1: Append §9.13 to `docs/layer-3-spec.md`**

After the last line of §9.12 (`What's left for L3.` paragraph), append:

```markdown

### 9.13 Session H.2 — Embed widget

**Done 2026-05-30.** Frontend half of Session H (spec §2.8): every `![[…]]` token in Live Preview renders a block widget below its line carrying the embedded content, with bounded recursion (max depth 4 per `document-model.md` §5.4), cycle detection, and styled placeholders for unresolved targets and missing anchors. Executed from the plan at `docs/superpowers/plans/2026-05-30-l3-session-h2-embed-widget.md`.

**Resolver (`ui/src/editor/embedResolver.ts`).** `EmbedResolver` mirrors `WikiLinkResolver` (L3 Session B) verbatim — `get` / `fetch` / `resolve` / `invalidate` / `onUpdate`, cache key = `target_raw`, IPC stub injected for tests, failures cache an `{ kind: "unresolved", target_path: null, content: null }` entry. 6 unit tests.

**Pure renderer (`ui/src/editor/embedRender.ts`).** `renderEmbedBody(ctx)` returns a `DocumentFragment` for one embed token; five branches — depth-cap (chain.length ≥ 4) → styled depth link, cold cache → "Loading…" + `resolver.fetch`, unresolved/missing-anchor → ⚠ placeholder, cycle (resolved `target_path ∈ chain`) → styled cycle link, resolved (note/section/block) → preserved-newline plain text. Nested `![[…]]` in content are recognised via `scanWikilinks` (L1 tokenizer) and recursively rendered, threading `[...chain, here.target_path]`. Non-embed `[[…]]` inside an embed body stays as literal source. **No markdown formatting inside the body** — H.3 polish. `MAX_EMBED_DEPTH = 4`. 11 unit tests against jsdom.

**CM6 extension (`ui/src/editor/embed.ts`).** `embedExtension = [embedBlockField, embedBaseTheme]`. `embedBlockField` is a `StateField<DecorationSet>` (block decorations cannot come from a `ViewPlugin`) that walks the Lezer tree for every `WikiLink` node, re-tokenises its raw source, and — only for `![[…]]` — emits one `Decoration.widget({ block: true, side: 1 })` at the token's line end. The widget's `toDOM()` mounts a `.cm-md-embed-frame` wrapper and appends `renderEmbedBody(...)`. Rebuilds on doc / tree / facet changes and on the `embedResolverUpdated` `StateEffect`. The `stamp` counter (set to `Date.now()` on each build) makes widget identity flip on rebuild so CM6 tears down and recreates the DOM — the cleanest way to pick up resolver-cache updates. `embedResolverFacet` flows the per-vault resolver; `openNotePathFacet` seeds the cycle chain. 7 integration tests against real `EditorView`s.

**Editor + App wiring.** `Editor` gains two props (`embedResolver?`, `openNotePath?`), two `Compartment`s (one per facet), an `onUpdate` subscription dispatching `embedResolverUpdated`, and reactive prop-swap `createEffect`s. `App` owns one `EmbedResolver` per open vault (`createEmbedResolver(vault_id)` on open, `null` on close, `.invalidate()` on every `vault:file-changed`), and feeds `selectedPath()` straight through as `openNotePath`. Mirrors the L3 Session B `WikiLinkResolver` lifecycle so the two surfaces stay symmetrical.

**Decisions worth noting.**
- *Block widget, not text replacement.* The `![[…]]` source line stays editable; the widget appears *below* it. The existing inline `mark-wikilink-embed` `⎘` glyph in `decorations.ts` (L3 Session B) is unchanged — it stays as a marker on the source. H.3 can decide whether to retire the glyph once the block widget is fully featured.
- *Plain text, not markdown rendering, inside the body.* Spec §9.13 deferred markdown formatting to H.3. The body uses `white-space: pre-wrap` so newlines + spacing land faithfully.
- *Recursive rendering through `renderEmbedBody`, not nested CM6 widgets.* The widget builds plain DOM; nested embeds are recursive calls within the same DocumentFragment. Cleaner than mounting CM6 inside CM6 and trivially testable in jsdom.
- *Cycle = resolved `target_path` ∈ chain.* The chain stores resolved paths, not `target_raw`. This catches `[[Daily]]` ≡ `[[notes/Daily]]` referring to the same file with different surface forms.
- *Seed chain = open note's path.* `App.tsx` passes `selectedPath()` so `![[OpenNote]]` inside itself renders as a cycle link, not as an empty-content render.
- *Hard-coded `MAX_EMBED_DEPTH = 4`.* `document-model.md` §5.4 names 4 as the default; exposing this as a setting can land alongside `editor.embed_max_depth` when a setting surface needs it.
- *`stamp` for rebuild identity.* Cheaper and less error-prone than diffing the resolver cache into widget state. CM6 measures + remounts on widget identity change.
- *Failures cache as unresolved.* Same policy as `WikiLinkResolver`. Spec §2.8 doesn't distinguish "IPC died" from "file missing" — both render the unresolved placeholder.

**Tests:** 289 Rust passing (unchanged — no Rust gap this session). 317 vitest passing (was 293 + 24 new: 6 embedResolver + 11 embedRender + 7 embed). `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`, `npx tsc --noEmit`, `npx vitest run`, `npm run build` all clean.

**Smoke status.** Interactive `cargo tauri dev` not run (automated-context constraint). Pure logic fully unit-tested end-to-end (resolver, renderer, extension). Smoke vault for next hands-on session:

```
Daily.md:
# Intro
This is the intro.
# Body
Body text.
^abc123

Outer.md:
top-of-outer
![[Daily]]
between
![[Daily#Intro]]
between
![[Daily#^abc123]]
between
![[Ghost]]

Cycle.md:
self-referencing: ![[Cycle]]

Chain.md:
![[ChainB]]
ChainB.md: ![[ChainC]]
ChainC.md: ![[ChainD]]
ChainD.md: ![[ChainE]]  ← depth-cap kicks in
ChainE.md: end
```

Verify in `Outer.md`: full-note embed renders Daily's full content (minus frontmatter — H.1 strips it); section embed renders just `# Intro` body; block embed renders just the line carrying `^abc123`; `![[Ghost]]` renders the warning placeholder; `![[Daily#Missing]]` renders the missing-anchor placeholder. In `Cycle.md`, the embed renders as a styled cycle link. In the `Chain*` files, depth-5 (E) renders as a styled depth link.

**What's left for L3.** Sessions I–K — unlinked mentions, pending-rewrites cache, closeout. H.3 (rich markdown rendering inside the body, click navigation, optional `⎘`-indicator retirement) is **deferred polish** — not on the §2.8 DoD critical path.
```

- [ ] **Step 2: Rewrite `CLAUDE.md` Project state**

Replace the `## Project state` block in `CLAUDE.md` with (use Edit, matching the existing block exactly):

```markdown
## Project state

Current layer: 3 — Knowledge Graph (Sessions A–F done + scan perf fix + Session G full + `[[#^` block-id autocomplete + Sessions H.1 + H.2 done; Sessions I–K pending). Frontend embeds (branch `l3-session-h2-embed-widget`, spec §9.13): every `![[…]]` in Live Preview renders a block widget below its source line via a CM6 `StateField<DecorationSet>` (block decorations can't come from a `ViewPlugin`). `EmbedResolver` (`ui/src/editor/embedResolver.ts`) mirrors `WikiLinkResolver` shape over the H.1 `get_embed` IPC — `get`/`fetch`/`resolve`/`invalidate`/`onUpdate`, cache keyed on `target_raw`, failures cache as `unresolved`. Pure `renderEmbedBody` (`ui/src/editor/embedRender.ts`) returns a `DocumentFragment` covering five branches: depth-cap (`chain.length ≥ MAX_EMBED_DEPTH=4`) → styled link, cold cache → "Loading…" + `fetch`, `unresolved`/`missing-anchor` → ⚠ placeholder, cycle (`resolved target_path ∈ chain`) → styled link, resolved → preserved-newline plain text with nested `![[…]]` recursively rendered (via `scanWikilinks`) threading `[...chain, here.target_path]`. Non-embed `[[…]]` inside a body stays as literal source. **No markdown formatting inside the body** — H.3 polish. `embed.ts` extension: `embedResolverFacet` (per-vault resolver) + `openNotePathFacet` (seeds the cycle chain with the host note) + `embedResolverUpdated` `StateEffect` (dispatched on every `EmbedResolver.onUpdate`); the field rebuilds on doc/tree/facet changes and on the effect, with a `stamp = Date.now()` to flip widget identity so CM6 remounts the DOM on resolver updates. `Editor` gains `embedResolver?` + `openNotePath?` props, two `Compartment`s, an `onUpdate` subscription, and swap-on-prop-change `createEffect`s. `App` owns one `EmbedResolver` per vault (created in `handleOpen`, cleared in close, invalidated on every `vault:file-changed`), passing `selectedPath()` straight through as `openNotePath`. The inline `mark-wikilink-embed` `⎘` glyph (L3 Session B) is **unchanged** — it stays as a marker on the source; the block widget renders the content below.
Earlier L3: Backend block-refs (`l3-session-g-block-references`, spec §9.8) — `create_block_ref` is the **only** path that writes `^block-id`; deterministic id `b`+sha256(path:position)[..6]; migration 005 adds `blocks(file_path, block_id, position_hint, last_modified)` + `block_refs(source_file_path, target_file_path, target_block_id)` both CASCADE on `files(path)`; `HIGHEST_KNOWN_VERSION=5`. `cubical-core::vault::blocks` (`extract_block_ids` + `refresh_blocks` + `refresh_block_refs_for_file`); `cubical-index::blocks` query module; `cubical-app::commands::blocks` (`create_block_ref` + `get_broken_block_refs`). Scanner grammar (`is_valid_block_id`) ↔ minter grammar (`is_valid_id`) ↔ frontend `TRAILING_BLOCK_ID` regex **must stay in lockstep**. Frontend gesture + decoration + status bar (§9.9 + §9.10) — `Cmd/Ctrl+Shift+B` copies `[[path#^id]]`, `^id` decoration via `findBlockIds`, broken-ref status-bar item via pure `formatBrokenBlockRefs`. `[[#^` block-id autocomplete (§9.11) via `block_id_autocomplete` + `detectBlockTrigger` + `blockCompletionSource`. Session H.1 (`l3-session-h1-embed-extractor`, §9.12) — pure `cubical-core::vault::embeds::{extract_section, extract_block, strip_frontmatter, slugify}` + `commands::embeds::get_embed` orchestrator; `EmbedKind` enum kebab-case (`note`/`section`/`block`/`unresolved`/`missing-anchor`); `ipc.ts` `getEmbed` binding.
Tests: 289 Rust + 317 vitest (+24 since H.1: 6 `embedResolver` + 11 `embedRender` + 7 `embed`). L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: Sessions I–K — unlinked mentions (I), pending-rewrites cache (J), closeout (K). H.3 (rich markdown rendering inside the embed body + click navigation + `⎘`-indicator retirement) is **deferred polish** — not on the §2.8 DoD critical path. Smoke still pending hands-on (automated-context constraint): in a vault with `Daily.md` (`# Intro` + body + `^abc123`) and `Outer.md` containing `![[Daily]]`, `![[Daily#Intro]]`, `![[Daily#^abc123]]`, `![[Ghost]]`, `![[Daily#Missing]]`, and `![[Cycle]]` (self-referencing) — verify each form renders its expected branch (full body / section slice / single line / unresolved placeholder / missing-anchor placeholder / cycle link). Plus a 5-deep chain `ChainA → … → ChainE` to verify depth-cap renders ChainE as a styled depth link. All fully unit/integration-tested.
```

- [ ] **Step 3: Verify the file edits**

Run: `git diff --stat docs/layer-3-spec.md CLAUDE.md`
Expected: both files show modifications.

- [ ] **Step 4: Commit the docs**

```bash
git add docs/layer-3-spec.md CLAUDE.md
git commit -m "docs(l3): close Session H.2 — spec §9.13 + state rewrite

Layer 3 spec §9.13 records the embed widget: resolver mirroring the
WikiLinkResolver, pure DOM renderer with five branches, CM6 block-widget
StateField, Editor/App wiring. CLAUDE.md Project state rewritten to
reflect H.2 done; Sessions I–K remain.

Closes L3 Session H.2."
```

---

### Task 8: Hand off to finishing-a-development-branch

- [ ] **Step 1:** Announce: "I'm using the finishing-a-development-branch skill to complete this work."
- [ ] **Step 2:** Invoke `superpowers:finishing-a-development-branch`. Follow that skill to verify tests, present options, execute choice.
