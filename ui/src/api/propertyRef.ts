import { invoke } from "./transport";

export interface GetPropertyRequest {
  vault_id: string;
  note_raw: string;
  property: string;
}

export type PropertyRefKind =
  "resolved" | "note_unresolved" | "property_missing";

export interface GetPropertyResponse {
  kind: PropertyRefKind;
  value: unknown;
}

export function getProperty(
  req: GetPropertyRequest,
): Promise<GetPropertyResponse> {
  return invoke("get_property", { req });
}
