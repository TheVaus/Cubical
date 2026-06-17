import { createEffect, createSignal, on, type Component } from "solid-js";

import { normalizeDateTime } from "./format";
import { inputStyle } from "./styles";

/**
 * Datetime-valued frontmatter cell (spec §8). A native
 * `<input type="datetime-local">`; value format `YYYY-MM-DDThh:mm` is
 * stored verbatim as a YAML plain scalar.
 */
export interface DateTimeCellProps {
  value: string;
  onCommit: (next: string) => void;
}

const DateTimeCell: Component<DateTimeCellProps> = (props) => {
  const [draft, setDraft] = createSignal(normalizeDateTime(props.value));
  const [focused, setFocused] = createSignal(false);

  createEffect(
    on(
      () => props.value,
      (v) => {
        if (!focused()) setDraft(normalizeDateTime(v));
      },
    ),
  );

  const commit = () => {
    if (draft() !== props.value) props.onCommit(draft());
  };

  return (
    <input
      type="datetime-local"
      value={draft()}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onChange={commit}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      style={inputStyle(focused())}
    />
  );
};

export default DateTimeCell;
