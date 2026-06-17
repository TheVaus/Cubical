import { createEffect, createSignal, on, Show, type Component } from "solid-js";

import { getDateFormat, validateDate } from "./dateFormats";
import { inputStyle } from "./styles";

/**
 * Date-valued frontmatter cell (spec §4b). Renders per the resolved
 * `format`:
 *  - `YYYY-MM-DD` → native `<input type=date>`.
 *  - `YYYY`       → numeric year input (commits a number).
 *  - others       → text input validated against the format on commit
 *                   (invalid → reverts to the last committed value).
 * The committed value is written verbatim in the chosen format.
 */
export interface DateCellProps {
  value: string | number;
  format: string;
  onCommit: (next: string | number) => void;
}

const DateCell: Component<DateCellProps> = (props) => {
  const [draft, setDraft] = createSignal(String(props.value ?? ""));
  const [focused, setFocused] = createSignal(false);

  createEffect(
    on(
      () => [props.value, props.format] as const,
      ([v]) => {
        if (!focused()) setDraft(String(v ?? ""));
      },
    ),
  );

  const def = () => getDateFormat(props.format);

  const commit = () => {
    const text = draft().trim();
    const numeric = def()?.numeric ?? false;
    // Empty is allowed (clears the value).
    if (text !== "" && !validateDate(text, props.format)) {
      setDraft(String(props.value ?? ""));
      return;
    }
    const next: string | number = numeric && text !== "" ? Number(text) : text;
    if (next !== props.value) props.onCommit(next);
  };

  return (
    <Show
      when={def()?.native}
      fallback={
        <input
          type="text"
          inputmode={def()?.numeric ? "numeric" : "text"}
          placeholder={def()?.placeholder ?? props.format}
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
      }
    >
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
    </Show>
  );
};

export default DateCell;
