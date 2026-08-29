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
  get(targetRaw: string): WikiLinkResolution | undefined;
  fetch(targetRaw: string): void;
  resolve(targetRaw: string): Promise<WikiLinkResolution>;
  invalidate(): void;
  markStale(): void;
  onUpdate(handler: () => void): () => void;
  debug(): ResolverDebugState;
  onEvent(handler: (e: ResolverEvent) => void): () => void;
  abort(): void;
}

export function createWikiLinkResolver(
  vaultId: string,
  ipc: (
    req: ResolveLinkRequest,
  ) => Promise<ResolveLinkResponse> = defaultResolveLink,
): WikiLinkResolver {
  const cache = new Map<string, WikiLinkResolution>();
  const stale = new Set<string>();
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
      resolver.fetch(targetRaw);
      return new Promise((resolveFn) => {
        const unsub = resolver.onUpdate(() => {
          const got = cache.get(targetRaw);
          if (got !== undefined) {
            unsub();
            resolveFn(got);
          } else if (!inFlight.has(targetRaw)) {
            resolver.fetch(targetRaw);
          }
        });
      });
    },
    invalidate() {
      cache.clear();
      stale.clear();
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
