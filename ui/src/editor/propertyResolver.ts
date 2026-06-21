/**
 * Per-vault cross-file property-reference resolver.
 *
 * A small in-memory store over the `get_property` IPC, mirroring the
 * embed resolver (`embedResolver.ts`) but keyed on a composite
 * `"<note> <property>"` cache key. Each editor session gets one resolver
 * bound to the open vault; it caches answers, dedupes concurrent fetches,
 * notifies subscribers on change, and exposes a monotonic `version()` that
 * editor widgets fold into their CM6 identity so a settled fetch forces a
 * remount.
 *
 * Self-references (`[[.prop]]`) never reach this resolver — they are read
 * synchronously from the open document's own frontmatter by the widget.
 *
 * A rejected fetch caches a `note_unresolved` entry so a failing target
 * does not re-enter the IPC on every decoration rebuild.
 */

import {
  getProperty as defaultGetProperty,
  type GetPropertyRequest,
  type GetPropertyResponse,
} from "../api/ipc";

const UNRESOLVED: GetPropertyResponse = { kind: "note_unresolved", value: null };

const cacheKey = (note: string, property: string) => `${note} ${property}`;

export interface PropertyResolver {
  /** Sync lookup. Returns `undefined` for entries not yet fetched. */
  get(note: string, property: string): GetPropertyResponse | undefined;
  /** Kick off (or skip if already pending/cached) an async fetch. */
  fetch(note: string, property: string): void;
  /** Awaitable lookup. Resolves to the cached entry, fetching if cold. */
  resolve(note: string, property: string): Promise<GetPropertyResponse>;
  /** Drop the entire cache and notify subscribers. */
  invalidate(): void;
  /** Subscribe to cache-change notifications. Returns unsubscribe. */
  onUpdate(handler: () => void): () => void;
  /** Monotonic counter bumped on every cache mutation. */
  version(): number;
}

export function createPropertyResolver(
  vaultId: string,
  ipc: (req: GetPropertyRequest) => Promise<GetPropertyResponse> = defaultGetProperty,
): PropertyResolver {
  const cache = new Map<string, GetPropertyResponse>();
  const inFlight = new Set<string>();
  const subscribers = new Set<() => void>();
  let cacheVersion = 0;

  const notify = () => {
    for (const fn of subscribers) fn();
  };

  const resolver: PropertyResolver = {
    get(note, property) {
      return cache.get(cacheKey(note, property));
    },
    fetch(note, property) {
      const k = cacheKey(note, property);
      if (cache.has(k) || inFlight.has(k)) return;
      inFlight.add(k);
      ipc({ vault_id: vaultId, note_raw: note, property })
        .then((resp) => {
          cache.set(k, resp);
          cacheVersion++;
        })
        .catch(() => {
          cache.set(k, UNRESOLVED);
          cacheVersion++;
        })
        .finally(() => {
          inFlight.delete(k);
          notify();
        });
    },
    resolve(note, property) {
      const k = cacheKey(note, property);
      const hit = cache.get(k);
      if (hit !== undefined) return Promise.resolve(hit);
      resolver.fetch(note, property);
      return new Promise((resolveFn) => {
        const unsub = resolver.onUpdate(() => {
          const entry = cache.get(k);
          if (entry !== undefined) {
            unsub();
            resolveFn(entry);
          } else if (!inFlight.has(k)) {
            // Cache miss and nothing in flight (an `invalidate()` cleared
            // us). Kick a fresh fetch and keep waiting.
            resolver.fetch(note, property);
          }
        });
      });
    },
    invalidate() {
      cache.clear();
      cacheVersion++;
      notify();
    },
    onUpdate(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    version() {
      return cacheVersion;
    },
  };

  return resolver;
}
