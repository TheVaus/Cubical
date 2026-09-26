import type { BlockRenderer } from "./blockRenderers";

const DELIMITER_BY_INFO: Record<string, string> = {
  csv: ",",
  tsv: "\t",
};

export type DelimitedTableRenderer = (text: string, delimiter: string) => Node;

export function csvBlockRenderer(
  renderTable: DelimitedTableRenderer,
): BlockRenderer {
  return {
    id: "csv",
    languages: Object.keys(DELIMITER_BY_INFO),
    frameClass: "cm-block-frame cm-csv-frame",
    completions: [
      { language: "csv", detail: "Table" },
      { language: "tsv", detail: "Table, tab-separated" },
    ],
    render: (source, ctx) =>
      renderTable(source, DELIMITER_BY_INFO[ctx.language] ?? ","),
  };
}
