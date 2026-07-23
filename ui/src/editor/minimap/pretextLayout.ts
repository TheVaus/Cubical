import { prepareWithSegments, layoutWithLines } from "@chenglou/pretext";
import type { MinimapLayout } from "./types";

export interface LayoutInput {
  text: string;
  width: number;
  lineHeight: number;
  font: string;
}

export function layoutDocument(input: LayoutInput): MinimapLayout {
  const { text, width, lineHeight, font } = input;
  if (text.length === 0) return { lines: [], contentHeight: 0 };

  const prepared = prepareWithSegments(text, font);
  const result = layoutWithLines(prepared, width, lineHeight);
  return {
    lines: result.lines.map((l) => ({ text: l.text })),
    contentHeight: result.lineCount * lineHeight,
  };
}
