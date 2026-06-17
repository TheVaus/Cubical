import { createEffect, createSignal, on, type Component } from "solid-js";

import { formatCurrency, parseCurrencyInput } from "./format";
import { inputStyle } from "./styles";

/**
 * Currency-valued frontmatter cell (spec §4.1). Stores a BARE number in
 * the YAML; the symbol and formatting are display-only and driven by the
 * `currency` code (usd/nis/eur). While focused the raw number is shown
 * for editing; blurred, it renders formatted.
 */
export interface CurrencyCellProps {
  value: number;
  currency: string;
  onCommit: (next: number) => void;
}

const CurrencyCell: Component<CurrencyCellProps> = (props) => {
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
    const parsed = parseCurrencyInput(draft());
    if (parsed === null) {
      setDraft(String(props.value));
      return;
    }
    if (parsed !== props.value) props.onCommit(parsed);
    setDraft(String(parsed));
  };

  const display = () =>
    focused() ? draft() : formatCurrency(props.value, props.currency);

  return (
    <input
      type="text"
      inputmode="decimal"
      value={display()}
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

export default CurrencyCell;
