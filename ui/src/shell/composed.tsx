import { splitProps, type Component } from "solid-js";

import BaseEditor, { type EditorProps } from "../Editor";
import BaseExplorerPanel, {
  type ExplorerPanelProps,
  type ExplorerSearchSlot,
} from "../explorer/ExplorerPanel";
import SearchBar from "../sidebar/SearchBar";
import SearchResults from "../sidebar/SearchResults";
import { createSearchState } from "../sidebar/searchState";
import { hasViewer } from "../viewer";
import { editorBlocks } from "./editorBlocks";

export const Editor: Component<EditorProps> = (props) => (
  <BaseEditor {...props} previewBlocks={editorBlocks} />
);

export interface ComposedExplorerProps
  extends Omit<ExplorerPanelProps, "search" | "canView"> {
  onNavigate: (path: string) => void;
}

export const ExplorerPanel: Component<ComposedExplorerProps> = (props) => {
  const [own, panel] = splitProps(props, ["onNavigate"]);
  const state = createSearchState({
    vaultId: () => props.vaultId,
    refreshSignal: () => props.refreshSignal,
  });
  const search: ExplorerSearchSlot = {
    active: state.isSearching,
    bar: () => <SearchBar state={state} />,
    results: () => (
      <SearchResults state={state} onNavigate={(p) => own.onNavigate(p)} />
    ),
  };
  return <BaseExplorerPanel {...panel} canView={hasViewer} search={search} />;
};
