import { createEffect, createSignal, type Component } from "solid-js";

import { inputStyle } from "./styles";

/**
 * Date-valued frontmatter cell (L2 Session F, spec §2.4).
 *
 * A native `<input type="date">` — its value format is already
 * `YYYY-MM-DD`, which commits straight back as a YAML plain scalar.
 * While focused, incoming `value` changes are ignored so an AST tick
 * cannot clobber an in-progress edit (decision (d)).
 */
export interface DateCellProps {
  value: string;
  onCommit: (next: string) => void;
}

const DateCell: Component<DateCellProps> = (props) => {
  const [draft, setDraft] = createSignal(props.value);
  const [focused, setFocused] = createSignal(false);

  createEffect(() => {
    const v = props.value;
    if (!focused()) setDraft(v);
  });

  const commit = () => {
    if (draft() !== props.value) props.onCommit(draft());
  };

  return (
    <input
      type="date"
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

export default DateCell;
