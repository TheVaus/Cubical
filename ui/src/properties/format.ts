/**
 * Pure formatting/parsing helpers for the typed Properties cells. Kept
 * separate from the `.tsx` cells so the logic is unit-testable in the
 * node test environment (component tests are deferred — see
 * `ui/vite.config.ts`).
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Render a number as USD, e.g. `1234.5` → `"$1,234.50"`. */
export function formatCurrencyUSD(value: number): string {
  return USD.format(value);
}

/** Parse a currency input (tolerating `$` and `,`) to a number, or null. */
export function parseCurrencyInput(text: string): number | null {
  const cleaned = text.trim().replace(/[$,]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Truncate a number toward zero to an integer. */
export function truncateInt(value: number): number {
  return Math.trunc(value);
}

/**
 * Normalize a string to an HTML `datetime-local` value (`YYYY-MM-DDThh:mm`).
 * A bare ISO date is promoted to midnight; unparseable input → `""`.
 */
export function normalizeDateTime(value: string): string {
  if (ISO_DATETIME.test(value)) return value.slice(0, 16);
  if (ISO_DATE.test(value)) return `${value}T00:00`;
  return "";
}
