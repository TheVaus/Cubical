export type EntryKind = "input" | "stdout" | "stderr";

export interface Entry {
  kind: EntryKind;
  text: string;
}

export const MAX_ENTRIES = 500;

export function append(entries: Entry[], next: Entry[]): Entry[] {
  const combined = [...entries, ...next];
  return combined.length > MAX_ENTRIES ? combined.slice(combined.length - MAX_ENTRIES) : combined;
}
