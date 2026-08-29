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

export function remapContentKeys(
  set: SetStoreFunction<ContentCache>,
  cached: ContentCache,
  rename: (id: string) => string,
): void {
  const moves = Object.keys(cached)
    .map((from) => ({ from, to: rename(from) }))
    .filter((m) => m.to !== m.from);
  if (moves.length === 0) return;
  set(
    produce((c: ContentCache) => {
      for (const { from, to } of moves) {
        if (!(to in c)) c[to] = c[from]!;
        delete c[from];
      }
    }),
  );
}
