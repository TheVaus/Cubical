import { parseColour } from "./gpu/palette";

export const FOLDER_TOKENS = [
  "--term-ansi-cyan",
  "--term-ansi-blue",
  "--term-ansi-magenta",
  "--term-ansi-green",
  "--term-ansi-yellow",
  "--term-ansi-bright-blue",
  "--term-ansi-bright-magenta",
  "--term-ansi-bright-green",
] as const;

export function folderOf(key: string): string {
  const slash = key.indexOf("/");
  return slash < 0 ? "" : key.slice(0, slash);
}

export function hashFolder(folder: string): number {
  let hash = 2166136261;
  for (let i = 0; i < folder.length; i++) {
    hash ^= folder.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hueIndex(folder: string, buckets: number = FOLDER_TOKENS.length): number {
  if (folder === "") return 0;
  return hashFolder(folder) % buckets;
}

export function readFolderColours(element: Element): number[] {
  const style = getComputedStyle(element);
  return FOLDER_TOKENS.map((token) =>
    parseColour(style.getPropertyValue(token)),
  );
}

export function colourForFolder(folder: string, colours: number[]): number {
  if (colours.length === 0) return 0;
  return colours[hueIndex(folder, colours.length)] ?? colours[0]!;
}
