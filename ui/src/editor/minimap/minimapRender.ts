import type { MinimapLayout, IndicatorRect, MinimapColors } from "./types";

export interface DrawOpts {
  layout: MinimapLayout;
  lineHeight: number;
  indicator: IndicatorRect;
  colors: MinimapColors;
  width: number;
  height: number;
  font: string;
}

/**
 * Paint the minimap: background, one row of tiny text per laid-out line,
 * then the translucent viewport indicator. Pure aside from the ctx writes;
 * no DOM lookups, no Pretext.
 */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  opts: DrawOpts,
): void {
  const { layout, lineHeight, indicator, colors, width, height, font } = opts;

  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);

  ctx.font = font;
  ctx.fillStyle = colors.text;
  for (let i = 0; i < layout.lines.length; i++) {
    ctx.fillText(layout.lines[i].text, 0, i * lineHeight);
  }

  ctx.globalAlpha = 0.25;
  ctx.fillStyle = colors.indicator;
  ctx.fillRect(0, indicator.top, width, indicator.height);
  ctx.globalAlpha = 1;
}
