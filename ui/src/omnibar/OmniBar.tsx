import { createEffect, createMemo, createSignal, on, type Component } from "solid-js";
import { matchText, rankItems, type OmniItem, type RankedItem } from "./ranker";
import CommandPalette, {
  type CommandPaletteItem,
} from "@ds/components/overlay/CommandPalette/CommandPalette";
import type { IconName } from "@ds/components/graphics/Icon/Icon";

const RESULT_LIMIT = 50;

export interface OmniBarProps {
  open: boolean;
  items: OmniItem[];
  recentNotes: RankedItem[];
  onClose: () => void;
  onOpenNote: (path: string) => void;
  onOpenTag: (tag: string) => void;
  onRunCommand: (id: string) => void;
}

const iconFor = (item: OmniItem): IconName =>
  item.kind === "tag" ? "hash" : item.kind === "command" ? "command" : "file-text";

const OmniBar: Component<OmniBarProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);

  const results = createMemo<RankedItem[]>(() =>
    query().trim() === ""
      ? props.recentNotes
      : rankItems(query(), props.items, RESULT_LIMIT),
  );

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          setQuery("");
          setSelected(0);
        }
      },
    ),
  );

  createEffect(
    on(results, (r) => {
      if (selected() >= r.length) setSelected(0);
    }),
  );

  const activate = (item: OmniItem) => {
    if (item.kind === "note") props.onOpenNote(item.path);
    else if (item.kind === "tag") props.onOpenTag(item.tag);
    else props.onRunCommand(item.id);
  };

  const paletteItems = createMemo<CommandPaletteItem[]>(() =>
    results().map((r, i) => ({
      id: `omni-opt-${i}`,
      label: matchText(r.item),
      detail: r.item.kind === "note" ? r.item.path : undefined,
      icon: iconFor(r.item),
      matchedIndices: r.matchedIndices,
      onRun: () => activate(r.item),
    })),
  );

  return (
    <CommandPalette
      open={props.open}
      onClose={props.onClose}
      items={paletteItems()}
      query={query()}
      onQueryInput={(value) => {
        setQuery(value);
        setSelected(0);
      }}
      selectedIndex={selected()}
      onSelectedIndexChange={setSelected}
      placeholder="Jump to a note or tag…"
      emptyLabel={
        props.items.length === 0 ? "No notes yet" : "No notes or tags match"
      }
      ariaLabel="Quick switcher"
      inputAriaLabel="Search notes and tags"
      listAriaLabel="Results"
      autoFocus
    />
  );
};

export default OmniBar;
