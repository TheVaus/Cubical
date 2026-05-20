import { createEffect, createSignal, on, type Component } from "solid-js";

import { inputStyle } from "./styles";

/**
 * Number-valued frontmatter cell (L2 Session F, spec §2.4).
 *
 * Commits a parsed number on blur or Enter. An empty or non-numeric
 * draft is rejected — the cell reverts to the last committed value
 * rather than writing `NaN` into the frontmatter.
 */
export interface NumberCellProps {
  value: number;
  onCommit: (next: number) => void;
}

const NumberCell: Component<NumberCellProps> = (props) => {
  const [draft, setDraft] = createSignal(String(props.value));
  const [focused, setFocused] = createSignal(false);

  // Adopt external value changes only — see StringCell for the
  // rationale (the focus-change re-run would revert the draft).
  createEffect(
    on(
      () => props.value,
      (v) => {
        if (!focused()) setDraft(String(v));
      },
    ),
  );

  const commit = () => {
    const text = draft().trim();
    const parsed = Number(text);
    if (text === "" || !Number.isFinite(parsed)) {
      setDraft(String(props.value));
      return;
    }
    if (parsed !== props.value) props.onCommit(parsed);
  };

  return (
    <input
      type="text"
      inputmode="decimal"
      value={draft()}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      style={inputStyle(focused())}
    />
  );
};

export default NumberCell;
