> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session B — Wiki-link Live Preview + click-to-navigate

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decorate every wiki-link shape in Live Preview (off-cursor: brackets/anchor/display markup hidden, visible text rendered as an accent link; on-cursor: raw `[[…]]` revealed; embeds get an indicator; unresolved targets get a warning style). A click on a resolved link opens the target file (and scrolls to the heading anchor if present). A click on an unresolved link offers to create the note at the resolved-by-convention path. The raw-source toggle still reveals literal source for wiki-link spans.

**Architecture:** Wiki-links are not in the default Lezer markdown grammar. We install a small inline parser rule that emits a single `WikiLink` node spanning the whole `[[…]]` or `![[…]]` token. The decoration plugin walks that node, re-tokenises its body with the existing `scanWikilinks` helper to find the visible-text range, and emits hide / accent-mark / embed-indicator / warning-mark entries. Resolution status is supplied through a CodeMirror `Facet` backed by a per-vault `WikiLinkResolver` (an in-memory cache over the Session A `resolve_link` IPC; invalidated on `vault:file-changed`). Click routing is a pure function that consults the resolver and dispatches to `onNavigate` or `onOfferCreate` callbacks owned by `App.tsx`.

**Tech Stack:** TypeScript / Solid (`ui/src/editor/*`, `ui/src/App.tsx`); CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/lang-markdown`); Lezer (`@lezer/markdown`); Tauri 2 IPC via the `resolveLink` + `writeFileText` wrappers landed in earlier sessions.

---

## Spec references

- [`docs/layer-3-spec.md`](../../../layer-3-spec.md) §1 goal 2, §2.2 (Live Preview + navigation), §3.1 (`resolve_link`), §4 (frontend file map), §5 deviation #1 (parsing extends two parsers), §8 Session B, §9.1 (what Session A landed).
- [`docs/architecture/document-model.md`](../../../architecture/document-model.md) §5.2 (wiki-links) and §5.5 ("Editor decorations are a sanctioned exception" paragraph — the load-bearing licence for Live Preview reading Lezer directly).
- L2 Session E raw-source toggle: `ui/src/editor/rawSource.ts` + `ui/src/Editor.tsx`'s `decorationCompartment`.
- L1 parity contract: `crates/cubical-ast/tests/fixtures/parity.json` + `ui/src/ast/parity.test.ts` — Session B does **not** touch the normalizer or the parity fixtures. The editor's Lezer parser and the AST-side Lezer parser remain distinct (see §5.5 deviation already sanctioned in Session A); the editor extension installed here does not propagate to `ui/src/ast/normalize.ts`.

---

## File structure

**Create:**

```
ui/src/editor/wikilink.ts              # Lezer inline rule for [[…]] / ![[…]]
ui/src/editor/wikilink.test.ts         # vitest cases for the inline rule

ui/src/editor/wikilinkResolver.ts      # per-vault cache over resolveLink IPC
ui/src/editor/wikilinkResolver.test.ts # vitest cases for cache + invalidation

ui/src/editor/wikilinkClick.ts         # pure click router + create-path helper
ui/src/editor/wikilinkClick.test.ts    # vitest cases for the router
```

**Modify:**

```
ui/src/editor/decorations.ts           # consume WikiLink nodes; consult resolver Facet
ui/src/editor/decorations.test.ts      # add wiki-link decoration cases
ui/src/Editor.tsx                      # install wikilink extension; plumb Facet; click handler; scrollToHeading API
ui/src/App.tsx                         # own per-vault resolver; navigate; create-offer modal; vault:file-changed invalidation

docs/layer-3-spec.md                   # fill §9.2 at session close
CLAUDE.md                              # rewrite "Project state" at session close
```

**Untouched (explicit non-goals):**

```
ui/src/ast/normalize.ts                # parity is already green via the re-flatten workaround
crates/cubical-*/**                    # no Rust changes anticipated this session
```

---

## Decoration grammar (load-bearing)

The decoration plugin re-tokenises each `WikiLink` Lezer node with `scanWikilinks(rawText)` and takes the first (and only) `WikiLink` it yields. From the token it derives one **visible range** and zero-or-more **hide ranges**:

| Shape | Visible range | Hide ranges |
|---|---|---|
| `[[note]]` | `note` | `[[`, `]]` |
| `[[note\|display]]` | `display` | `[[note\|`, `]]` |
| `[[note#heading]]` | `note` | `[[`, `#heading]]` |
| `[[note#^id]]` | `note` | `[[`, `#^id]]` |
| `[[note#heading\|display]]` | `display` | `[[note#heading\|`, `]]` |
| `![[note]]` | `note` | `![[`, `]]` |
| `![[note#heading\|display]]` | `display` | `![[note#heading\|`, `]]` |

**Rule of thumb:** the visible range is `display` if present; else `target`. The hide ranges are everything else inside the `[[…]]` token plus the brackets and (for embeds) the leading `!`.

**Off-cursor line:** visible range gets `mark-wikilink` (resolved) or `mark-wikilink-unresolved` (target known-missing). Embeds add a one-character `mark-wikilink-embed` widget at the start of the token (a small icon glyph). Hide ranges get `hide`.

**On-cursor line:** all ranges (visible + would-be-hide) get `mark-marker-muted` instead — mirrors how `Emphasis`/`Link` reveal raw source on the active line. The resolved/unresolved warning style is suppressed on the active line (don't paint a warning under the cursor; the user is actively editing).

**Pending resolution:** while `resolveLink` is in flight, the decoration renders as resolved (`mark-wikilink`). When the IPC returns, the rebuild repaints unresolved targets with the warning style. Brief flicker; acceptable.

---

## Create-by-convention path (load-bearing)

For an unresolved click, the target string (post-tokenizer; no `[[]]`, no leading `!`, no anchor, no display) is converted to a vault-relative path:

- If the target ends in `.md`, use it as-is.
- Else, append `.md`.

Slashes within the target are preserved as path separators (`[[notes/sub/Idea]]` → `notes/sub/Idea.md`). A bare target without slashes lands at the vault root (`[[Idea]]` → `Idea.md`).

The anchor (if any) is preserved through navigation but does **not** affect the file path.

---

## Tasks

### Task 1: Lezer inline rule that emits `WikiLink` nodes

**Files:**
- Create: `ui/src/editor/wikilink.ts`
- Create: `ui/src/editor/wikilink.test.ts`

The rule emits a single `WikiLink` node spanning the whole `[[…]]` or `![[…]]` token. No sub-nodes — the decoration plugin slices the body itself via `scanWikilinks`. The rule runs *before* the default `Link` parser so `[[X]]` is no longer mis-parsed as a Lezer shortcut Link with empty `dest`.

- [ ] **Step 1: Write the failing test.**

```typescript
// ui/src/editor/wikilink.test.ts
import { describe, expect, it } from "vitest";
import { parser as baseParser } from "@lezer/markdown";

import { wikilinkExtension } from "./wikilink";

const parser = baseParser.configure([wikilinkExtension]);

function nodeNamesIn(src: string): string[] {
  const tree = parser.parse(src);
  const out: string[] = [];
  tree.iterate({
    enter: (node) => {
      out.push(node.name);
    },
  });
  return out;
}

function wikilinkRanges(src: string): Array<{ from: number; to: number; text: string }> {
  const tree = parser.parse(src);
  const ranges: Array<{ from: number; to: number; text: string }> = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === "WikiLink") {
        ranges.push({ from: node.from, to: node.to, text: src.slice(node.from, node.to) });
      }
    },
  });
  return ranges;
}

describe("wikilinkExtension", () => {
  it("emits a WikiLink node for [[note]]", () => {
    expect(wikilinkRanges("see [[note]] here")).toEqual([
      { from: 4, to: 12, text: "[[note]]" },
    ]);
  });

  it("emits a WikiLink node for ![[diagram]] including the leading !", () => {
    expect(wikilinkRanges("![[diagram]]")).toEqual([
      { from: 0, to: 12, text: "![[diagram]]" },
    ]);
  });

  it("emits a WikiLink node for [[note#heading|alt]]", () => {
    const src = "[[note#heading|alt]]";
    const ranges = wikilinkRanges(src);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.text).toBe(src);
  });

  it("does not emit WikiLink for unclosed [[", () => {
    expect(wikilinkRanges("text [[unclosed and more")).toEqual([]);
  });

  it("does not emit WikiLink for [[]] (empty target)", () => {
    expect(wikilinkRanges("[[]] noise")).toEqual([]);
  });

  it("prevents the default Lezer Link parser from claiming [[X]]", () => {
    // Without our rule, @lezer/markdown emits an empty-dest Link
    // node for [[X]]. With our rule running before Link, no Link
    // sub-node should appear inside the WikiLink span.
    const names = nodeNamesIn("[[note]]");
    expect(names).toContain("WikiLink");
    expect(names).not.toContain("Link");
  });

  it("recognises multiple wiki-links in one paragraph", () => {
    const ranges = wikilinkRanges("[[a]] and [[b]]");
    expect(ranges.map((r) => r.text)).toEqual(["[[a]]", "[[b]]"]);
  });
});
```

- [ ] **Step 2: Run the test, expect failure (module missing).**

```bash
cd ui && npx vitest run src/editor/wikilink.test.ts
```

Expected: FAIL — `Cannot find module './wikilink'`.

- [ ] **Step 3: Implement the Lezer inline rule.**

```typescript
// ui/src/editor/wikilink.ts
/**
 * Lezer inline parser for `[[…]]` and `![[…]]` wiki-link tokens
 * (L3 Session B, spec §2.2).
 *
 * Emits a single `WikiLink` node spanning the entire token. No
 * sub-nodes — the decoration plugin re-tokenises the body with
 * `scanWikilinks` from `ui/src/ast/wikilink.ts` to find the visible
 * range (display ?? target) and the hide ranges (everything else).
 *
 * Runs `before: "Link"` so the default Lezer shortcut-Link rule does
 * not claim `[[X]]` as a Link with empty `dest`. This is the editor's
 * counterpart to the L1 normalizer's "re-flatten empty-dest Link/Image"
 * workaround (Session A, spec §5 deviation #1): in the editor we have
 * the luxury of installing the rule directly; the normalizer stays
 * untouched so the cross-language parity contract is unaffected.
 */

