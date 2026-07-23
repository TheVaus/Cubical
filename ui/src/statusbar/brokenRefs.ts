import type { BrokenBlockRef } from "../api/ipc";

export interface BrokenRefsDisplay {
  label: string;
  title: string;
}

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
