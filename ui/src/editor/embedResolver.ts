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
      // Kick the fetch if not already in flight, then await the next
      // notify carrying our entry. `invalidate()` can land between
      // notifies — the subscriber simply keeps waiting until the
      // entry appears (the in-flight fetch, or the next one if we
      // were invalidated mid-flight, will fill it).
      resolver.fetch(targetRaw);
      return new Promise((resolveFn) => {
        const unsub = resolver.onUpdate(() => {
          const entry = cache.get(targetRaw);
          if (entry !== undefined) {
            unsub();
            resolveFn(entry);
          } else if (!inFlight.has(targetRaw)) {
            // Cache miss AND no fetch in flight (an `invalidate()`
            // cleared us). Kick a fresh one and keep waiting.
            resolver.fetch(targetRaw);
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
