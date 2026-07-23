import {
  createEffect,
  createSignal,
  on,
  onMount,
  type Component,
} from "solid-js";

import TextInput from "@ds/components/forms/TextInput/TextInput";

export interface StringCellProps {
  value: string;
  autoFocus?: boolean;
  onCommit: (next: string) => void;
}

const StringCell: Component<StringCellProps> = (props) => {
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

  let input!: HTMLInputElement;
  onMount(() => {
    if (props.autoFocus) input.focus();
  });

  const commit = () => {
    if (draft() !== props.value) props.onCommit(draft());
  };

  return (
    <TextInput
      ref={(el) => (input = el)}
      size="sm"
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

export default StringCell;
