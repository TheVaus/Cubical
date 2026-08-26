import { For, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import TextInput from "@ds/components/forms/TextInput/TextInput";
import Toggle from "@ds/components/forms/Toggle/Toggle";

import { ALL_KINDS, DEFAULT_FILTER, type GraphViewFilter } from "./graphModel";

const KIND_LABELS: Record<(typeof ALL_KINDS)[number], string> = {
  note: "Notes",
  attachment: "Attachments",
  tag: "Tags",
  ghost: "Unresolved",
};

export function GraphFilters(props: {
  filter: () => GraphViewFilter;
  setFilter: (next: GraphViewFilter) => void;
  visible: () => number;
  total: () => number;
}): JSXElement {
  const setKind = (kind: (typeof ALL_KINDS)[number], on: boolean) =>
    props.setFilter({
      ...props.filter(),
      kinds: { ...props.filter().kinds, [kind]: on },
    });

  return (
    <div class="graph__filters" role="group" aria-label="Graph filters">
      <For each={ALL_KINDS}>
        {(kind) => (
          <Toggle
            label={KIND_LABELS[kind]}
            showLabel
            checked={props.filter().kinds[kind]}
            onChange={(on) => setKind(kind, on)}
          />
        )}
      </For>
      <div class="graph__filters-scope">
        <TextInput
          value={props.filter().scope}
          onInput={(scope) => props.setFilter({ ...props.filter(), scope })}
          placeholder="Scope to a path or tag…"
        />
      </div>
      <span class="graph__filters-count">
        {props.visible()} of {props.total()}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => props.setFilter(DEFAULT_FILTER)}
      >
        Reset
      </Button>
    </div>
  );
}
