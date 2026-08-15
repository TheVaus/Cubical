import { renderDelimitedTable } from "../viewer/render";
import type { BlockRenderer } from "./blockRenderers";

const DELIMITER_BY_INFO: Record<string, string> = {
  csv: ",",
  tsv: "\t",
};

export function delimiterForInfo(infoText: string): string | undefined {
  return DELIMITER_BY_INFO[infoText.trim().toLowerCase()];
}

export const csvBlockRenderer: BlockRenderer = {
  id: "csv",
  languages: Object.keys(DELIMITER_BY_INFO),
  frameClass: "cm-block-frame cm-csv-frame",
  render: (source, ctx) =>
    renderDelimitedTable(source, DELIMITER_BY_INFO[ctx.language] ?? ","),
};
