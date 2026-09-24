export type InfoId = string;

export function toggleInfo(current: InfoId | null, id: InfoId): InfoId | null {
  return current === id ? null : id;
}
