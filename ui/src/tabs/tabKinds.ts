import type { TabRecordDto } from "../api/ipc";

export type TabRecordPayload = Pick<TabRecordDto, "path" | "tag_path">;

export interface TabKind {
  kind: string;
  label: (key: string) => string;
  evictable: boolean;
  persist?: {
    toRecord: (key: string) => TabRecordPayload;
    fromRecord: (record: TabRecordDto) => string | null;
  };
}

export const FILE_KIND = "file";

const kinds = new Map<string, TabKind>();

export function registerTabKinds(contributed: readonly TabKind[]): void {
  for (const k of contributed) {
    if (k.kind !== FILE_KIND && !kinds.has(k.kind)) kinds.set(k.kind, k);
  }
}

export function tabKind(kind: string): TabKind | undefined {
  return kinds.get(kind);
}
