/**
 * Pure formatting/parsing helpers for the typed Properties cells. Kept
 * separate from the `.tsx` cells so the logic is unit-testable in the
 * node test environment (component tests are deferred — see
 * `ui/vite.config.ts`).
 */

/** Supported currency codes → ISO 4217 code for `Intl.NumberFormat`. */
const CURRENCY_ISO: Record<string, string> = {
  usd: "USD",
  nis: "ILS",
  eur: "EUR",
};

/** Whether a lowercase currency code is supported. */
export function isKnownCurrency(code: string): boolean {
  return code in CURRENCY_ISO;
}

/**
 * Render a number in the given currency, e.g. `formatCurrency(1234.5,
 * "usd")` → `"$1,234.50"`. An unknown code falls back to a plain
 * thousands-separated number (no symbol).
 */
export function formatCurrency(value: number, code: string): string {
  const iso = CURRENCY_ISO[code.toLowerCase()];
  if (!iso) return new Intl.NumberFormat("en-US").format(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: iso,
  }).format(value);
}

/** Parse a currency input (tolerating symbols and `,`) to a number, or null. */
export function parseCurrencyInput(text: string): number | null {
  const cleaned = text.replace(/[^0-9.\-]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Truncate a number toward zero to an integer. */
export function truncateInt(value: number): number {
  return Math.trunc(value);
}
