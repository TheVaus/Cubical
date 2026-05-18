import { type Component } from "solid-js";

import ChipList from "./ChipList";

/**
 * String-list frontmatter cell (L2 Session F, spec §2.4) — a plain
 * chip row. Tag-styled lists use `TagListCell` instead.
 */
export interface StringListCellProps {
  value: string[];
  onCommit: (next: string[]) => void;
}

const StringListCell: Component<StringListCellProps> = (props) => {
  return (
    <ChipList value={props.value} isTag={false} onCommit={props.onCommit} />
  );
};

export default StringListCell;
