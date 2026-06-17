import { createSignal, For, Show, type Component } from "solid-js";

import { inputStyle, miniButtonStyle } from "./styles";

/**
 * Enum-valued frontmatter cell (spec §4.2). Two modes:
 *  - **pick**: a `<select>` over the allowed `values`; choosing one
 *    commits it verbatim (numeric-looking values store as numbers).
 *  - **edit**: a comma-separated text input that redefines the allowed
 *    set (`onSetValues`). Shown automatically when no values exist yet,
 *    or via the `✎` affordance.
 */
export interface EnumCellProps {
  value: unknown;
  values: string[];
  onCommit: (next: string | number) => void;
  onSetValues: (values: string[]) => void;
}

/** A value token stores as a number when it looks numeric, else a string. */
function toStored(token: string): string | number {
  const t = token.trim();
  if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  return t;
}

const EnumCell: Component<EnumCellProps> = (props) => {
  const [editing, setEditing] = createSignal(props.values.length === 0);
  const [draft, setDraft] = createSignal(props.values.join(", "));

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
        <input
          type="text"
          placeholder="value1, value2, …"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          ref={(el) => queueMicrotask(() => el.focus())}
          onBlur={commitValues}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          style={inputStyle(true)}
        />
      }
    >
      <div style={{ display: "flex", "align-items": "center", gap: "var(--space-1)" }}>
        <select
          value={String(props.value ?? "")}
          onChange={(e) => props.onCommit(toStored(e.currentTarget.value))}
          style={{ ...inputStyle(false), flex: "1" }}
        >
          <For each={props.values}>
            {(v) => <option value={v}>{v}</option>}
          </For>
        </select>
        <button
          type="button"
          onClick={() => {
            setDraft(props.values.join(", "));
            setEditing(true);
          }}
          aria-label="Edit allowed values"
          title="Edit allowed values"
          style={miniButtonStyle()}
        >
          ✎
        </button>
      </div>
    </Show>
  );
};

export default EnumCell;
