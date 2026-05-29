import type { BrokenBlockRef } from "../api/ipc";

export interface BrokenRefsDisplay {
  /** Footer label, e.g. "⚠ 2 broken block refs". */
  label: string;
  /** Tooltip: one "source → target#^id" line per ref. */
  title: string;
}

/**
 * Footer display for broken block refs, or `null` when there are none
 * (so the caller renders nothing). Pure — the visual wiring lives in
 * `App.tsx`. See `docs/layer-3-spec.md` §9.9.
 */
export function formatBrokenBlockRefs(
  refs: BrokenBlockRef[],
): BrokenRefsDisplay | null {
  if (refs.length === 0) return null;
  const noun = refs.length === 1 ? "broken block ref" : "broken block refs";
  const label = `⚠ ${refs.length} ${noun}`;
  const title = refs
    .map(
      (r) =>
        `${r.source_file_path} → ${r.target_file_path}#^${r.target_block_id}`,
    )
    .join("\n");
  return { label, title };
}
