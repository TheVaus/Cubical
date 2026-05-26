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

export type WikiLinkClickResult = "navigated" | "offered";

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
 * Route a click on a wiki-link. Async because the resolver may need
 * to fetch the target's resolution on a cold cache — the click
 * router awaits it so a first-click on a not-yet-resolved wiki-link
 * still navigates (rather than being thrown away as "pending"). A
 * cache hit settles synchronously on the same microtask.
 */
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
