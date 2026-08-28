export type InfoId = "typed-props" | "shortcuts";

export function toggleInfo(current: InfoId | null, id: InfoId): InfoId | null {
  return current === id ? null : id;
}
