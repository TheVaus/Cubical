import type { ViewportInfo, IndicatorRect } from "./types";

const CEIL = 4;
const MIN_INDICATOR = 2;

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Fraction [0,1] of the document for a click at `clientY` within the strip. */
export function fractionFromClientY(
  clientY: number,
  stripTop: number,
  stripHeight: number,
): number {
  if (stripHeight <= 0) return 0;
  return clamp((clientY - stripTop) / stripHeight, 0, 1);
}

/** `scrollTop` that centers `fraction` of the content in the viewport. */
export function scrollTopForFraction(
  fraction: number,
  vp: ViewportInfo,
): number {
  const max = Math.max(0, vp.scrollHeight - vp.clientHeight);
  return clamp(fraction * vp.scrollHeight - vp.clientHeight / 2, 0, max);
}

/** The viewport-indicator rectangle in strip-local pixels. */
export function indicatorRect(
  vp: ViewportInfo,
  stripHeight: number,
): IndicatorRect {
  if (vp.scrollHeight <= 0) return { top: 0, height: stripHeight };
  const height = clamp(
    (vp.clientHeight / vp.scrollHeight) * stripHeight,
    MIN_INDICATOR,
    stripHeight,
  );
  const top = clamp(
    (vp.scrollTop / vp.scrollHeight) * stripHeight,
    0,
    Math.max(0, stripHeight - height),
  );
  return { top, height };
}

/** Per-line pixel height: scale-to-fit, capped at 4px, no lower floor. */
export function lineHeightFor(lineCount: number, stripHeight: number): number {
  return Math.min(CEIL, stripHeight / Math.max(lineCount, 1));
}
