const SIGNIFICANT_DECIMALS = 10;

export function formatResult(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Number(value.toFixed(SIGNIFICANT_DECIMALS)));
}
