export function errorMessage(e: unknown): string {
  return typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);
}
