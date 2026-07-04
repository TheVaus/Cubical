/**
 * Client-side validation for the L3 Session J.2 file-rename gesture.
 *
 * Catches the no-op / nonsensical inputs (empty target, unchanged
 * target) before they cost an IPC round-trip. Backend rejections —
 * existing destination, vault not open — surface verbatim through the
 * toast surface.
 *
 * See `docs/layer-3-spec.md` §9.16.
 */

import { isValidNoteName, noteNameError } from "./vault/noteName";

export type RenameValidationError =
  | { code: "empty"; message: string }
  | { code: "same"; message: string }
  | { code: "dotted"; message: string };

export function validateRenameTarget(
  fromPath: string,
  rawTarget: string,
  isFolder = false,
): RenameValidationError | null {
  const trimmed = rawTarget.trim();
  if (trimmed === "") {
    return { code: "empty", message: "Name cannot be empty." };
  }
  if (trimmed === fromPath) {
    return { code: "same", message: "Name unchanged." };
  }
  if (!isFolder) {
    // A dotted note name isn't `[[ ]]`-linkable — the dot is the
    // property-ref separator. Folders aren't referenced via wiki-link
    // syntax, so this restriction doesn't apply to them.
    const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    if (!isValidNoteName(base)) {
      return { code: "dotted", message: noteNameError(base) };
    }
  }
  return null;
}

/**
 * If `path` is nested under `folderPath`, return its equivalent path
 * after the folder is renamed to `newFolderPath`; otherwise `null`.
 * Used to follow the currently-open file when the folder it lives in
 * gets renamed. A sibling folder that merely shares a name prefix
 * (`projects-archive` vs. `projects`) must not match — the check
 * requires the full `folderPath/` segment boundary.
 */
export function reprefixNestedPath(
  path: string,
  folderPath: string,
  newFolderPath: string,
): string | null {
  const prefix = `${folderPath}/`;
  if (!path.startsWith(prefix)) return null;
  return newFolderPath + path.slice(folderPath.length);
}
