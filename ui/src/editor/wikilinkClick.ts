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