import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";
import { styleTags } from "@lezer/highlight";

const CH_BANG = 33; // !
const CH_OPEN = 91; // [
const CH_CLOSE = 93; // ]
const CH_PIPE = 124; // |

/**
 * Parse a wiki-link starting at `pos` (where `cx.char(pos)` returned
 * `next`). Returns the position past the closing `]]`, or `-1` if no
 * wiki-link starts here.
 */
function parseWikiLink(cx: InlineContext, next: number, pos: number): number {
  let contentStart: number;
  if (next === CH_BANG && cx.char(pos + 1) === CH_OPEN && cx.char(pos + 2) === CH_OPEN) {
    contentStart = pos + 3;
  } else if (next === CH_OPEN && cx.char(pos + 1) === CH_OPEN) {
    contentStart = pos + 2;
  } else {
    return -1;
  }

  // Find the closing `]]`. Stay within the inline span (cx.end).
  let close = -1;
  for (let p = contentStart; p + 1 < cx.end; p++) {
    const c = cx.char(p);
    // `[[` cannot nest — bail if we see another `[[` first.
    if (c === CH_OPEN && cx.char(p + 1) === CH_OPEN) return -1;
    if (c === CH_CLOSE && cx.char(p + 1) === CH_CLOSE) {
      close = p;
      break;
    }
  }
  if (close < 0) return -1;

  // Reject empty target (matches scanWikilinks grammar — see
  // `ui/src/ast/wikilink.ts::parseBody`). Trim a target that may
  // include leading whitespace before `#` or `|`.
  const body = cx.slice(contentStart, close);
  const pipeIdx = body.indexOf("|");
  const headRaw = pipeIdx >= 0 ? body.slice(0, pipeIdx) : body;
  const hashIdx = headRaw.indexOf("#");
  const targetRaw = hashIdx >= 0 ? headRaw.slice(0, hashIdx) : headRaw;
  if (targetRaw.trim().length === 0) return -1;

  const tokenEnd = close + 2;
  return cx.addElement(cx.elt("WikiLink", pos, tokenEnd));
}

export const wikilinkExtension: MarkdownConfig = {
  defineNodes: [{ name: "WikiLink", style: t.link }],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== CH_OPEN && next !== CH_BANG) return -1;
        return parseWikiLink(cx, next, pos);
      },
    },
  ],
  props: [
    styleTags({
      WikiLink: t.link,
    }),
  ],
};
```

- [ ] **Step 4: Run the test, expect PASS.**

```bash
cd ui && npx vitest run src/editor/wikilink.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/editor/wikilink.ts ui/src/editor/wikilink.test.ts
git commit -m "feat(editor): Lezer inline rule for [[…]] / ![[…]] wiki-links"
```

---

### Task 2: Per-vault wiki-link resolver — cache + invalidation

**Files:**
- Create: `ui/src/editor/wikilinkResolver.ts`
- Create: `ui/src/editor/wikilinkResolver.test.ts`

A small object that owns a `Map<targetKey, WikiLinkResolution>` for one vault, fans out to the `resolveLink` IPC on demand, and notifies subscribers when the cache changes (a fetch completed or `invalidate()` was called). The decoration plugin subscribes and triggers a rebuild; the click handler reads from it synchronously.

`targetKey` is the wiki-link target as written, including any `#anchor` — this matches the input shape `resolveLink` accepts.

- [ ] **Step 1: Write the failing test.**

```typescript
// ui/src/editor/wikilinkResolver.test.ts
import { describe, expect, it, vi } from "vitest";

import { createWikiLinkResolver } from "./wikilinkResolver";
import type {
  ResolveLinkRequest,
  ResolveLinkResponse,
} from "../api/ipc";

function stubIpc(
  responses: Record<string, ResolveLinkResponse>,
): {
  fn: (req: ResolveLinkRequest) => Promise<ResolveLinkResponse>;
  calls: ResolveLinkRequest[];
} {
  const calls: ResolveLinkRequest[] = [];
  const fn = (req: ResolveLinkRequest): Promise<ResolveLinkResponse> => {
    calls.push(req);
    const resp = responses[req.target_raw];
    if (!resp) throw new Error(`no stub for ${req.target_raw}`);
    return Promise.resolve(resp);
  };
  return { fn, calls };
}

describe("createWikiLinkResolver", () => {
  it("returns undefined for a target not yet fetched", () => {
    const { fn } = stubIpc({});
    const r = createWikiLinkResolver("v1", fn);
    expect(r.get("note")).toBeUndefined();
  });

  it("fires the IPC on fetch and exposes the result via get", async () => {
    const { fn, calls } = stubIpc({
      note: { target_path: "note.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    r.fetch("note");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([{ vault_id: "v1", target_raw: "note" }]);
    expect(r.get("note")).toEqual({ target_path: "note.md", anchor: null });
  });

  it("dedupes concurrent fetches for the same target", async () => {
    const { fn, calls } = stubIpc({
      note: { target_path: "note.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    r.fetch("note");
    r.fetch("note");
    r.fetch("note");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it("notifies subscribers when a fetch completes", async () => {
    const { fn } = stubIpc({
      note: { target_path: "note.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    const onUpdate = vi.fn();
    r.onUpdate(onUpdate);
    r.fetch("note");
    await Promise.resolve();
    await Promise.resolve();
    expect(onUpdate).toHaveBeenCalled();
  });

  it("invalidate() clears the cache and notifies subscribers", async () => {
    const { fn } = stubIpc({
      note: { target_path: "note.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    r.fetch("note");
    await Promise.resolve();
    await Promise.resolve();
    expect(r.get("note")).toBeDefined();
    const onUpdate = vi.fn();
    r.onUpdate(onUpdate);
    r.invalidate();
    expect(r.get("note")).toBeUndefined();
    expect(onUpdate).toHaveBeenCalled();
  });

  it("unsubscribe handle stops further notifications", async () => {
    const { fn } = stubIpc({
      a: { target_path: "a.md", anchor: null },
      b: { target_path: "b.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    const onUpdate = vi.fn();
    const unsub = r.onUpdate(onUpdate);
    r.fetch("a");
    await Promise.resolve();
    await Promise.resolve();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    unsub();
    r.fetch("b");
    await Promise.resolve();
    await Promise.resolve();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("a fetch failure caches a null-target_path result (don't retry forever)", async () => {
    const failing = (_req: ResolveLinkRequest): Promise<ResolveLinkResponse> =>
      Promise.reject(new Error("boom"));
    const r = createWikiLinkResolver("v1", failing);
    r.fetch("note");
    await Promise.resolve();
    await Promise.resolve();
    expect(r.get("note")).toEqual({ target_path: null, anchor: null });
  });
});
```

- [ ] **Step 2: Run the test, expect failure (module missing).**

