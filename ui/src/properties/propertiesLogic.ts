/**
 * Pure resolution + annotation logic for the Properties panel, factored
 * out of `Properties.tsx` so it is unit-testable (component tests are
 * deferred — see `ui/vite.config.ts`).
 */

import { effectiveDateFormat } from "./dateFormats";
import { inferType } from "./inferType";
import type { PropertyType } from "./typeComments";

/**
 * Resolve a property's type: the inline type comment wins when typed
 * properties are enabled, otherwise fall back to inference.
 */
export function resolveType(
  typedEnabled: boolean,
  typeMap: Map<string, PropertyType>,
  key: string,
  value: unknown,
): PropertyType {
  const explicit = typedEnabled ? typeMap.get(key) : undefined;
  return explicit ?? { kind: inferType(value) };
}

/** The effective date format for a resolved type given the vault default. */
export function effectiveFormat(
  type: PropertyType,
  vaultDefault: string | undefined,
): string {
  return effectiveDateFormat(type.format, vaultDefault);
}

/**
 * Produce the annotation map to serialize: a copy of `current` with an
 * optional single-key override. `null` removes the key (lossy-revert);
 * no override returns a plain copy (preserve comments on value edits).
 */
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
