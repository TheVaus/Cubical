import { type Component } from "solid-js";

import ChipList from "./ChipList";

/**
 * String-list frontmatter cell (spec §4.4) — a chip row. Items whose
 * stored value starts with `#` render as tag chips; when `onNavigateTag`
 * is set they click through to that tag's page.
 */
export interface StringListCellProps {
  value: string[];
  onCommit: (next: string[]) => void;
  /** When true, every item renders as a tag chip (the `tags` property). */
  allTags?: boolean;
  /** Optional — clicking a `#`-chip opens that tag's page (L3). */
  onNavigateTag?: (tagPath: string) => void;
}

const StringListCell: Component<StringListCellProps> = (props) => {
  return (
    <ChipList
      value={props.value}
      allTags={props.allTags ?? false}
      onCommit={props.onCommit}
      {...(props.onNavigateTag ? { onChipClick: props.onNavigateTag } : {})}
    />
  );
};

export default StringListCell;
