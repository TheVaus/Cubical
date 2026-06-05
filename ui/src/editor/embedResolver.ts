/**
 * Per-vault embed resolution cache (L3 Session H.2, spec §2.8;
 * extended in L4-A-fix Contract 4a).
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

/** Snapshot of resolver state for diagnostic / dev-tools inspection. */
export interface ResolverDebugState {
  cacheSize: number;
  inFlight: string[];
  lastFetchAt: Map<string, number>;
  lastSettleAt: Map<string, number>;
  lastError: Map<string, string>;
}

/** One event in the resolver's audit stream. */
export interface ResolverEvent {
  kind:
    | "fetch-started"
    | "fetch-settled"
    | "fetch-errored"
    | "invalidate"
    | "abort";
  key?: string;
  error?: string;
  at: number;
}

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
  /** Snapshot of resolver state (Contract 4a). */
  debug(): ResolverDebugState;
  /** Subscribe to granular resolver events (Contract 4a). */
  onEvent(handler: (e: ResolverEvent) => void): () => void;
  /** Abort in-flight fetches; cache + subscribers untouched (Contract 4a). */
  abort(): void;
}

export function createEmbedResolver(
  vaultId: string,
  ipc: (req: GetEmbedRequest) => Promise<GetEmbedResponse> = defaultGetEmbed,
): EmbedResolver {
  const cache = new Map<string, EmbedResolution>();
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

  const resolver: EmbedResolver = {
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
          cache.set(targetRaw, resp);
          lastError.delete(targetRaw);
          const at = Date.now();
          lastSettleAt.set(targetRaw, at);
          emit({ kind: "fetch-settled", key: targetRaw, at });
        })
        .catch((err: unknown) => {
          if (handle.aborted) return;
          cache.set(targetRaw, UNRESOLVED);
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
      lastError.clear();
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
    },
  };

  return resolver;
}
