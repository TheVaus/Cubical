import { stripMarkdownExtension } from "../vault/noteName";

export function byteOffsetOf(text: string, charPos: number): number {
  return new TextEncoder().encode(text.slice(0, charPos)).length;
}

export function buildBlockRefLink(path: string, blockId: string): string {
  return `[[${stripMarkdownExtension(path)}#^${blockId}]]`;
}
