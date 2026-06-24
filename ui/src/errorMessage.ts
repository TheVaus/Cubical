/**
 * Normalize an unknown thrown value into a human-facing string.
 *
 * IPC rejections arrive as a `CubicalError`-shaped object (`{ code,
 * message }`); other failures may be `Error` instances or arbitrary
 * values. UI catch-blocks repeated this exact narrowing ~15 times — one
 * owner for "turn a caught value into a message" keeps the rule in a
 * single place.
 */
export function errorMessage(e: unknown): string {
  return typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);
}
