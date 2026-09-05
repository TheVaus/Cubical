export const OVERLAY_SELECTOR = "[data-ds-overlay]";

export function hasOpenOverlay(root: ParentNode): boolean {
  return root.querySelector(OVERLAY_SELECTOR) !== null;
}

export function isOverlayOpen(): boolean {
  if (typeof document === "undefined") return false;
  return hasOpenOverlay(document);
}
