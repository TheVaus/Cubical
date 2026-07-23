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
    const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    if (!isValidNoteName(base)) {
      return { code: "dotted", message: noteNameError(base) };
    }
  }
  return null;
}

export function reprefixNestedPath(
  path: string,
  folderPath: string,
  newFolderPath: string,
): string | null {
  const prefix = `${folderPath}/`;
  if (!path.startsWith(prefix)) return null;
  return newFolderPath + path.slice(folderPath.length);
}
