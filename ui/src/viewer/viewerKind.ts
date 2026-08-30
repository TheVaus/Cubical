import { basename } from "../vault/noteName";

export type ViewerKind = "text" | "delimited" | "image" | "unsupported";

export const MAX_TEXT_VIEWER_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_VIEWER_BYTES = 25 * 1024 * 1024;
export const MAX_DELIMITED_VIEWER_ROWS = 5000;

const KIND_BY_EXTENSION: Record<string, ViewerKind> = {
  txt: "text",
  text: "text",
  log: "text",
  csv: "delimited",
  tsv: "delimited",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
};

export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function viewerKindForPath(path: string): ViewerKind {
  return KIND_BY_EXTENSION[extensionOf(path)] ?? "unsupported";
}

export function hasViewer(path: string): boolean {
  return viewerKindForPath(path) !== "unsupported";
}

export function supportsSourceView(kind: ViewerKind): boolean {
  return kind === "text" || kind === "delimited";
}

const EDITABLE_TEXT_EXTENSIONS = new Set(["txt", "text", "log"]);

// Pairs with editable_as_text in cubical-engine — docs/implementation/frontend.md
export function isEditableText(path: string): boolean {
  return EDITABLE_TEXT_EXTENSIONS.has(extensionOf(path));
}

export function delimiterForPath(path: string): string {
  return extensionOf(path) === "tsv" ? "\t" : ",";
}

export function maxBytesForKind(kind: ViewerKind): number {
  return kind === "image" ? MAX_IMAGE_VIEWER_BYTES : MAX_TEXT_VIEWER_BYTES;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