```bash
cd ui && npx vitest run src/editor/wikilinkResolver.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the resolver.**

```typescript
// ui/src/editor/wikilinkResolver.ts
/**
 * Per-vault wiki-link resolution cache (L3 Session B, spec §2.2).
 *
 * A small in-memory store over the L3 Session A `resolve_link` IPC.
 * Each editor session is given one resolver bound to the open vault;
 * the resolver caches answers keyed on the wiki-link target string (as
 * written in the source, including any `#anchor`), dedupes concurrent
 * fetches, and notifies subscribers when the cache changes.
 *
 * Subscribers are the decoration plugin (to trigger a rebuild when a
 * fetch completes or the cache is invalidated). The click handler
 * reads from the cache synchronously via `get()`.
 *
 * Failures cache a `{ target_path: null, anchor: null }` result so a
 * failing target does not re-enter the IPC on every rebuild. The cache
 * is fully cleared on `invalidate()` — called by `App.tsx` whenever a
 * `vault:file-changed` event lands so a freshly-created target flips
 * from "unresolved" to "resolved" without a reload.
 */

import {
  resolveLink as defaultResolveLink,
  type ResolveLinkRequest,
  type ResolveLinkResponse,
} from "../api/ipc";

export interface WikiLinkResolution {
  target_path: string | null;
  anchor: ResolveLinkResponse["anchor"];
}

export interface WikiLinkResolver {
  /** Sync lookup. Returns `undefined` for targets not yet fetched. */
  get(targetRaw: string): WikiLinkResolution | undefined;
  /** Kick off (or skip if already pending/cached) an async fetch. */
  fetch(targetRaw: string): void;
  /** Drop the entire cache and notify subscribers. */
  invalidate(): void;
  /** Subscribe to cache-change notifications. Returns unsubscribe. */
  onUpdate(handler: () => void): () => void;
}

/**
 * Build a resolver bound to one vault. `ipc` is injected so tests can
 * stub it; production callers pass `resolveLink` from `api/ipc.ts`.
 */
