const SIGNIFICANT_DIGITS = 12;

export function formatResult(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  return String(Number(value.toPrecision(SIGNIFICANT_DIGITS)));
}
