export function byteOffsetOf(text: string, charPos: number): number {
  return new TextEncoder().encode(text.slice(0, charPos)).length;
}

export function buildBlockRefLink(path: string, blockId: string): string {
  const base = path.endsWith(".md") ? path.slice(0, -3) : path;
  return `[[${base}#^${blockId}]]`;
}
