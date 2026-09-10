export const DATE_FORMAT_TOKENS = [
  "YYYY-MM-DD",
  "YYYY-MM-DD HH:MM",
  "YYYY",
  "YYYY-MM",
  "DD-MM-YYYY",
  "DD-MM-YY",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
] as const;

export type DateFormatToken = (typeof DATE_FORMAT_TOKENS)[number];

export const CURRENCY_CODES = ["usd", "nis", "eur"] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];
