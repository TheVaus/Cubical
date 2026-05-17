/**
 * Virtual-list windowing for the file list.
 *
 * The vault file list can hold tens of thousands of rows. Rendering one
 * DOM node per file freezes the webview (a 30k-row list is ~500ms of
 * layout per paint, repeated on every scan-progress refresh). Instead
 * the list renders only the rows in (and just around) the viewport.
 *
 * `computeWindow` is the pure core: given scroll position and viewport
 * height it returns which contiguous slice of rows to mount, the pixel
 * offset to translate them to, and the full scroll height the
 * container must reserve so the scrollbar stays accurate.
 *
 * Rows are assumed to be a uniform `rowHeight` — the file list uses a
 * fixed-height row, so a single multiply suffices and no per-row
 * measurement is needed.
 */

/** The slice of rows to mount, plus positioning metadata. */
export interface ListWindow {
  /** First row index to render (inclusive). */
  startIndex: number;
  /** One past the last row index to render (exclusive). */
  endIndex: number;
  /** Pixel offset to translate the rendered slice down to. */
  offsetY: number;
  /** Full pixel height of all rows — reserved so the scrollbar is accurate. */
  totalHeight: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Compute the row window to render for a fixed-row-height virtual list.
 *
 * `overscan` rows are rendered beyond each edge of the viewport so a
 * fast scroll doesn't flash blank space before the next frame.
 */
export function computeWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  itemCount: number,
  overscan: number,
): ListWindow {
  const totalHeight = itemCount * rowHeight;
  if (itemCount === 0) {
    return { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 };
  }

  const firstVisible = Math.floor(scrollTop / rowHeight);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / rowHeight);

  const startIndex = clamp(firstVisible - overscan, 0, itemCount);
  const endIndex = clamp(lastVisible + overscan, 0, itemCount);

  return {
    startIndex,
    endIndex,
    offsetY: startIndex * rowHeight,
    totalHeight,
  };
}
