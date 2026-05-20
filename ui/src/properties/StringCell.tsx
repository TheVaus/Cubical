import {
  createEffect,
  createSignal,
  on,
  onMount,
  type Component,
} from "solid-js";

import { inputStyle } from "./styles";

/**
 * String-valued frontmatter cell (L2 Session F, spec §2.4).
 *
 * Holds a local `draft` so an `onAstChange`-driven row refresh cannot
 * clobber an in-progress edit: while the input is focused, incoming
 * `value` prop changes are ignored (brainstorming decision (d)). The
 * draft commits on blur or Enter.
 */
export interface StringCellProps {
  value: string;
  autoFocus?: boolean;
  onCommit: (next: string) => void;
}

const StringCell: Component<StringCellProps> = (props) => {
  const [draft, setDraft] = createSignal(props.value);
  const [focused, setFocused] = createSignal(false);

  // Adopt external value changes only — must NOT re-run on focus
  // changes alone, or blurring after an edit would revert the draft
  // to the stale prop during the 150ms AST-tick window.
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
    <input
      ref={input}
      type="text"
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

export default StringCell;
