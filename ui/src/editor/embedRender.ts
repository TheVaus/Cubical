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
