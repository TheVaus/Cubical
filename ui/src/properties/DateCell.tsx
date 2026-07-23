import { createEffect, createSignal, on, Show, type Component } from "solid-js";

import DatePicker from "@ds/components/forms/DatePicker/DatePicker";
import TextInput from "@ds/components/forms/TextInput/TextInput";

import { getDateFormat, validateDate } from "./dateFormats";

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

  let inputEl!: HTMLInputElement;

  const def = () => getDateFormat(props.format);
  const widget = () => def()?.widget ?? "text";

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
            <TextInput
              ref={(el) => (inputEl = el)}
              size="sm"
              inputMode={widget() === "number" ? "numeric" : "text"}
              placeholder={def()?.placeholder ?? props.format}
              value={draft()}
              onInput={setDraft}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false);
                commit(draft());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") inputEl.blur();
              }}
            />
          }
        >
          <DatePicker
            type="date"
            size="sm"
            value={draft()}
            onInput={(v) => setDraft(v)}
            onChange={() => commit(draft())}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              commit(draft());
            }}
            ariaLabel="Date"
          />
        </Show>
      }
    >
      <DatePicker
        type="datetime-local"
        size="sm"
        value={toInput(draft())}
        onInput={(v) => setDraft(fromInput(v))}
        onChange={() => commit(draft())}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit(draft());
        }}
        ariaLabel="Date and time"
      />
    </Show>
  );
};

export default DateCell;
