/**
 * Per-vault wiki-link resolution cache (L3 Session B, spec §2.2;
 * extended in L4-A-fix Contract 4a).
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
 *
 * **Contract 4a (L4-A-fix) additions.**
 *   - `debug()` returns a snapshot of cache + in-flight + last-fetch
 *     timestamps + last-error map for diagnostic.
 *   - `onEvent` emits granular events (`fetch-started`,
 *     `fetch-settled`, `fetch-errored`, `invalidate`, `abort`) so the
 *     operator + future dev panels can trace async behavior.
 *   - `abort()` cancels in-flight fetches at the cache-write side
 *     (the underlying IPC keeps running on the Rust side; the
 *     response is discarded). Used at vault swap; lays the pattern
 *     for L6 plugin sandbox async cancellation.
 *
 * The observability types (`ResolverDebugState`, `ResolverEvent`) are
 * single-sourced in `embedResolver.ts` and re-used here so both
 * resolvers expose a symmetric interface.
 */

import type { ResolverDebugState, ResolverEvent } from "./embedResolver";
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
  /**
   * Awaitable lookup. Resolves to the cached entry, kicking off a fetch
   * first if the cache is cold and awaiting any in-flight fetch.
   * Used by the click router so a first-click on a not-yet-resolved
   * wiki-link still navigates (rather than being thrown away pending).
   */
  resolve(targetRaw: string): Promise<WikiLinkResolution>;
  /** Drop the entire cache and notify subscribers. */
  invalidate(): void;
  /** Subscribe to cache-change notifications. Returns unsubscribe. */
  onUpdate(handler: () => void): () => void;
  /** Snapshot of resolver state (Contract 4a). */
  debug(): ResolverDebugState;
  /** Subscribe to granular resolver events (Contract 4a). */
  onEvent(handler: (e: ResolverEvent) => void): () => void;
  /** Abort in-flight fetches; cache + subscribers untouched (Contract 4a). */
  abort(): void;
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
  const inFlight = new Map<string, { aborted: boolean }>();
  const subscribers = new Set<() => void>();
  const eventSubscribers = new Set<(e: ResolverEvent) => void>();
  const lastFetchAt = new Map<string, number>();
  const lastSettleAt = new Map<string, number>();
  const lastError = new Map<string, string>();

  const notify = () => {
    for (const fn of subscribers) fn();
  };

  const emit = (e: ResolverEvent) => {
    for (const fn of eventSubscribers) fn(e);
  };

  const resolver: WikiLinkResolver = {
    get(targetRaw) {
      return cache.get(targetRaw);
    },
    fetch(targetRaw) {
      if (cache.has(targetRaw) || inFlight.has(targetRaw)) return;
      const handle = { aborted: false };
      inFlight.set(targetRaw, handle);
      const startedAt = Date.now();
      lastFetchAt.set(targetRaw, startedAt);
      emit({ kind: "fetch-started", key: targetRaw, at: startedAt });
      ipc({ vault_id: vaultId, target_raw: targetRaw })
        .then((resp) => {
          if (handle.aborted) return;
          cache.set(targetRaw, {
            target_path: resp.target_path,
            anchor: resp.anchor,
          });
          lastError.delete(targetRaw);
          const at = Date.now();
          lastSettleAt.set(targetRaw, at);
          emit({ kind: "fetch-settled", key: targetRaw, at });
        })
        .catch((err: unknown) => {
          if (handle.aborted) return;
          // Cache the failure as "unresolved" so we don't re-fire.
          cache.set(targetRaw, { target_path: null, anchor: null });
          const msg = err instanceof Error ? err.message : String(err);
          lastError.set(targetRaw, msg);
          const at = Date.now();
          lastSettleAt.set(targetRaw, at);
          emit({
            kind: "fetch-errored",
            key: targetRaw,
            error: msg,
            at,
          });
        })
        .finally(() => {
          inFlight.delete(targetRaw);
          if (!handle.aborted) notify();
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
          const got = cache.get(targetRaw);
          if (got !== undefined) {
            unsub();
            resolveFn(got);
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
      lastError.clear();
      // Don't clear inFlight — those promises will overwrite stale
      // entries when they resolve, which is harmless.
      emit({ kind: "invalidate", at: Date.now() });
      notify();
    },
    onUpdate(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    debug() {
      return {
        cacheSize: cache.size,
        inFlight: [...inFlight.keys()],
        lastFetchAt: new Map(lastFetchAt),
        lastSettleAt: new Map(lastSettleAt),
        lastError: new Map(lastError),
      };
    },
    onEvent(handler) {
      eventSubscribers.add(handler);
      return () => {
        eventSubscribers.delete(handler);
      };
    },
    abort() {
      const at = Date.now();
      for (const [key, handle] of inFlight.entries()) {
        handle.aborted = true;
        emit({ kind: "abort", key, at });
      }
      inFlight.clear();
      notify();
    },
  };
  return resolver;
}
