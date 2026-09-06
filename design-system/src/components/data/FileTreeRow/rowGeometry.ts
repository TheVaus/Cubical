export const TREE_ROW_HEIGHT = 32;

export function folderPadding(depth: number): string {
  return `calc(var(--space-2) + ${depth} * var(--space-4))`;
}

export function filePadding(depth: number): string {
  return `calc(${folderPadding(depth)} + 1rem + var(--space-1))`;
}
