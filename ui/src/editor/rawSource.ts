export function resolveRawState(
  override: boolean | null,
  appDefault: boolean,
): boolean {
  return override ?? appDefault;
}
