export interface ResolverDebugState {
  cacheSize: number;
  inFlight: string[];
  lastFetchAt: Map<string, number>;
  lastSettleAt: Map<string, number>;
  lastError: Map<string, string>;
}

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

export interface KeyedResolver<K, V> {
  get(key: K): V | undefined;
  fetch(key: K): void;
  resolve(key: K): Promise<V>;
  invalidate(): void;
  markStale(): void;
  onUpdate(handler: () => void): () => void;
  version(): number;
  debug(): ResolverDebugState;
  onEvent(handler: (e: ResolverEvent) => void): () => void;
  abort(): void;
}

export interface KeyedResolverSpec<K, V> {
  cacheKey: (key: K) => string;
  load: (key: K) => Promise<V>;
  onFailure: (err: unknown) => V;
  invalidation?: "clear" | "refetch";
  same?: (a: V, b: V) => boolean;
}

function isolated(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error("resolver subscriber failed", e);
  }
}

export function createKeyedResolver<K, V>(
  spec: KeyedResolverSpec<K, V>,
): KeyedResolver<K, V> {
  const cache = new Map<string, V>();
  const stale = new Set<string>();
  const sources = new Map<string, K>();
  const inFlight = new Map<string, { aborted: boolean }>();
  const subscribers = new Set<() => void>();
  const eventSubscribers = new Set<(e: ResolverEvent) => void>();
  const lastFetchAt = new Map<string, number>();
  const lastSettleAt = new Map<string, number>();
  const lastError = new Map<string, string>();
  const refetches = spec.invalidation === "refetch";
  let cacheVersion = 0;

  const notify = () => {
    for (const fn of [...subscribers]) isolated(fn);
  };

  const emit = (e: ResolverEvent) => {
    for (const fn of [...eventSubscribers]) isolated(() => fn(e));
  };

  const store = (k: string, value: V, force: boolean): boolean => {
    const prev = cache.get(k);
    const changed =
      force || prev === undefined || !spec.same || !spec.same(prev, value);
    cache.set(k, value);
    if (changed) cacheVersion++;
    return changed;
  };

  const run = (key: K, force: boolean) => {
    const k = spec.cacheKey(key);
    const handle = { aborted: false };
    inFlight.set(k, handle);
    sources.set(k, key);
    const startedAt = Date.now();
    lastFetchAt.set(k, startedAt);
    emit({ kind: "fetch-started", key: k, at: startedAt });
    let changed = false;
    spec
      .load(key)
      .then((value) => {
        if (handle.aborted) return;
        changed = store(k, value, force);
        lastError.delete(k);
        const at = Date.now();
        lastSettleAt.set(k, at);
        emit({ kind: "fetch-settled", key: k, at });
      })
      .catch((err: unknown) => {
        if (handle.aborted) return;
        changed = store(k, spec.onFailure(err), force);
        const message = err instanceof Error ? err.message : String(err);
        lastError.set(k, message);
        const at = Date.now();
        lastSettleAt.set(k, at);
        emit({ kind: "fetch-errored", key: k, error: message, at });
      })
      .finally(() => {
        inFlight.delete(k);
        if (!handle.aborted && changed) notify();
      });
  };

  const resolver: KeyedResolver<K, V> = {
    get(key) {
      const k = spec.cacheKey(key);
      if (stale.has(k)) resolver.fetch(key);
      return cache.get(k);
    },
    fetch(key) {
      const k = spec.cacheKey(key);
      const cached = cache.has(k);
      if ((cached && !stale.has(k)) || inFlight.has(k)) return;
      stale.delete(k);
      run(key, !cached);
    },
    resolve(key) {
      const k = spec.cacheKey(key);
      const hit = cache.get(k);
      if (hit !== undefined) return Promise.resolve(hit);
      resolver.fetch(key);
      return new Promise((settle) => {
        const unsub = resolver.onUpdate(() => {
          const entry = cache.get(k);
          if (entry !== undefined) {
            unsub();
            settle(entry);
          } else if (!inFlight.has(k)) {
            resolver.fetch(key);
          }
        });
      });
    },
    invalidate() {
      emit({ kind: "invalidate", at: Date.now() });
      stale.clear();
      if (refetches) {
        for (const [k, key] of [...sources]) {
          if (inFlight.has(k) || !cache.has(k)) continue;
          run(key, false);
        }
        return;
      }
      cache.clear();
      sources.clear();
      lastError.clear();
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
