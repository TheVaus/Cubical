import type { ResolvedAnchor } from "../api/ipc";
import type { WikiLinkResolver } from "./wikilinkResolver";

export type WikiLinkClickResult = "navigated" | "offered";

export interface WikiLinkClickContext {
  resolver: WikiLinkResolver;
  onNavigate: (path: string, anchor: ResolvedAnchor | null) => void;
  onOfferCreate: (path: string) => void;
}

export function createPathForTarget(targetRaw: string): string {
  const noAnchor = stripAnchor(targetRaw);
  return noAnchor.endsWith(".md") ? noAnchor : `${noAnchor}.md`;
}

function stripAnchor(targetRaw: string): string {
  const hash = targetRaw.indexOf("#");
  return hash >= 0 ? targetRaw.slice(0, hash) : targetRaw;
}

export async function handleWikiLinkClick(
  targetRaw: string,
  ctx: WikiLinkClickContext,
): Promise<WikiLinkClickResult> {
  const hit = await ctx.resolver.resolve(targetRaw);
  if (hit.target_path !== null) {
    ctx.onNavigate(hit.target_path, hit.anchor);
    return "navigated";
  }
  ctx.onOfferCreate(createPathForTarget(targetRaw));
  return "offered";
}
