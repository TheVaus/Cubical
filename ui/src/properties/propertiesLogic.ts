import { effectiveDateFormat } from "./dateFormats";
import { DEFAULT_CURRENCY, isKnownCurrency } from "./format";
import { inferType } from "./inferType";
import type { PropertyType } from "./typeComments";

export function resolveType(
  typedEnabled: boolean,
  typeMap: Map<string, PropertyType>,
  key: string,
  value: unknown,
): PropertyType {
  const explicit = typedEnabled ? typeMap.get(key) : undefined;
  return explicit ?? { kind: inferType(value) };
}

export function effectiveFormat(type: PropertyType): string {
  return effectiveDateFormat(type.format, undefined);
}

export function effectiveCurrency(
  type: PropertyType,
  vaultDefault: string | undefined,
): string {
  if (isKnownCurrency(type.currency)) return type.currency!.toLowerCase();
  if (isKnownCurrency(vaultDefault)) return vaultDefault!.toLowerCase();
  return DEFAULT_CURRENCY;
}
