import { scanWikilinks } from "../ast/wikilink";
import type { EmbedResolver } from "./embedResolver";

export const MAX_EMBED_DEPTH = 4;

export interface RenderEmbedCtx {
  resolver: EmbedResolver;
  targetRaw: string;
  chain: string[];
  maxDepth?: number;
}

export function renderEmbedBody(ctx: RenderEmbedCtx): DocumentFragment {
  const frag = document.createDocumentFragment();
  const maxDepth = ctx.maxDepth ?? MAX_EMBED_DEPTH;

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
    if (run.kind === "property_ref") {
      const noteRaw = run.note ?? "";
      host.appendChild(
        document.createTextNode(`[[${noteRaw}.${run.property}]]`),
      );
      continue;
    }
    if (!run.embed) {
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

function reconstructTargetRaw(
  tok: Extract<ReturnType<typeof scanWikilinks>[number], { kind: "wiki_link" }>,
): string {
  if (tok.anchor === null) return tok.target;
  const prefix = tok.anchor.kind === "block" ? "#^" : "#";
  return `${tok.target}${prefix}${tok.anchor.value}`;
}

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
