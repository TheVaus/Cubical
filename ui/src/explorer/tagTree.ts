import { stabilizeByKey } from "../core/listStability";
import type { FileLeaf } from "./fileTree";

export const UNTAGGED_ID = "\u0000untagged";

export interface TagAssignment {
  tag_path: string;
  file_path: string;
}

export interface TagNode {
  name: string;
  path: string;
  renamable: boolean;
  folders: TagNode[];
  files: FileLeaf[];
}

export type TagFlatRow =
  | {
      kind: "tag";
      id: string;
      name: string;
      depth: number;
      collapsed: boolean;
      renamable: boolean;
    }
  | {
      kind: "file";
      id: string;
      path: string;
      name: string;
      depth: number;
      typeId: string;
    };

export function parentTagOf(tagPath: string): string | null {
  const i = tagPath.lastIndexOf("/");
  return i <= 0 ? null : tagPath.slice(0, i);
}

export function tagFileRowId(tagId: string, filePath: string): string {
  return `${tagId}\n${filePath}`;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function sortNode(node: TagNode): void {
  node.folders.sort(byName);
  node.files.sort(byName);
  node.folders.forEach(sortNode);
}

function baseName(path: string): string {
  return (
    path
      .split("/")
      .filter((s) => s.length > 0)
      .pop() ?? path
  );
}

export function buildTagTree(
  assignments: ReadonlyArray<TagAssignment>,
  files: ReadonlyArray<{ path: string; type_id: string }>,
): TagNode {
  const root: TagNode = {
    name: "",
    path: "",
    renamable: false,
    folders: [],
    files: [],
  };
  const known = new Map(files.map((f) => [f.path, f.type_id]));

  const ensureTag = (tagPath: string): TagNode => {
    let cursor = root;
    let cursorPath = "";
    for (const seg of tagPath.split("/").filter((s) => s.length > 0)) {
      cursorPath = cursorPath ? `${cursorPath}/${seg}` : seg;
      let next = cursor.folders.find((f) => f.name === seg);
      if (!next) {
        next = {
          name: seg,
          path: cursorPath,
          renamable: true,
          folders: [],
          files: [],
        };
        cursor.folders.push(next);
      }
      cursor = next;
    }
    return cursor;
  };

  const tagged = new Set<string>();
  for (const a of assignments) {
    if (a.tag_path.length === 0) continue;
    const node = ensureTag(a.tag_path);
    const typeId = known.get(a.file_path);
    if (typeId === undefined) continue;
    tagged.add(a.file_path);
    if (node.files.some((f) => f.path === a.file_path)) continue;
    node.files.push({
      path: a.file_path,
      name: baseName(a.file_path),
      typeId,
    });
  }

  sortNode(root);

  const untagged = files.filter((f) => !tagged.has(f.path));
  if (untagged.length > 0) {
    const bucket: TagNode = {
      name: "Untagged",
      path: UNTAGGED_ID,
      renamable: false,
      folders: [],
      files: untagged.map((f) => ({
        path: f.path,
        name: baseName(f.path),
        typeId: f.type_id,
      })),
    };
    bucket.files.sort(byName);
    root.folders.push(bucket);
  }

  return root;
}

export function flattenTagTree(
  root: TagNode,
  collapsed: ReadonlySet<string>,
): TagFlatRow[] {
  const out: TagFlatRow[] = [];
  const walk = (node: TagNode, depth: number): void => {
    for (const tag of node.folders) {
      const isCollapsed = collapsed.has(tag.path);
      out.push({
        kind: "tag",
        id: tag.path,
        name: tag.name,
        depth,
        collapsed: isCollapsed,
        renamable: tag.renamable,
      });
      if (!isCollapsed) walk(tag, depth + 1);
    }
    for (const file of node.files) {
      out.push({
        kind: "file",
        id: tagFileRowId(node.path, file.path),
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

function rowKey(row: TagFlatRow): string {
  return `${row.kind}:${row.id}`;
}

function rowEqual(a: TagFlatRow, b: TagFlatRow): boolean {
  if (a.kind !== b.kind || a.name !== b.name || a.depth !== b.depth) {
    return false;
  }
  return a.kind === "tag" && b.kind === "tag"
    ? a.collapsed === b.collapsed && a.renamable === b.renamable
    : a.kind === "file" && b.kind === "file" && a.typeId === b.typeId;
}

export function buildStableTagRows(
  prevRows: readonly TagFlatRow[],
  assignments: ReadonlyArray<TagAssignment>,
  files: ReadonlyArray<{ path: string; type_id: string }>,
  collapsed: ReadonlySet<string>,
): TagFlatRow[] {
  const next = flattenTagTree(buildTagTree(assignments, files), collapsed);
  return stabilizeByKey(prevRows, next, rowKey, rowEqual);
}