export function createWikiLinkResolver(
  vaultId: string,
  ipc: (req: ResolveLinkRequest) => Promise<ResolveLinkResponse> = defaultResolveLink,
): WikiLinkResolver {
  const cache = new Map<string, WikiLinkResolution>();
  const inFlight = new Set<string>();
  const subscribers = new Set<() => void>();

  const notify = () => {
    for (const fn of subscribers) fn();
  };

  return {
    get(targetRaw) {
      return cache.get(targetRaw);
    },
    fetch(targetRaw) {
      if (cache.has(targetRaw) || inFlight.has(targetRaw)) return;
      inFlight.add(targetRaw);
      ipc({ vault_id: vaultId, target_raw: targetRaw })
        .then((resp) => {
          cache.set(targetRaw, {
            target_path: resp.target_path,
            anchor: resp.anchor,
          });
        })
        .catch(() => {
          // Cache the failure as "unresolved" so we don't re-fire.
          cache.set(targetRaw, { target_path: null, anchor: null });
        })
        .finally(() => {
          inFlight.delete(targetRaw);
          notify();
        });
    },
    invalidate() {
      cache.clear();
      // Don't clear inFlight — those promises will overwrite stale
      // entries when they resolve, which is harmless.
      notify();
    },
    onUpdate(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}
```

- [ ] **Step 4: Run the test, expect PASS.**

```bash
cd ui && npx vitest run src/editor/wikilinkResolver.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/editor/wikilinkResolver.ts ui/src/editor/wikilinkResolver.test.ts
git commit -m "feat(editor): per-vault wiki-link resolution cache"
```

---

### Task 3: Pure click router + create-by-convention path

**Files:**
- Create: `ui/src/editor/wikilinkClick.ts`
- Create: `ui/src/editor/wikilinkClick.test.ts`

A pure function takes a wiki-link target (post-tokenizer), a resolver, and two callbacks. It returns a discriminator describing what it did so tests can assert without spying on the callbacks alone.

- [ ] **Step 1: Write the failing test.**

```typescript
// ui/src/editor/wikilinkClick.test.ts
import { describe, expect, it, vi } from "vitest";

import {
  createPathForTarget,
  handleWikiLinkClick,
  type WikiLinkClickResult,
} from "./wikilinkClick";
import type { WikiLinkResolver } from "./wikilinkResolver";

function resolverWith(
  entries: Record<string, { target_path: string | null; anchor: null } | undefined>,
): WikiLinkResolver {
  return {
    get: (k) => entries[k],
    fetch: () => {},
    invalidate: () => {},
    onUpdate: () => () => {},
  };
}

describe("createPathForTarget", () => {
  it("appends .md when missing", () => {
    expect(createPathForTarget("Note")).toBe("Note.md");
  });

  it("keeps .md when present", () => {
    expect(createPathForTarget("Note.md")).toBe("Note.md");
  });

  it("preserves slashes as path separators", () => {
    expect(createPathForTarget("notes/sub/Idea")).toBe("notes/sub/Idea.md");
  });

  it("treats the bare target as vault-root relative", () => {
    expect(createPathForTarget("Idea")).toBe("Idea.md");
  });
});

describe("handleWikiLinkClick", () => {
  it("navigates when the target resolves", () => {
    const onNavigate = vi.fn();
    const onOfferCreate = vi.fn();
    const result: WikiLinkClickResult = handleWikiLinkClick("note", {
      resolver: resolverWith({ note: { target_path: "note.md", anchor: null } }),
      onNavigate,
      onOfferCreate,
    });
    expect(result).toBe("navigated");
    expect(onNavigate).toHaveBeenCalledWith("note.md", null);
    expect(onOfferCreate).not.toHaveBeenCalled();
  });

  it("offers create when the target is known-unresolved", () => {
    const onNavigate = vi.fn();
    const onOfferCreate = vi.fn();
    const result = handleWikiLinkClick("Missing", {
      resolver: resolverWith({ Missing: { target_path: null, anchor: null } }),
      onNavigate,
      onOfferCreate,
    });
    expect(result).toBe("offered");
    expect(onOfferCreate).toHaveBeenCalledWith("Missing.md");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("returns 'pending' and kicks the fetch when the cache is cold", () => {
    const fetch = vi.fn();
    const resolver: WikiLinkResolver = {
      get: () => undefined,
      fetch,
      invalidate: () => {},
      onUpdate: () => () => {},
    };
    const result = handleWikiLinkClick("note", {
      resolver,
      onNavigate: vi.fn(),
      onOfferCreate: vi.fn(),
    });
    expect(result).toBe("pending");
    expect(fetch).toHaveBeenCalledWith("note");
  });

  it("strips the anchor from target for navigation but echoes it through", () => {
    const onNavigate = vi.fn();
    const result = handleWikiLinkClick("note#Heading One", {
      resolver: resolverWith({
        "note#Heading One": {
          target_path: "note.md",
          anchor: null /* resolver-supplied; test just confirms passthrough */,
        },
      }),
      onNavigate,
      onOfferCreate: vi.fn(),
    });
    expect(result).toBe("navigated");
    expect(onNavigate).toHaveBeenCalledWith("note.md", null);
  });
});
```

- [ ] **Step 2: Run the test, expect failure.**

```bash
cd ui && npx vitest run src/editor/wikilinkClick.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the router.**

```typescript
// ui/src/editor/wikilinkClick.ts
/**
 * Pure click router for wiki-links (L3 Session B, spec §2.2).
 *
 * Given a wiki-link target string (post-tokenizer: no `[[…]]`, no
 * leading `!`, may carry `#anchor`), a resolver, and two callbacks,
 * decides whether to navigate, offer to create the missing note, or
 * report "pending" because the resolver hasn't seen this target yet.
 *
 * Kept DOM-free so it unit-tests cleanly. The DOM glue (mapping a
 * click event back to a `WikiLink` Lezer node, extracting the target
 * via `scanWikilinks`, plumbing the result to `App.tsx` callbacks)
 * lives in `Editor.tsx`.
 */

import type { ResolvedAnchor } from "../api/ipc";
import type { WikiLinkResolver } from "./wikilinkResolver";

export type WikiLinkClickResult = "navigated" | "offered" | "pending";

export interface WikiLinkClickContext {
  resolver: WikiLinkResolver;
  /** Open the resolved target file (with optional anchor scroll). */
  onNavigate: (path: string, anchor: ResolvedAnchor | null) => void;
  /** Prompt the user to create the missing note at `path`. */
  onOfferCreate: (path: string) => void;
}

/**
 * Convert a wiki-link target (post-tokenizer; may carry an anchor) to
 * a vault-relative `.md` path. Anchors do not affect the file path.
 *
 * `Note` → `Note.md`; `notes/sub/Idea` → `notes/sub/Idea.md`;
 * `Note.md` → `Note.md` (no double extension).
 */
export function createPathForTarget(targetRaw: string): string {
  const noAnchor = stripAnchor(targetRaw);
  return noAnchor.endsWith(".md") ? noAnchor : `${noAnchor}.md`;
}

function stripAnchor(targetRaw: string): string {
  const hash = targetRaw.indexOf("#");
  return hash >= 0 ? targetRaw.slice(0, hash) : targetRaw;
}

/**
 * Route a click on a wiki-link. The resolver is consulted
 * synchronously: a cache hit dispatches `onNavigate` (resolved) or
 * `onOfferCreate` (known-unresolved); a cache miss kicks off the
 * async fetch and returns `"pending"` so the caller can no-op until
 * the next decoration rebuild.
 */
export function handleWikiLinkClick(
  targetRaw: string,
  ctx: WikiLinkClickContext,
): WikiLinkClickResult {
  const hit = ctx.resolver.get(targetRaw);
  if (hit === undefined) {
    ctx.resolver.fetch(targetRaw);
    return "pending";
  }
  if (hit.target_path !== null) {
    ctx.onNavigate(hit.target_path, hit.anchor);
    return "navigated";
  }
  ctx.onOfferCreate(createPathForTarget(targetRaw));
  return "offered";
}
```

- [ ] **Step 4: Run the test, expect PASS.**

```bash
cd ui && npx vitest run src/editor/wikilinkClick.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/editor/wikilinkClick.ts ui/src/editor/wikilinkClick.test.ts
git commit -m "feat(editor): pure click router + create-by-convention path"
```

---

### Task 4: Wire `WikiLink` decorations into `decorations.ts`

**Files:**
- Modify: `ui/src/editor/decorations.ts`
- Modify: `ui/src/editor/decorations.test.ts`

`collectDecorations` learns a new node name `WikiLink`. For each one it:
1. Slices the doc to get the raw text.
2. Re-tokenises with `scanWikilinks` to pull `{target, display, anchor, embed}`.
3. Computes the visible byte range inside the token (`display ?? target`).
4. Computes the hide ranges (everything else).
5. Looks up resolution status via a `WikiLinkResolver` supplied through a CodeMirror `Facet`.

On the cursor line, all ranges become `mark-marker-muted` (mirrors how `Link` reveals its source).

Add three new `DecoKind` values: `mark-wikilink`, `mark-wikilink-unresolved`, `mark-wikilink-embed`. Add matching CSS classes + base-theme rules.

- [ ] **Step 1: Write the failing decoration tests.**

Add these to `ui/src/editor/decorations.test.ts` (append after the existing `describe` blocks). The tests use a parser configured with the `wikilinkExtension` so the tree carries `WikiLink` nodes; they pass a stub resolver via the new optional `resolverLookup` parameter.

```typescript
// At top of decorations.test.ts — extend imports
import { parser as baseParser } from "@lezer/markdown";
// already imports parser as the unconfigured one — rename:
//   import { parser } from "@lezer/markdown";
// becomes:
//   import { parser as defaultParser } from "@lezer/markdown";
// and `parser` is built locally:
//   const parser = defaultParser.configure([wikilinkExtension]);
// (See implementation step below for the exact diff.)
import { wikilinkExtension } from "./wikilink";
import type { WikiLinkResolution } from "./wikilinkResolver";
```

Replace the existing `run` helper to accept a resolver lookup and use the configured parser:

```typescript
const parser = defaultParser.configure([wikilinkExtension]);

function run(
  src: string,
  activeLine: number,
  resolverLookup?: (targetRaw: string) => WikiLinkResolution | undefined,
): DecoEntry[] {
  const tree = parser.parse(src);
  const doc = Text.of(src.split("\n"));
  return collectDecorations(tree, doc, activeLine, resolverLookup);
}
```

(Existing call sites with no resolver argument keep working — the parameter is optional and defaults to "always unresolved? No — always pending/resolved-style"; see implementation.)

Append the wiki-link describe blocks:

```typescript
describe("collectDecorations — wiki-links", () => {
  const resolvedAll: (t: string) => WikiLinkResolution = () => ({
    target_path: "note.md",
    anchor: null,
  });
  const unresolvedAll: (t: string) => WikiLinkResolution = () => ({
    target_path: null,
    anchor: null,
  });

  it("[[note]] off-cursor: hide [[ and ]], visible target as mark-wikilink", () => {
    const src = "see [[note]] here\n";
    const entries = run(src, 99, resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[", "]]"]);
  });

  it("[[note|display]] off-cursor: hide [[note|, show display as mark-wikilink", () => {
    const src = "[[note|display]]\n";
    const entries = run(src, 99, resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("display");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[note|", "]]"]);
  });

  it("[[note#heading]] off-cursor: visible target, hide [[ and #heading]]", () => {
    const src = "[[note#heading]]\n";
    const entries = run(src, 99, resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[", "#heading]]"]);
  });

  it("[[note#^id]] off-cursor: visible target, hide [[ and #^id]]", () => {
    const src = "[[note#^id]]\n";
    const entries = run(src, 99, resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[", "#^id]]"]);
  });

  it("![[diagram]] off-cursor: embed indicator + visible target", () => {
    const src = "![[diagram]]\n";
    const entries = run(src, 99, resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("diagram");
    expect(ofKind(entries, "mark-wikilink-embed")).toHaveLength(1);
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["![[", "]]"]);
  });

  it("unresolved target gets mark-wikilink-unresolved instead of mark-wikilink", () => {
    const src = "[[missing]]\n";
    const entries = run(src, 99, unresolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink-unresolved")))).toBe("missing");
    expect(ofKind(entries, "mark-wikilink")).toHaveLength(0);
  });

  it("pending resolution (resolver returns undefined) renders as resolved-style", () => {
    // Don't paint the warning state on tokens we have not yet
    // checked — that flashes warnings the user has no reason to
    // see. The next decoration rebuild after the IPC returns will
    // repaint unresolved targets correctly.
    const src = "[[note]]\n";
    const entries = run(src, 99, () => undefined);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    expect(ofKind(entries, "mark-wikilink-unresolved")).toHaveLength(0);
  });

  it("on the cursor line, all wiki-link ranges become mark-marker-muted", () => {
    const src = "[[note|display]]\n";
    const entries = run(src, 1, unresolvedAll);
    expect(ofKind(entries, "mark-wikilink")).toHaveLength(0);
    expect(ofKind(entries, "mark-wikilink-unresolved")).toHaveLength(0);
    expect(ofKind(entries, "mark-wikilink-embed")).toHaveLength(0);
    expect(ofKind(entries, "hide")).toHaveLength(0);
    // Brackets + content all muted. We don't assert exact substring
    // splits here — the cursor-line behaviour is "reveal raw source",
    // exact range boundaries are an implementation detail.
    expect(ofKind(entries, "mark-marker-muted").length).toBeGreaterThan(0);
  });

  it("multiple wiki-links in one paragraph each get their own decoration", () => {
    const src = "[[a]] and [[b]]\n";
    const entries = run(src, 99, resolvedAll);
    const visible = ofKind(entries, "mark-wikilink").map((e) => slice(src, e));
    expect(visible.sort()).toEqual(["a", "b"]);
  });

  it("'out of scope' regression: with wikilink extension installed, [[X]] no longer falls through as raw text", () => {
    // L2's "out of scope nodes stay raw" test used to leave [[WikiPage]]
    // untouched. With the Session B Lezer rule installed, it now
    // decorates. Update the regression to assert the new behaviour.
    const src = "[[WikiPage]]\n";
    const entries = run(src, 99, resolvedAll);
    expect(ofKind(entries, "mark-wikilink")).toHaveLength(1);
  });
});
```

You must also **update the existing "out of scope nodes stay raw" test** which currently asserts `[[WikiPage]]` produces no decorations. Either drop the `[[WikiPage]]` line from its source string or change the assertion. Drop the line — wiki-links *are* now decorated.

```typescript
// Replace this test body:
it("leaves images, thematic breaks and tags undecorated", () => {
  const src = "![alt](http://x)\n\n---\n\n#tag is not a heading\n\nend";
  const entries = run(src, 7);
  expect(kinds(entries)).toEqual(["line-active"]);
});
```

- [ ] **Step 2: Run the tests, expect failures.**

```bash
cd ui && npx vitest run src/editor/decorations.test.ts
```

Expected: FAIL — `collectDecorations` does not accept a 4th arg; no `mark-wikilink*` kinds.

- [ ] **Step 3: Extend `DecoKind` + `collectDecorations`.**

Diff against `ui/src/editor/decorations.ts`:

```typescript
// Extend the union:
export type DecoKind =
  | "line-h1"
  | "line-h2"
  | "line-h3"
  | "line-h4"
  | "line-h5"
  | "line-h6"
  | "line-code"
  | "line-quote"
  | "line-active"
  | "mark-em"
  | "mark-strong"
  | "mark-code"
  | "mark-link"
  | "mark-wikilink"
  | "mark-wikilink-unresolved"
  | "mark-wikilink-embed"
  | "mark-marker-muted"
  | "hide"
  | "bullet";
```

Import the tokenizer + resolution type:

```typescript
import { scanWikilinks } from "../ast/wikilink";
import type { WikiLinkResolution } from "./wikilinkResolver";
```

Update `collectDecorations` signature:

```typescript
/**
 * Walk the Lezer tree and produce the decoration entry list for the
 * current cursor line. `resolverLookup`, when supplied, supplies
 * resolution status per wiki-link target — see
 * `wikilinkResolver.ts`. Returns `undefined` for an uncached target,
 * which paints as "resolved-style" pending the next rebuild.
 */
export function collectDecorations(
  tree: Tree,
  doc: Text,
  activeLine: number,
  resolverLookup?: (targetRaw: string) => WikiLinkResolution | undefined,
): DecoEntry[] {
```

Inside the `tree.iterate(...)` walk, add a case for `WikiLink`. It does **not** push into `markers` (which auto-mute on the cursor line) because the wiki-link "visible" portion stays styled off-cursor as `mark-wikilink`. Instead it pushes its own entries and respects `activeLine` inline:

```typescript
if (name === "WikiLink") {
  const raw = doc.sliceString(node.from, node.to);
  const tokens = scanWikilinks(raw);
  const tok = tokens.find((t) => t.kind === "wiki_link");
  if (!tok) return; // shouldn't happen — the Lezer rule already rejected empty targets

  const isEmbed = tok.embed;
  const openerLen = isEmbed ? 3 : 2; // "![[" or "[["
  const closerLen = 2; // "]]"
  const contentStart = node.from + openerLen;
  const contentEnd = node.to - closerLen;

  // Visible range inside the body: display takes precedence over target.
  // The body excluding brackets is `raw.slice(openerLen, raw.length - closerLen)`.
  // We need absolute byte offsets — search within `raw` for the
  // display/target string and shift by `node.from`. Both are guaranteed
  // present in the source by construction.
  let visibleFrom: number;
  let visibleTo: number;
  if (tok.display !== null) {
    // Display sits after the `|`. Find the pipe in the body and place
    // the visible range from the byte after `|` through `contentEnd`.
    const pipeRel = raw.indexOf("|", openerLen);
    visibleFrom = node.from + pipeRel + 1;
    visibleTo = contentEnd;
  } else {
    // No display — visible range is the target. Find it by scanning
    // from contentStart for the first `#` or `]]` (whichever comes
    // first) to locate the target's end.
    let i = contentStart;
    while (i < contentEnd) {
      const ch = raw.charCodeAt(i - node.from);
      if (ch === 0x23 /* # */ || ch === 0x7c /* | */) break;
      i++;
    }
    visibleFrom = contentStart;
    visibleTo = i;
  }

  const onActiveLine = doc.lineAt(node.from).number === activeLine;

  if (onActiveLine) {
    // Reveal the entire token muted — mirrors Link/Emphasis cursor-line
    // behaviour. One range across the whole WikiLink, no special
    // styling per sub-range.
    visible.push({
      from: node.from,
      to: node.to,
      kind: "mark-marker-muted",
    });
    return;
  }

  // Off-cursor: emit hide entries for everything except the visible
  // range, plus a mark for the visible range and (if embed) an icon.
  if (visibleFrom > node.from) {
    visible.push({ from: node.from, to: visibleFrom, kind: "hide" });
  }
  const resolution = resolverLookup?.(extractTargetWithAnchor(tok));
  const visibleKind: DecoKind =
    resolution && resolution.target_path === null
      ? "mark-wikilink-unresolved"
      : "mark-wikilink";
  visible.push({ from: visibleFrom, to: visibleTo, kind: visibleKind });
  if (visibleTo < node.to) {
    visible.push({ from: visibleTo, to: node.to, kind: "hide" });
  }
  if (isEmbed) {
    // Zero-width widget at the token start; the BulletWidget pattern
    // works here too — see EmbedWidget below.
    visible.push({
      from: node.from,
      to: node.from,
      kind: "mark-wikilink-embed",
    });
  }
  return;
}
```

Add a helper near `extendSpaces`:

```typescript
/**
 * The cache key passed to the resolver: the wiki-link target as written
 * including any `#anchor`. Matches the `target_raw` input shape that
 * `resolve_link` accepts.
 */
function extractTargetWithAnchor(tok: {
  target: string;
  anchor: { kind: "heading" | "block"; value: string } | null;
}): string {
  if (tok.anchor === null) return tok.target;
  const prefix = tok.anchor.kind === "block" ? "#^" : "#";
  return `${tok.target}${prefix}${tok.anchor.value}`;
}
```

Add CM6 deco constructors + theme rules:

```typescript
const wikilinkMarkDeco = Decoration.mark({ class: "cm-md-wikilink" });
const wikilinkUnresolvedDeco = Decoration.mark({
  class: "cm-md-wikilink-unresolved",
});

class EmbedIndicatorWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-wikilink-embed";
    span.textContent = "⎘";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  override eq(): boolean {
    return true;
  }
}
const wikilinkEmbedDeco = Decoration.widget({
  widget: new EmbedIndicatorWidget(),
  side: -1,
});
```

Extend `buildDecorationSet`:

```typescript
case "mark-wikilink":
  ranges.push(wikilinkMarkDeco.range(e.from, e.to));
  break;
case "mark-wikilink-unresolved":
  ranges.push(wikilinkUnresolvedDeco.range(e.from, e.to));
  break;
case "mark-wikilink-embed":
  ranges.push(wikilinkEmbedDeco.range(e.from));
  break;
```

Extend `decorationBaseTheme`:

```typescript
".cm-md-wikilink": {
  color: "var(--c-accent)",
  textDecoration: "underline",
  cursor: "pointer",
},
".cm-md-wikilink-unresolved": {
  color: "var(--c-warning)",
  textDecoration: "underline dashed",
  cursor: "pointer",
},
".cm-md-wikilink-embed": {
  color: "var(--c-accent)",
  marginRight: "var(--space-1)",
  fontSize: "0.85em",
},
```

Add the resolver Facet and a way for the plugin to read it:

```typescript
import { Facet, StateEffect } from "@codemirror/state";

/**
 * Per-editor wiki-link resolver supplied via a CodeMirror Facet so
 * extensions can read it without prop-drilling. `Editor.tsx` provides
 * a real `WikiLinkResolver` when a vault is open; default = always
 * "pending" (no resolver, everything renders as resolved-style).
 */
export const wikilinkResolverFacet = Facet.define<
  ((targetRaw: string) => WikiLinkResolution | undefined) | null,
  ((targetRaw: string) => WikiLinkResolution | undefined) | null
>({
  combine: (values) => values[0] ?? null,
});

/**
 * StateEffect the resolver fires (through Editor.tsx) when its cache
 * changes — invalidation or a completed fetch. The decoration plugin
 * watches transactions for this effect and rebuilds.
 */
export const wikilinkResolverUpdated = StateEffect.define<null>();
```

Update `buildFor` to thread the facet:

```typescript
function buildFor(view: EditorView): DecorationSet {
  const tree = syntaxTree(view.state);
  const head = view.state.selection.main.head;
  const activeLine = view.state.doc.lineAt(head).number;
  const resolver = view.state.facet(wikilinkResolverFacet);
  return buildDecorationSet(
    collectDecorations(
      tree,
      view.state.doc,
      activeLine,
      resolver ?? undefined,
    ),
  );
}
```

And the `update` method picks up the new effect:

```typescript
update(update: ViewUpdate): void {
  if (
    update.docChanged ||
    update.viewportChanged ||
    update.selectionSet ||
    syntaxTree(update.startState) !== syntaxTree(update.state) ||
    update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(wikilinkResolverUpdated)),
    )
  ) {
    this.decorations = buildFor(update.view);
  }
}
```

Also fetch on-build: walk the resolver lookup outside `collectDecorations` would be cleaner, but the simplest path is to expose a *separate* helper that the plugin runs after `collectDecorations`:

```typescript
/**
 * Pure: list every unique wiki-link target (incl. anchor) in the tree.
 * The plugin uses this to ask the resolver to fetch any not-yet-cached
 * target after a rebuild.
 */
export function collectWikiLinkTargets(tree: Tree, doc: Text): string[] {
  const out: string[] = [];
  tree.iterate({
    enter: (node) => {
      if (node.name !== "WikiLink") return;
      const raw = doc.sliceString(node.from, node.to);
      const tok = scanWikilinks(raw).find((t) => t.kind === "wiki_link");
      if (!tok) return;
      out.push(extractTargetWithAnchor(tok));
    },
  });
  // Dedupe.
  return Array.from(new Set(out));
}
```

The `livePreviewPlugin`'s `constructor` and `update` then kick fetches:

```typescript
private kickFetches(view: EditorView): void {
  const resolver = view.state.facet(wikilinkResolverFacet);
  if (!resolver) return;
  // `resolver` is the lookup function. We need the full resolver to
  // call .fetch(). Provide that via a second facet — keeping these
  // two together avoids leaking implementation:
  //
  //   wikilinkResolverFacet supplies the sync lookup;
  //   wikilinkResolverFetchFacet supplies the async kick.
  //
  // We could collapse into one facet carrying the full object, which
  // is simpler. Do that — see facet definition below.
}
```

Re-spec the facet as a single object:

```typescript
/**
 * Per-editor wiki-link resolver supplied via Facet. `null` when no
 * vault is open. The decoration plugin reads `.get` for sync lookup
 * and calls `.fetch` for cache misses; both are pure functions on the
 * resolver object.
 */
export interface WikiLinkResolverFacetValue {
  get(targetRaw: string): WikiLinkResolution | undefined;
  fetch(targetRaw: string): void;
}

export const wikilinkResolverFacet = Facet.define<
  WikiLinkResolverFacetValue | null,
  WikiLinkResolverFacetValue | null
>({
  combine: (values) => values[0] ?? null,
});
```

(Update `collectDecorations`'s 4th parameter to match: `resolverLookup?: (t: string) => WikiLinkResolution | undefined` is still fine for the pure core — the plugin extracts `.get` from the facet value and passes it down.)

`buildFor`:

```typescript
function buildFor(view: EditorView): DecorationSet {
  const tree = syntaxTree(view.state);
  const head = view.state.selection.main.head;
  const activeLine = view.state.doc.lineAt(head).number;
  const resolver = view.state.facet(wikilinkResolverFacet);
  return buildDecorationSet(
    collectDecorations(
      tree,
      view.state.doc,
      activeLine,
      resolver ? (t) => resolver.get(t) : undefined,
    ),
  );
}
```

`livePreviewPlugin`:

```typescript
const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildFor(view);
      this.kickFetches(view);
    }

    update(updateEvt: ViewUpdate): void {
      if (
        updateEvt.docChanged ||
        updateEvt.viewportChanged ||
        updateEvt.selectionSet ||
        syntaxTree(updateEvt.startState) !== syntaxTree(updateEvt.state) ||
        updateEvt.transactions.some((tr) =>
          tr.effects.some((e) => e.is(wikilinkResolverUpdated)),
        )
      ) {
        this.decorations = buildFor(updateEvt.view);
        this.kickFetches(updateEvt.view);
      }
    }

    private kickFetches(view: EditorView): void {
      const resolver = view.state.facet(wikilinkResolverFacet);
      if (!resolver) return;
      const targets = collectWikiLinkTargets(
        syntaxTree(view.state),
        view.state.doc,
      );
      for (const t of targets) {
        if (resolver.get(t) === undefined) resolver.fetch(t);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
```

- [ ] **Step 4: Run the tests, expect PASS.**

```bash
cd ui && npx vitest run src/editor/decorations.test.ts
```

Expected: PASS, baseline 19 + new wiki-link tests.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/editor/decorations.ts ui/src/editor/decorations.test.ts
git commit -m "feat(editor): decorate wiki-links in Live Preview"
```

---

### Task 5: Plumb resolver Facet + install wiki-link Lezer extension in `Editor.tsx`

**Files:**
- Modify: `ui/src/Editor.tsx`

The Editor accepts:
1. An optional `wikilinkResolver: WikiLinkResolver | null` prop. When present, it's installed into the Facet and subscribed to so cache updates trigger a decoration rebuild.
2. Optional `onNavigateWikilink: (path, anchor) => void` and `onOfferCreateWikilink: (path) => void` props. Both wired through the click router.
3. A new `scrollToHeading(value: string): void` on `EditorApi` so the parent can scroll to a heading after a file loads.

The `markdown()` call gets the `wikilinkExtension`. A `domEventHandlers` extension catches `click` on `WikiLink` nodes and routes via `handleWikiLinkClick`.

The resolver and callbacks live in a `Compartment` so they can be swapped when the vault changes (a new resolver instance per vault).

- [ ] **Step 1: Sketch the diff.**

Add imports:

```typescript
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState, StateEffect } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import {
  livePreviewDecorations,
  wikilinkResolverFacet,
  wikilinkResolverUpdated,
  type WikiLinkResolverFacetValue,
} from "./editor/decorations";
import { wikilinkExtension } from "./editor/wikilink";
import { scanWikilinks } from "./ast/wikilink";
import {
  handleWikiLinkClick,
  createPathForTarget,
} from "./editor/wikilinkClick";
import type { WikiLinkResolver } from "./editor/wikilinkResolver";
import type { ResolvedAnchor } from "./api/ipc";
```

Add a compartment for the resolver facet:

```typescript
const wikilinkResolverCompartment = new Compartment();
```

Extend `EditorApi`:

```typescript
export interface EditorApi {
  getContent: () => string;
  replaceContent: (next: string) => void;
  replaceRange: (from: number, to: number, text: string) => void;
  /**
   * Scroll the viewport to the first heading whose plain-text content
   * matches `value` (case-sensitive, trimmed). No-op when not found.
   * Used by the wiki-link click handler after navigating with a
   * `Heading{value}` anchor.
   */
  scrollToHeading: (value: string) => void;
}
```

Extend `EditorProps`:

```typescript
export interface EditorProps {
  value: string;
  resolvedTheme: ResolvedTheme;
  rawSource: boolean;
  /** Resolver for wiki-link targets; `null` when no vault is open. */
  wikilinkResolver?: WikiLinkResolver | null;
  /** Called when a click lands on a resolved wiki-link. */
  onNavigateWikilink?: (path: string, anchor: ResolvedAnchor | null) => void;
  /** Called when a click lands on an unresolved wiki-link. */
  onOfferCreateWikilink?: (path: string) => void;
  onAstChange?: (doc: CanonicalDocument) => void;
  onContentChange?: (content: string) => void;
  onBlur?: () => void;
  onToggleRawSource?: () => void;
  ref?: (api: EditorApi) => void;
}
```

Compose the facet value:

```typescript
const facetValueFor = (
  resolver: WikiLinkResolver | null | undefined,
): WikiLinkResolverFacetValue | null =>
  resolver
    ? {
        get: (t) => resolver.get(t),
        fetch: (t) => resolver.fetch(t),
      }
    : null;
```

Inside `onMount`, wire the click handler and the resolver subscription:

```typescript
const handleClickAtPos = (view: EditorView, pos: number): boolean => {
  const tree = syntaxTree(view.state);
  let hit: { from: number; to: number } | null = null;
  tree.iterate({
    from: pos,
    to: pos,
    enter: (node) => {
      if (node.name === "WikiLink" && node.from <= pos && pos <= node.to) {
        hit = { from: node.from, to: node.to };
      }
    },
  });
  if (!hit) return false;
  const raw = view.state.sliceDoc(hit.from, hit.to);
  const tok = scanWikilinks(raw).find((t) => t.kind === "wiki_link");
  if (!tok) return false;
  const targetWithAnchor =
    tok.anchor === null
      ? tok.target
      : `${tok.target}${tok.anchor.kind === "block" ? "#^" : "#"}${tok.anchor.value}`;

  const resolverObj = props.wikilinkResolver ?? null;
  if (!resolverObj) return false;

  handleWikiLinkClick(targetWithAnchor, {
    resolver: resolverObj,
    onNavigate: (path, anchor) =>
      props.onNavigateWikilink?.(path, anchor),
    onOfferCreate: (path) => props.onOfferCreateWikilink?.(path),
  });
  return true;
};

const clickHandler = EditorView.domEventHandlers({
  click(event, view) {
    if (event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return false;
    }
    const target = event.target as Node | null;
    if (!target) return false;
    const pos = view.posAtDOM(target);
    if (handleClickAtPos(view, pos)) {
      event.preventDefault();
      return true;
    }
    return false;
  },
});
```

Add the compartment + click handler + wikilink extension to the editor's `extensions` array:

```typescript
extensions: [
  history(),
  keymap.of([
    {
      key: "Mod-e",
      run: () => {
        props.onToggleRawSource?.();
        return true;
      },
    },
    ...defaultKeymap,
    ...historyKeymap,
  ]),
  markdown({ extensions: [wikilinkExtension] }),
  decorationCompartment.of(
    props.rawSource ? [] : livePreviewDecorations,
  ),
  wikilinkResolverCompartment.of(
    wikilinkResolverFacet.of(facetValueFor(props.wikilinkResolver)),
  ),
  themeCompartment.of(buildCmTheme()),
  clickHandler,
  updateListener,
  focusListener,
],
```

Subscribe to the resolver's `onUpdate` so cache updates trigger a rebuild:

```typescript
// After `view = new EditorView(...)`:
let unsubResolver: (() => void) | undefined;
const subscribeResolver = (resolver: WikiLinkResolver | null | undefined) => {
  unsubResolver?.();
  unsubResolver = undefined;
  if (resolver) {
    unsubResolver = resolver.onUpdate(() => {
      view?.dispatch({ effects: wikilinkResolverUpdated.of(null) });
    });
  }
};
subscribeResolver(props.wikilinkResolver);
```

React to prop changes for the resolver:

```typescript
createEffect(
  on(
    () => props.wikilinkResolver,
    (resolver) => {
      view?.dispatch({
        effects: wikilinkResolverCompartment.reconfigure(
          wikilinkResolverFacet.of(facetValueFor(resolver)),
        ),
      });
      subscribeResolver(resolver);
    },
    { defer: true },
  ),
);
```

`onCleanup`:

```typescript
onCleanup(() => {
  unsubResolver?.();
  if (astPending !== undefined) clearTimeout(astPending);
  view?.destroy();
  view = undefined;
});
```

Implement `scrollToHeading`:

```typescript
props.ref?.({
  getContent: () => view?.state.doc.toString() ?? "",
  replaceContent: (next) => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === next) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: next },
    });
  },
  replaceRange: (from, to, text) => {
    if (!view) return;
    view.dispatch({ changes: { from, to, insert: text } });
  },
  scrollToHeading: (value) => {
    if (!view) return;
    const tree = syntaxTree(view.state);
    let found: { from: number } | null = null;
    tree.iterate({
      enter: (node) => {
        if (found) return false;
        if (!/^(ATX|Setext)Heading[1-6]$/.test(node.name)) return undefined;
        // Heading content = node text minus the leading `# ` (ATX)
        // or trailing underline (Setext). Easiest: read the first
        // line of the node range.
        const line = view!.state.doc.lineAt(node.from);
        const raw = line.text;
        // Strip leading `#` markers + space for ATX.
        const atx = raw.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
        const text = atx?.[1] ?? raw.trim();
        if (text === value) {
          found = { from: line.from };
          return false;
        }
        return undefined;
      },
    });
    if (!found) return;
    view.dispatch({
      effects: EditorView.scrollIntoView(found.from, { y: "start" }),
    });
  },
});
```

(Unused-import note: `StateEffect` ends up unused here — drop from the import line if so. The build will tell us.)

- [ ] **Step 2: Run typecheck + build.**

```bash
cd ui && npx tsc --noEmit && npm run build
```

Expected: clean.

- [ ] **Step 3: Run all vitest suites — nothing should regress.**

```bash
cd ui && npx vitest run
```

Expected: every test green; new wiki-link tests count.

- [ ] **Step 4: Commit.**

```bash
git add ui/src/Editor.tsx
git commit -m "feat(editor): install wikilink extension + resolver Facet + click router"
```

---

### Task 6: Wire resolver, navigation, and create-offer modal into `App.tsx`

**Files:**
- Modify: `ui/src/App.tsx`

`App.tsx` owns one `WikiLinkResolver` per vault, resets it on `handleOpen`, passes it to `<Editor>`, invalidates it on `vault:file-changed`, and provides the navigation + create-offer callbacks.

- [ ] **Step 1: Add resolver state + helpers.**

```typescript
import { createWikiLinkResolver, type WikiLinkResolver } from "./editor/wikilinkResolver";
import type { ResolvedAnchor } from "./api/ipc";
```

Inside `App`:

```typescript
const [wikilinkResolver, setWikilinkResolver] =
  createSignal<WikiLinkResolver | null>(null);
const [createOffer, setCreateOffer] = createSignal<
  | { path: string }
  | null
>(null);

// Anchor to scroll to after a wiki-link navigation completes. Cleared
// once consumed.
let pendingAnchor: ResolvedAnchor | null = null;
```

- [ ] **Step 2: Reset the resolver on vault open.**

Inside `handleOpen`, right after `setVaultId(resp.vault_id)`:

```typescript
setWikilinkResolver(createWikiLinkResolver(resp.vault_id));
```

And clear it when no vault is open (initial state already has `null`).

- [ ] **Step 3: Invalidate on `vault:file-changed`.**

Inside the existing `unlistenFileChanged` handler — append at the top:

```typescript
unlistenFileChanged = await onVaultFileChanged((p) => {
  if (p.vault_id !== vaultId()) return;
  scheduleRefresh();

  // L3 Session B: any file change in the vault may have created or
  // removed a wiki-link target. Drop the resolver cache so the next
  // decoration rebuild re-resolves.
  wikilinkResolver()?.invalidate();

  // (existing L2 hash-gating logic unchanged below)
  // ...
});
```

- [ ] **Step 4: Define navigation + create-offer handlers.**

```typescript
const handleNavigateWikilink = async (
  path: string,
  anchor: ResolvedAnchor | null,
) => {
  const id = vaultId();
  if (!id) return;
  // Find the FileEntry by path (so the existing selection plumbing
  // does its hash/seenHash/reset dance unchanged). If the file is
  // not in the visible window, fabricate a minimal entry — handleSelectFile
  // only reads `path` + `type_id` from it.
  const existing = files().find((f) => f.path === path);
  const file = existing ?? {
    path,
    type_id: "markdown",
    size_bytes: 0,
    mtime_unix: 0,
  };
  pendingAnchor = anchor;
  await handleSelectFile(file);
  // The file has loaded; if the anchor is a heading, scroll to it.
  // (Block anchors are Session G territory — see spec §2.2.)
  if (pendingAnchor && pendingAnchor.kind === "heading") {
    editorApi?.scrollToHeading(pendingAnchor.value);
  }
  pendingAnchor = null;
};

const handleOfferCreateWikilink = (path: string) => {
  setCreateOffer({ path });
};

const acceptCreateOffer = async () => {
  const offer = createOffer();
  const id = vaultId();
  if (!offer || !id) return;
  setCreateOffer(null);
  try {
    await writeFileText({ vault_id: id, path: offer.path, content: "" });
    // The newly-created file will arrive via vault:file-changed,
    // which also invalidates the resolver. Navigate immediately.
    await handleNavigateWikilink(offer.path, null);
  } catch (e) {
    const message =
      typeof e === "object" && e !== null && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e);
    setError(message);
  }
};

const dismissCreateOffer = () => {
  setCreateOffer(null);
};
```

- [ ] **Step 5: Pass the resolver + callbacks to `<Editor>`.**

```typescript
<Editor
  value={selectedContent() ?? ""}
  resolvedTheme={resolvedTheme()}
  rawSource={effectiveRaw()}
  wikilinkResolver={wikilinkResolver()}
  onNavigateWikilink={(path, anchor) =>
    void handleNavigateWikilink(path, anchor)
  }
  onOfferCreateWikilink={(path) => handleOfferCreateWikilink(path)}
  onToggleRawSource={toggleRawSource}
  onAstChange={handleAstChange}
  onContentChange={handleContentChange}
  onBlur={() => void flushAutosave()}
  ref={(api) => {
    editorApi = api;
  }}
/>
```

- [ ] **Step 6: Render the create-offer modal.**

Mirroring the conflict-banner styling. Inside the editor pane, near the conflict banner:

```typescript
<Show when={createOffer() !== null}>
  <div
    role="dialog"
    aria-modal="true"
    style={{
      position: "fixed",
      inset: 0,
      display: "flex",
      "align-items": "center",
      "justify-content": "center",
      background: "rgba(0, 0, 0, 0.32)",
      "z-index": 10,
    }}
    onClick={dismissCreateOffer}
  >
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        background: "var(--c-bg-primary)",
        border: "1px solid var(--c-border-subtle)",
        "border-radius": "var(--radius-md)",
        padding: "var(--space-4)",
        "min-width": "20rem",
        "max-width": "32rem",
        display: "flex",
        "flex-direction": "column",
        gap: "var(--space-3)",
        "box-shadow": "0 6px 24px rgba(0, 0, 0, 0.2)",
      }}
    >
      <p style={{ margin: 0, "font-size": "var(--text-sm)" }}>
        Create note <code>{createOffer()!.path}</code>?
      </p>
      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          "justify-content": "flex-end",
        }}
      >
        <button
          type="button"
          onClick={dismissCreateOffer}
          style={{
            padding: "var(--space-1) var(--space-3)",
            "font-size": "var(--text-xs)",
            "font-family": "var(--font-body)",
            color: "var(--c-fg-primary)",
            background: "var(--c-bg-tertiary)",
            border: "1px solid var(--c-border-subtle)",
            "border-radius": "var(--radius-sm, var(--radius-md))",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void acceptCreateOffer()}
          style={{
            padding: "var(--space-1) var(--space-3)",
            "font-size": "var(--text-xs)",
            "font-family": "var(--font-body)",
            color: "var(--c-fg-inverse)",
            background: "var(--c-accent)",
            border: "none",
            "border-radius": "var(--radius-sm, var(--radius-md))",
            cursor: "pointer",
          }}
        >
          Create note
        </button>
      </div>
    </div>
  </div>
</Show>
```

- [ ] **Step 7: Typecheck + build + full vitest.**

```bash
cd ui && npx tsc --noEmit && npm run build && npx vitest run
```

Expected: clean; all suites green.

- [ ] **Step 8: Commit.**

```bash
git add ui/src/App.tsx
git commit -m "feat(app): wire wiki-link resolver, navigation, and create-offer modal"
```

---

### Task 7: Raw-source toggle regression test

**Files:**
- Modify: `ui/src/editor/decorations.test.ts` (or add a new sibling test file)

The L2 Session E raw-source toggle reconfigures the decoration compartment to a no-op extension. Wiki-link decorations live inside `livePreviewDecorations`, so the toggle naturally suppresses them. The regression here asserts the inverse: when the compartment carries `livePreviewDecorations`, wiki-link decorations appear; when it carries `[]`, none do.

This is best framed at the `livePreviewDecorations` level (the bundle the compartment swaps), not at `collectDecorations`. A small CM6 integration test in `decorations.test.ts`:

- [ ] **Step 1: Write the regression test.**

```typescript
// Add to decorations.test.ts
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import { livePreviewDecorations } from "./decorations";
import { wikilinkExtension } from "./wikilink";

describe("livePreviewDecorations bundle — raw-source toggle parity", () => {
  function decoCount(extensions: Extension[]): number {
    const state = EditorState.create({
      doc: "see [[note]] here\n",
      extensions: [markdown({ extensions: [wikilinkExtension] }), ...extensions],
    });
    // Force the parser to run synchronously for the test.
    const view = new EditorView({ state });
    try {
      const set = view.plugin(livePreviewPluginValue);
      return set ? 1 : 0; // see below; we just count decorations in the view
    } finally {
      view.destroy();
    }
  }
  // ... full integration assertion uses view.state.field/plugin output
});
```

The above is a sketch — exposing the plugin value from a module is awkward. Pragmatic alternative: assert at the `collectDecorations` level that the **`livePreviewDecorations` array contains the plugin**, and complement with a manual smoke pass. The cleaner, fully-unit-testable regression is a different angle:

```typescript
it("livePreviewDecorations bundle includes the wiki-link decoration ViewPlugin and base theme", () => {
  // The bundle is an array of three CM6 extensions: the view plugin,
  // a StateField for frontmatter, and the base theme. Asserting it is
  // an array of length 3 with non-null entries is enough — if any
  // extension goes missing, the editor's behaviour visibly changes.
  expect(Array.isArray(livePreviewDecorations)).toBe(true);
  expect((livePreviewDecorations as Extension[]).length).toBeGreaterThan(0);
});
```

That's weak. **Better:** a focused vitest using `EditorView` in jsdom that asserts the presence/absence of `.cm-md-wikilink` DOM elements with and without `livePreviewDecorations`. jsdom is already used elsewhere in the project (vitest's default environment) — but CM6's measurement loop expects a real DOM and may flake. Try the jsdom path; if it flakes, fall back to the structural assertion.

```typescript
import { JSDOM } from "jsdom"; // already a vitest transitive dep

it("wiki-link DOM markup vanishes when livePreviewDecorations is excluded", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const parent = dom.window.document.body;
  // Real CM6 EditorView setup:
  // ... mount once with livePreviewDecorations, snapshot DOM, expect .cm-md-wikilink
  // ... mount once without livePreviewDecorations, expect no .cm-md-wikilink
});
```

**If jsdom flakes**, mark this case as the manual smoke responsibility and keep a weaker structural test. The final source must include at minimum *some* regression — even if just a comment-driven note in `decorations.test.ts` that the raw-source toggle's interaction is verified by the interactive smoke pass in §9.2.

- [ ] **Step 2: Run + commit.**

```bash
cd ui && npx vitest run src/editor/decorations.test.ts
git add ui/src/editor/decorations.test.ts
git commit -m "test(editor): raw-source toggle regression for wiki-link decorations"
```

---

### Task 8: Gate the verification checklist

Run every gate from the session prompt and record exact counts.

- [ ] **Step 1: Rust workspace tests.**

```bash
cd /Users/user/Developer/Cubical && cargo test --workspace
```

Expected: 170 passing (unchanged unless a Rust gap forced a test — document why if so).

- [ ] **Step 2: TypeScript typecheck.**

```bash
cd ui && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Vite build.**

