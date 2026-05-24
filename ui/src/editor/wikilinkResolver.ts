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
  ipc: (
    req: ResolveLinkRequest,
  ) => Promise<ResolveLinkResponse> = defaultResolveLink,
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
