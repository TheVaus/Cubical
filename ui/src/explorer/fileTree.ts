import { stabilizeByKey } from "../listStability";

export interface FileLeaf {
  path: string;
  name: string;
  typeId: string;
}

export function splitFileName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

export interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  files: FileLeaf[];
}

export type FlatRow =
  | {
      kind: "folder";
      path: string;
      name: string;
      depth: number;
      collapsed: boolean;
    }
  | { kind: "file"; path: string; name: string; depth: number; typeId: string };

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

function sortFolder(node: FolderNode): void {
  node.folders.sort(byName);
  node.files.sort(byName);
  node.folders.forEach(sortFolder);
}

export function buildFileTree(
  entries: ReadonlyArray<{ path: string; type_id: string }>,
  folderPaths: ReadonlyArray<string> = [],
): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], files: [] };

  const ensureFolder = (segments: string[]): FolderNode => {
    let cursor = root;
    let cursorPath = "";
    for (const seg of segments) {
      cursorPath = cursorPath ? `${cursorPath}/${seg}` : seg;
      let next = cursor.folders.find((f) => f.name === seg);
      if (!next) {
        next = { name: seg, path: cursorPath, folders: [], files: [] };
        cursor.folders.push(next);
      }
      cursor = next;
    }
    return cursor;
  };

  for (const folderPath of folderPaths) {
    const segments = folderPath.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    ensureFolder(segments);
  }

  for (const entry of entries) {
    const segments = entry.path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    const fileName = segments.pop()!;
    const cursor = ensureFolder(segments);
    cursor.files.push({
      path: entry.path,
      name: fileName,
      typeId: entry.type_id,
    });
  }
  sortFolder(root);
  return root;
}

export function flattenTree(
  root: FolderNode,
  collapsed: ReadonlySet<string>,
): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (node: FolderNode, depth: number): void => {
    for (const folder of node.folders) {
      const isCollapsed = collapsed.has(folder.path);
      out.push({
        kind: "folder",
        path: folder.path,
        name: folder.name,
        depth,
        collapsed: isCollapsed,
      });
      if (!isCollapsed) walk(folder, depth + 1);
    }
    for (const file of node.files) {
      out.push({
        kind: "file",
        path: file.path,
        name: file.name,
        depth,
        typeId: file.typeId,
      });
    }
  };
  walk(root, 0);
  return out;
}

function flatRowKey(row: FlatRow): string {
  return `${row.kind}:${row.path}`;
}

function flatRowEqual(a: FlatRow, b: FlatRow): boolean {
  if (a.kind !== b.kind || a.name !== b.name || a.depth !== b.depth) {
    return false;
  }
  return a.kind === "folder" && b.kind === "folder"
    ? a.collapsed === b.collapsed
    : a.kind === "file" && b.kind === "file" && a.typeId === b.typeId;
}

export function buildStableTreeRows(
  prevRows: readonly FlatRow[],
  entries: ReadonlyArray<{ path: string; type_id: string }>,
  folderPaths: ReadonlyArray<string>,
  collapsed: ReadonlySet<string>,
): FlatRow[] {
  const next = flattenTree(buildFileTree(entries, folderPaths), collapsed);
  return stabilizeByKey(prevRows, next, flatRowKey, flatRowEqual);
}

function findFolder(node: FolderNode, path: string): FolderNode | null {
  if (node.path === path) return node;
  for (const child of node.folders) {
    const found = findFolder(child, path);
    if (found) return found;
  }
  return null;
}

function countFiles(node: FolderNode): number {
  return (
    node.files.length +
    node.folders.reduce((sum, child) => sum + countFiles(child), 0)
  );
}

export function countFilesUnderFolder(root: FolderNode, folderPath: string): number {
  const folder = findFolder(root, folderPath);
  return folder ? countFiles(folder) : 0;
}
