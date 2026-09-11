import {
  getProperty as defaultGetProperty,
  type GetPropertyRequest,
  type GetPropertyResponse,
} from "../api/propertyRef";
import { createKeyedResolver } from "./keyedResolver";
import type { PropertyResolver } from "./propertySlot";

export type { PropertyResolver } from "./propertySlot";

const UNRESOLVED: GetPropertyResponse = { kind: "note_unresolved", value: null };

interface PropertyKey {
  note: string;
  property: string;
}


export function createPropertyResolver(
  vaultId: string,
  ipc: (req: GetPropertyRequest) => Promise<GetPropertyResponse> = defaultGetProperty,
): PropertyResolver {
  const inner = createKeyedResolver<PropertyKey, GetPropertyResponse>({
    cacheKey: ({ note, property }) => `${note} ${property}`,
    load: ({ note, property }) =>
      ipc({ vault_id: vaultId, note_raw: note, property }),
    onFailure: () => UNRESOLVED,
  });

  return {
    get: (note, property) => inner.get({ note, property }),
    fetch: (note, property) => inner.fetch({ note, property }),
    resolve: (note, property) => inner.resolve({ note, property }),
    invalidate: () => inner.invalidate(),
    markStale: () => inner.markStale(),
    onUpdate: (handler) => inner.onUpdate(handler),
    version: () => inner.version(),
  };
}
