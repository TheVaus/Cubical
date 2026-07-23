const CURRENCY_ISO: Record<string, string> = {
  usd: "USD",
  nis: "ILS",
  eur: "EUR",
};

export const CURRENCY_CODES: string[] = Object.keys(CURRENCY_ISO);

export const DEFAULT_CURRENCY = "usd";

export function isKnownCurrency(code: string | undefined): boolean {
  return code !== undefined && code.toLowerCase() in CURRENCY_ISO;
}

export function formatCurrency(value: number, code: string): string {
  const iso = CURRENCY_ISO[code.toLowerCase()];
  if (!iso) return new Intl.NumberFormat("en-US").format(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: iso,
  }).format(value);
}

export function parseCurrencyInput(text: string): number | null {
  const cleaned = text.replace(/[^0-9.\-]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function truncateInt(value: number): number {
  return Math.trunc(value);
}
