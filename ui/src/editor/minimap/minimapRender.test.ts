import { describe, expect, it, vi } from "vitest";
import { drawMinimap } from "./minimapRender";
import type { MinimapLayout, MinimapColors } from "./types";

function mockCtx() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    set fillStyle(_v: string) {},
    set font(_v: string) {},
    set globalAlpha(_v: number) {},
  } as unknown as CanvasRenderingContext2D & {
    clearRect: ReturnType<typeof vi.fn>;
    fillRect: ReturnType<typeof vi.fn>;
    fillText: ReturnType<typeof vi.fn>;
  };
}

const colors: MinimapColors = {
  text: "#111",
  background: "#fff",
  indicator: "#3b82f6",
};

describe("drawMinimap", () => {
  it("clears, paints background, draws one fillText per line, draws indicator", () => {
    const ctx = mockCtx();
    const layout: MinimapLayout = {
      lines: [{ text: "alpha" }, { text: "beta" }, { text: "gamma" }],
      contentHeight: 12,
    };
    drawMinimap(ctx, {
      layout,
      lineHeight: 4,
      indicator: { top: 0, height: 10 },
      colors,
      width: 96,
      height: 600,
      font: "10px monospace",
    });
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).toHaveBeenCalledTimes(3);
    // line 0 at y=0, line 2 at y=8 (i * lineHeight)
    expect(ctx.fillText).toHaveBeenNthCalledWith(1, "alpha", 0, 0);
    expect(ctx.fillText).toHaveBeenNthCalledWith(3, "gamma", 0, 8);
    // background fillRect + indicator fillRect = at least 2 rects
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("handles an empty document without drawing any text", () => {
    const ctx = mockCtx();
    drawMinimap(ctx, {
      layout: { lines: [], contentHeight: 0 },
      lineHeight: 4,
      indicator: { top: 0, height: 600 },
      colors,
      width: 96,
      height: 600,
      font: "10px monospace",
    });
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
  });
});
