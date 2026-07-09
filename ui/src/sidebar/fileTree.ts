/**
 * Folder-tree model for the left sidebar (UI rework, increment 2).
 *
 * The vault scan hands us a flat list of vault-relative paths
 * (`a/b/note.md`). This module turns that into a nested folder tree and
 * flattens the *visible* rows (respecting collapsed folders) back into a
 * list, so the existing fixed-height virtualization keeps working — only
 * the windowed slice is ever mounted.
 *
 * Pure + dependency-free so it unit-tests without the app harness
 * (conventions §tests: pure logic is unit-tested; components are
 * operator-smoke-only).
 */

import { stabilizeByKey } from "../listStability";

export interface FileLeaf {
  /** Full vault-relative path, e.g. `projects/roadmap.md`. */
  path: string;
  /** Basename including extension, e.g. `roadmap.md`. */
  name: string;
  /** File-type registry id (`markdown`, etc.). */
  typeId: string;
}

/**
 * Split a basename into its display stem and extension (extension
 * *without* the leading dot). A name with no dot, or a leading-dot
 * dotfile like `.gitignore`, yields `ext === ""` and the whole name as
 * the stem. Splits on the last dot for multi-dot names (`a.b.md`).
 */
export function splitFileName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

export interface FolderNode {
  /** Folder basename (`""` for the synthetic root). */
  name: string;
  /** Full vault-relative folder path (`""` for the root). */
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

/**
 * Case-insensitive, natural-number name order (folders and files sorted
 * independently). `numeric: true` makes digit runs compare by value so
 * `file-2` sorts before `file-10` instead of lexicographically after it.
 */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

function sortFolder(node: FolderNode): void {
  node.folders.sort(byName);
  node.files.sort(byName);
  node.folders.forEach(sortFolder);
}

/**
 * Build a nested folder tree from flat entries. Empty path segments
 * (leading/trailing/duplicate slashes) are ignored. Returns the synthetic
 * root whose `folders`/`files` are the top level of the vault.
 *
 * `folderPaths` lists directories to materialize even when they hold no
 * files — without it an empty folder (its path appears in no file) would
 * be invisible, since folders are otherwise inferred from file paths.
 */
export function buildFileTree(
  entries: ReadonlyArray<{ path: string; type_id: string }>,
  folderPaths: ReadonlyArray<string> = [],
): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], files: [] };

  // Walk/create the folder chain for a path's directory segments,
  // returning the deepest node. Shared by file entries and empty folders.
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

  // Seed tracked (possibly empty) folders first so they survive even if
  // no file lives under them.
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

/**
 * Depth-first flatten of the *visible* rows. A folder whose path is in
 * `collapsed` is emitted but its children are skipped. Within a folder,
 * sub-folders come before files (both already name-sorted by build).
 */
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

/**
 * Builds the flattened visible-row list the same way `flattenTree` does,
 * but reuses `prevRows`' object reference for any row whose content is
 * unchanged. `<For>` in the sidebar reconciles by object reference, so
 * without this every vault-file-changed refresh (including the open
 * file's own autosave) would tear down and remount the whole visible
 * tree even when the row content is identical.
 */
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

/**
 * Number of files nested anywhere under `folderPath` — used for the
 * delete-confirmation message ("Delete 'projects' and its N files?").
 * Walks the nested tree (not the flattened, collapse-aware row list) so a
 * collapsed subfolder doesn't undercount.
 */
export function countFilesUnderFolder(root: FolderNode, folderPath: string): number {
  const folder = findFolder(root, folderPath);
  return folder ? countFiles(folder) : 0;
}
