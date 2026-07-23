import { createSignal, Show, type Component } from "solid-js";

import IconButton from "@ds/components/forms/IconButton/IconButton";
import Select from "@ds/components/forms/Select/Select";
import TextInput from "@ds/components/forms/TextInput/TextInput";
import Icon from "@ds/components/graphics/Icon/Icon";

export interface EnumCellProps {
  value: unknown;
  values: string[];
  onCommit: (next: string | number) => void;
  onSetValues: (values: string[]) => void;
}

function toStored(token: string): string | number {
  const t = token.trim();
  if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  return t;
}

const EnumCell: Component<EnumCellProps> = (props) => {
  const [editing, setEditing] = createSignal(props.values.length === 0);
  const [draft, setDraft] = createSignal(props.values.join(", "));

  let input!: HTMLInputElement;

  const commitValues = () => {
    const next = draft()
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
    setEditing(false);
    props.onSetValues(next);
  };

  return (
    <Show
      when={!editing()}
      fallback={
        <TextInput
          ref={(el) => {
            input = el;
            queueMicrotask(() => el.focus());
          }}
          size="sm"
          placeholder="value1, value2, …"
          value={draft()}
          onInput={setDraft}
          onBlur={commitValues}
          onKeyDown={(e) => {
            if (e.key === "Enter") input.blur();
          }}
        />
      }
    >
      <div style={{ display: "flex", "align-items": "center", gap: "var(--space-1)" }}>
        <Select
          options={props.values.map((v) => ({ value: v }))}
          value={String(props.value ?? "")}
          onChange={(v) => props.onCommit(toStored(v))}
          size="sm"
          ariaLabel="Value"
          style={{ flex: "1" }}
        />
        <IconButton
          label="Edit allowed values"
          size="sm"
          onClick={() => {
            setDraft(props.values.join(", "));
            setEditing(true);
          }}
        >
          <Icon name="edit" />
        </IconButton>
      </div>
    </Show>
  );
};

export default EnumCell;
