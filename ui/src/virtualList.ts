export interface ListWindow {
  startIndex: number;
  endIndex: number;
  offsetY: number;
  totalHeight: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

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
