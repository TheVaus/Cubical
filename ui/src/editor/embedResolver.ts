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

export interface EmbedResolver {
  get(targetRaw: string): EmbedResolution | undefined;
  fetch(targetRaw: string): void;
  resolve(targetRaw: string): Promise<EmbedResolution>;
  invalidate(): void;
  markStale(): void;
  onUpdate(handler: () => void): () => void;
  version(): number;
  debug(): ResolverDebugState;
  onEvent(handler: (e: ResolverEvent) => void): () => void;
  abort(): void;
}

export function createEmbedResolver(
  vaultId: string,
  ipc: (req: GetEmbedRequest) => Promise<GetEmbedResponse> = defaultGetEmbed,
): EmbedResolver {
  const cache = new Map<string, EmbedResolution>();
  const stale = new Set<string>();
  const inFlight = new Map<string, { aborted: boolean }>();
  const subscribers = new Set<() => void>();
  const eventSubscribers = new Set<(e: ResolverEvent) => void>();
  const lastFetchAt = new Map<string, number>();
  const lastSettleAt = new Map<string, number>();
  const lastError = new Map<string, string>();
  let cacheVersion = 0;

  const notify = () => {
    for (const fn of subscribers) fn();
  };

  const emit = (e: ResolverEvent) => {
    for (const fn of eventSubscribers) fn(e);
  };

  const resolver: EmbedResolver = {
    get(targetRaw) {
      if (stale.has(targetRaw)) resolver.fetch(targetRaw);
      return cache.get(targetRaw);
    },
    fetch(targetRaw) {
      if ((cache.has(targetRaw) && !stale.has(targetRaw)) || inFlight.has(targetRaw)) {
        return;
      }
      stale.delete(targetRaw);
      const handle = { aborted: false };
      inFlight.set(targetRaw, handle);
      const startedAt = Date.now();
      lastFetchAt.set(targetRaw, startedAt);
      emit({ kind: "fetch-started", key: targetRaw, at: startedAt });
      ipc({ vault_id: vaultId, target_raw: targetRaw })
        .then((resp) => {
          if (handle.aborted) return;
          cache.set(targetRaw, resp);
          cacheVersion++;
          lastError.delete(targetRaw);
          const at = Date.now();
          lastSettleAt.set(targetRaw, at);
          emit({ kind: "fetch-settled", key: targetRaw, at });
        })
        .catch((err: unknown) => {
          if (handle.aborted) return;
          cache.set(targetRaw, UNRESOLVED);
          cacheVersion++;
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
      resolver.fetch(targetRaw);
      return new Promise((resolveFn) => {
        const unsub = resolver.onUpdate(() => {
          const entry = cache.get(targetRaw);
          if (entry !== undefined) {
            unsub();
            resolveFn(entry);
          } else if (!inFlight.has(targetRaw)) {
            resolver.fetch(targetRaw);
          }
        });
      });
    },
    invalidate() {
      cache.clear();
      stale.clear();
      cacheVersion++;
      lastError.clear();
      emit({ kind: "invalidate", at: Date.now() });
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
