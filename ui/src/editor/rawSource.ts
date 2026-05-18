/**
 * Raw-source effective-state resolver — L2 Session E (spec §2.3).
 *
 * The Raw Source toggle has two layers of state:
 *
 * - **App default** — the `editor.raw_source_default` setting, read on
 *   startup. The out-of-the-box value is `false` (Live Preview).
 * - **Per-doc override** — a transient, in-memory choice for the
 *   currently-open document. `null` means "no override — defer to the
 *   default." It resets to `null` on every file-selection change, so a
 *   newly opened file always starts from the app default.
 *
 * `resolveRawState` collapses the two into the single boolean the
 * editor acts on. Pure and DOM-free so it is directly unit-testable.
 */
export function resolveRawState(
  override: boolean | null,
  appDefault: boolean,
): boolean {
  return override ?? appDefault;
}
