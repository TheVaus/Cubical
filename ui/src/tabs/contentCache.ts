import { produce, type SetStoreFunction } from "solid-js/store";

export type ContentCache = Record<string, string>;

export function staleContentIds(
  cached: ContentCache,
  keep: (id: string) => boolean,
): string[] {
  return Object.keys(cached).filter((id) => !keep(id));
}

export function pruneContents(
  set: SetStoreFunction<ContentCache>,
  cached: ContentCache,
  keep: (id: string) => boolean,
): void {
  const drop = staleContentIds(cached, keep);
  if (drop.length === 0) return;
  set(
    produce((c: ContentCache) => {
      for (const id of drop) delete c[id];
    }),
  );
}