```bash
cd ui && npm run build
```

Expected: no errors.

- [ ] **Step 4: Vitest.**

```bash
cd ui && npx vitest run
```

Expected: 127 baseline + new wiki-link suites. Record the new total in the session report.

- [ ] **Step 5: Clippy + rustfmt.**

```bash
cd /Users/user/Developer/Cubical && cargo clippy --workspace --all-targets -- -D warnings
cd /Users/user/Developer/Cubical && cargo fmt --check
```

Expected: clean.

- [ ] **Step 6: Interactive smoke against `cargo tauri dev`.**

Create a small temp vault containing:

```
NoteA.md
  # NoteA
  body of A linking to [[NoteB]] and [[NoteB#heading]] and [[NoteB|nice]]
  Embedded: ![[NoteB]]
  Missing: [[NeverCreated]]

NoteB.md
  # NoteB
  body
  ## heading
  more
```

Confirm:
- Off-cursor: brackets hidden, `NoteB` / `nice` / `NeverCreated` rendered visibly.
- `NeverCreated` carries the dashed-warning style; `NoteB` does not.
- Click on `NoteB` opens NoteB.md.
- Click on `NoteB#heading` opens NoteB.md and scrolls to `## heading`.
- Click on `![[NoteB]]` opens NoteB.md (the embed indicator is purely visual in Session B — no inline render).
- Click on `NeverCreated` raises the modal. Accept → `NeverCreated.md` appears in the file list and opens. The wiki-link's warning style disappears on the next rebuild (no reload).
- Toggle `Cmd/Ctrl+E` (raw source) → the literal `[[…]]` source reappears, including across the wiki-links above.

