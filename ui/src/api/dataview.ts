import { invoke } from "./transport";

export interface NoteRef {
  path: string;
  title: string;
}

export interface DataviewRow {
  note: NoteRef | null;
  cells: string[];
}

export interface DataviewListItem {
  text: string;
  note: NoteRef | null;
}

export type DataviewResult =
  | { kind: "list"; items: DataviewListItem[] }
  | {
      kind: "table";
      columns: string[];
      rows: DataviewRow[];
      row_label: string | null;
    }
  | { kind: "count"; count: number }
  | { kind: "error"; message: string };

export interface DataviewQueryRequest {
  vault_id: string;
  source: string;
}

export function dataviewQuery(
  req: DataviewQueryRequest,
): Promise<DataviewResult> {
  return invoke("dataview_query", { req });
}
