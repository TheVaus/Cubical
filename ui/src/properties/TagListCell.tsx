import { type Component } from "solid-js";

import ChipList from "./ChipList";

/**
 * Tag-list frontmatter cell (L2 Session F, spec §2.4) — a chip row
 * where each chip is `#`-prefixed and accent-colored.
 *
 * No tag autocomplete in L2; tag indexing and autocomplete are L3.
 */
export interface TagListCellProps {
  value: string[];
  onCommit: (next: string[]) => void;
}

const TagListCell: Component<TagListCellProps> = (props) => {
  return (
    <ChipList value={props.value} isTag={true} onCommit={props.onCommit} />
  );
};

export default TagListCell;
