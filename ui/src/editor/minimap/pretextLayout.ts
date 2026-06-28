import { prepareWithSegments, layoutWithLines } from "@chenglou/pretext";
import type { MinimapLayout } from "./types";

export interface LayoutInput {
  text: string;
  width: number;
  lineHeight: number;
  font: string;
}

/**
 * Lay out the full document at minimap scale via Pretext and flatten the
 * result into a {@link MinimapLayout}. Pretext owns text measurement
 * internally (its own canvas `measureText` + `Intl.Segmenter`), so there is
 * no measurement injection point — see the design spec §5.
 */
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
