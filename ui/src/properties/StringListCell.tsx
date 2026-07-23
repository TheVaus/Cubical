import { type Component } from "solid-js";

import ChipList from "./ChipList";

export interface StringListCellProps {
  value: string[];
  onCommit: (next: string[]) => void;
  allTags?: boolean;
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
