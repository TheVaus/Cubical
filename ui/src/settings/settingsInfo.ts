export type InfoId =
  | "typed-props"
  | "wiki-repair"
  | "dataview"
  | "property-refs"
  | "shortcuts";

export function toggleInfo(current: InfoId | null, id: InfoId): InfoId | null {
  return current === id ? null : id;
}
