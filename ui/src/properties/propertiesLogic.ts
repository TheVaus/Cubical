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

export function buildAnnotations(
  current: Map<string, PropertyType>,
  key?: string,
  type?: PropertyType | null,
): Map<string, PropertyType> {
  const next = new Map(current);
  if (key !== undefined) {
    if (type == null) next.delete(key);
    else next.set(key, type);
  }
  return next;
}
