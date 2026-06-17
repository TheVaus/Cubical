import { createEffect, createSignal, on, Show, type Component } from "solid-js";

import { getDateFormat, validateDate } from "./dateFormats";
import { inputStyle } from "./styles";

/**
 * Date-valued frontmatter cell (spec §4.3). Renders per the resolved
 * `format`'s widget:
 *  - `date`     → native `<input type=date>` (YYYY-MM-DD).
 *  - `datetime` → native `<input type=datetime-local>`; the wire uses a
 *                 `T` separator, the stored value a space (`YYYY-MM-DD HH:MM`).
 *  - `number`   → year input (commits a number).
 *  - `text`     → text input validated against the format on commit
 *                 (invalid → reverts to the last committed value).
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
  const widget = () => def()?.widget ?? "text";

  // `datetime-local` uses `T`; the stored value uses a space separator.
  const toInput = (stored: string): string => stored.replace(" ", "T");
  const fromInput = (input: string): string => input.replace("T", " ");

  const commit = (rawText: string) => {
    const text = rawText.trim();
    if (text !== "" && !validateDate(text, props.format)) {
      setDraft(String(props.value ?? ""));
      return;
    }
    const next: string | number =
      widget() === "number" && text !== "" ? Number(text) : text;
    if (next !== props.value) props.onCommit(next);
  };

  return (
    <Show
      when={widget() === "datetime"}
      fallback={
        <Show
          when={widget() === "date"}
          fallback={
            <input
              type="text"
              inputmode={widget() === "number" ? "numeric" : "text"}
              placeholder={def()?.placeholder ?? props.format}
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false);
                commit(draft());
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
            onChange={() => commit(draft())}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              commit(draft());
            }}
            style={inputStyle(focused())}
          />
        </Show>
      }
    >
      <input
        type="datetime-local"
        value={toInput(draft())}
        onInput={(e) => setDraft(fromInput(e.currentTarget.value))}
        onChange={() => commit(draft())}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit(draft());
        }}
        style={inputStyle(focused())}
      />
    </Show>
  );
};

export default DateCell;
