import {
  getProperty as defaultGetProperty,
  type GetPropertyRequest,
  type GetPropertyResponse,
} from "../api/ipc";

const UNRESOLVED: GetPropertyResponse = { kind: "note_unresolved", value: null };

const cacheKey = (note: string, property: string) => `${note} ${property}`;

export interface PropertyResolver {
  get(note: string, property: string): GetPropertyResponse | undefined;
  fetch(note: string, property: string): void;
  resolve(note: string, property: string): Promise<GetPropertyResponse>;
  invalidate(): void;
  markStale(): void;
  onUpdate(handler: () => void): () => void;
  version(): number;
}

export function createPropertyResolver(
  vaultId: string,
  ipc: (req: GetPropertyRequest) => Promise<GetPropertyResponse> = defaultGetProperty,
): PropertyResolver {
  const cache = new Map<string, GetPropertyResponse>();
  const stale = new Set<string>();
  const inFlight = new Set<string>();
  const subscribers = new Set<() => void>();
  let cacheVersion = 0;

  const notify = () => {
    for (const fn of subscribers) fn();
  };

  const resolver: PropertyResolver = {
    get(note, property) {
      const k = cacheKey(note, property);
      if (stale.has(k)) resolver.fetch(note, property);
      return cache.get(k);
    },
    fetch(note, property) {
      const k = cacheKey(note, property);
      if ((cache.has(k) && !stale.has(k)) || inFlight.has(k)) return;
      stale.delete(k);
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
            resolver.fetch(note, property);
          }
        });
      });
    },
    invalidate() {
      cache.clear();
      stale.clear();
      cacheVersion++;
      notify();
    },
    markStale() {
      if (cache.size === 0) return;
      for (const k of cache.keys()) stale.add(k);
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
