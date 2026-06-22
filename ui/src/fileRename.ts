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
): RenameValidationError | null {
  const trimmed = rawTarget.trim();
  if (trimmed === "") {
    return { code: "empty", message: "Name cannot be empty." };
  }
  if (trimmed === fromPath) {
    return { code: "same", message: "Name unchanged." };
  }
  // A dotted note name isn't `[[ ]]`-linkable — the dot is the
  // property-ref separator. Validate the final path segment only.
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (!isValidNoteName(base)) {
    return { code: "dotted", message: noteNameError(base) };
  }
  return null;
}
