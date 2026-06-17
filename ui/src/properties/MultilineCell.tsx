import { createEffect, createSignal, on, type Component } from "solid-js";

import { inputStyle } from "./styles";

/**
 * Multiline-text frontmatter cell (spec §8). A `<textarea>` that commits
 * on blur (Enter inserts a newline). Stores a plain string; the
 * serializer renders multi-line strings as YAML block scalars.
 */
export interface MultilineCellProps {
  value: string;
  onCommit: (next: string) => void;
}

const MultilineCell: Component<MultilineCellProps> = (props) => {
  const [draft, setDraft] = createSignal(props.value);
  const [focused, setFocused] = createSignal(false);

  createEffect(
    on(
      () => props.value,
      (v) => {
        if (!focused()) setDraft(v);
      },
    ),
  );

  const commit = () => {
    if (draft() !== props.value) props.onCommit(draft());
  };

  return (
    <textarea
      rows={3}
      value={draft()}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      style={{ ...inputStyle(focused()), resize: "vertical" }}
    />
  );
};

export default MultilineCell;
