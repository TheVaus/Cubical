const ID_BODY = "[A-Za-z_][A-Za-z0-9_-]*";

export const BLOCK_ID_PREFIX_SOURCE = `(?:${ID_BODY})?`;
export const BLOCK_ID_PREFIX_RE = new RegExp(`^${BLOCK_ID_PREFIX_SOURCE}$`);
export const TRAILING_BLOCK_ID_RE = new RegExp(`(^|\\s)\\^(${ID_BODY})\\s*$`);

const BLOCK_ID_RE = new RegExp(`^${ID_BODY}$`);

export function isBlockId(id: string): boolean {
  return BLOCK_ID_RE.test(id);
}

export function blockIdAtLineEnd(line: string): string | null {
  return TRAILING_BLOCK_ID_RE.exec(line)?.[2] ?? null;
}