Record observations in the session report. The native Tauri window can't be browser-driven — this is hands-on.

---

### Task 9: §9.2 write-up + CLAUDE.md state rewrite

**Files:**
- Modify: `docs/layer-3-spec.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Fill §9.2 in `docs/layer-3-spec.md`.**

Mirror the §9.1 voice. Cover: the Lezer inline rule + its `before: "Link"` placement; the resolver/cache/invalidation model; the decoration mapping for each shape; the click router + create-by-convention path; the modal UX choice (centered modal with backdrop, mirroring conflict-banner styling); the heading-anchor scroll mechanism (and block-anchor no-op pending Session G); the raw-source-toggle interaction; the test counts. Include a "Decisions worth noting" block similar to §9.1's.

- [ ] **Step 2: Rewrite `CLAUDE.md` "Project state".**

Don't append — *rewrite*. Approximate shape:

```
Current layer: 3 — Knowledge Graph (Sessions A + B done, Sessions C–K pending).
Session B landed the Lezer `[[…]]` / `![[…]]` inline rule, wiki-link
decorations in `decorations.ts` (off-cursor: brackets/anchor/display
markup hidden, visible text rendered as an accent link; on-cursor:
raw source revealed; embeds get an indicator widget), a per-vault
`WikiLinkResolver` cache over the Session A `resolve_link` IPC
(invalidated on `vault:file-changed`), and click routing — resolved
links open and scroll to heading anchors, unresolved links surface a
centered modal offering to create the note at the resolved-by-
convention path.
Tests: 170 Rust + <N> vitest.  (record actual)
L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`);
L2 closed 2026-05-22 (`l2`).
Next: L3 Session C — Backlinks panel + right-sidebar shell
(build-order §3, layer spec §2.3 + §8 Session C).
```

- [ ] **Step 3: Commit.**

```bash
git add docs/layer-3-spec.md CLAUDE.md
git commit -m "docs: L3 Session B complete — wiki-link Live Preview + click-to-navigate"
```

---

### Task 10: Finish the development branch

- [ ] **Step 1: Confirm gates one last time** (already done in Task 8, but the merge requires it).
- [ ] **Step 2: Invoke `superpowers:finishing-a-development-branch`.** Default per project workflow: merge `l3-session-b-wikilink-live-preview` into `main` with `--no-ff`. Do NOT skip hooks. Do NOT push.
- [ ] **Step 3: Report back per the session prompt's "SESSION END PROTOCOL":** every DoD box's status, decisions deferred to the plan, the new test counts, the smoke evidence, and the next session (L3 Session C).
