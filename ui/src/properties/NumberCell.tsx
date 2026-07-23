import { createEffect, createSignal, on, type Component } from "solid-js";

import TextInput from "@ds/components/forms/TextInput/TextInput";

import { truncateInt } from "./format";

export interface NumberCellProps {
  value: number;
  onCommit: (next: number) => void;
  integer?: boolean;
}

const NumberCell: Component<NumberCellProps> = (props) => {
  const [draft, setDraft] = createSignal(String(props.value));
  const [focused, setFocused] = createSignal(false);

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
    const final = props.integer ? truncateInt(parsed) : parsed;
    if (final !== props.value) props.onCommit(final);
    setDraft(String(final));
  };

  let input!: HTMLInputElement;

  return (
    <TextInput
      ref={(el) => (input = el)}
      size="sm"
      inputMode="decimal"
      value={draft()}
      onInput={setDraft}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") input.blur();
      }}
    />
  );
};

export default NumberCell;
