export const BLOCK_ID_CHAR = "A-Za-z0-9_-";
export const BLOCK_ID_SOURCE = `[A-Za-z_][${BLOCK_ID_CHAR}]*`;

const BLOCK_ID = new RegExp(`^${BLOCK_ID_SOURCE}$`);

export function isBlockId(id: string): boolean {
  return BLOCK_ID.test(id);
}
