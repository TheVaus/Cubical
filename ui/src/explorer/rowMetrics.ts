export const FILE_ROW_HEIGHT = 32;
export const FILE_LIST_OVERSCAN = 8;

export function folderPadding(depth: number): string {
  return `calc(var(--space-2) + ${depth} * var(--space-4))`;
}

export function filePadding(depth: number): string {
  return `calc(${folderPadding(depth)} + 1rem + var(--space-1))`;
}
