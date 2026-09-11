import { createMemo, splitProps, type Component } from "solid-js";

import { autocompleteExtensionFor } from "../editor/autocomplete";
import type { AutocompleteProvider } from "../editor/autocompleteProvider";
import { dataviewExtensionFor, type DataviewRunner } from "../editor/dataview";
import BaseEditor, { type EditorProps } from "../editor/Editor";
import { embedExtensionFor } from "../editor/embed";
import type { EmbedResolver } from "../editor/embedResolver";
import BaseExplorerPanel, {
  type ExplorerPanelProps,
  type ExplorerSearchSlot,
} from "../explorer/ExplorerPanel";
import SearchBar from "../search/SearchBar";
import SearchResults from "../search/SearchResults";
import { createSearchState } from "../search/searchState";
import { hasViewer } from "../viewer";
import { editorBlocks } from "./editorBlocks";

export interface ComposedEditorProps
  extends Omit<EditorProps, "previewBlocks" | "blockExtensions"> {
  embedResolver?: EmbedResolver | null;
  openNotePath?: string | null;
  dataviewRunner?: DataviewRunner | null;
  autocompleteProvider?: AutocompleteProvider | null;
}

export const Editor: Component<ComposedEditorProps> = (props) => {
  const [own, base] = splitProps(props, [
    "embedResolver",
    "openNotePath",
    "dataviewRunner",
    "autocompleteProvider",
  ]);
  const embeds = createMemo(() =>
    embedExtensionFor(own.embedResolver ?? null, own.openNotePath ?? null),
  );
  const dataview = createMemo(() =>
    dataviewExtensionFor(own.dataviewRunner ?? null),
  );
  const autocomplete = createMemo(() =>
    autocompleteExtensionFor(own.autocompleteProvider),
  );
  return (
    <BaseEditor
      {...base}
      previewBlocks={editorBlocks}
      blockExtensions={[embeds(), dataview(), autocomplete()]}
    />
  );
};

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
