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

export type RenameValidationError =
  | { code: "empty"; message: string }
  | { code: "same"; message: string };

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
  return null;
}
