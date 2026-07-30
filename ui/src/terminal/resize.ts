export interface TerminalSize {
  cols: number;
  rows: number;
}

export function isUsableSize(size: TerminalSize | null): size is TerminalSize {
  return (
    size !== null &&
    Number.isFinite(size.cols) &&
    Number.isFinite(size.rows) &&
    size.cols > 0 &&
    size.rows > 0
  );
}

export function sizeChanged(
  prev: TerminalSize | null,
  next: TerminalSize,
): boolean {
  if (!isUsableSize(next)) return false;
  return prev === null || prev.cols !== next.cols || prev.rows !== next.rows;
}

export function watchResize(
  target: HTMLElement,
  onResize: () => void,
): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(() => onResize());
  observer.observe(target);
  return () => observer.disconnect();
}
