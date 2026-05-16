/**
 * Theme mechanism — L2 Session D (spec §2.5).
 *
 * Three pieces:
 *
 * - `resolveTheme` — the pure core. `system` mode collapses to a
 *   concrete `light` / `dark` using the OS preference; explicit modes
 *   pass through. No DOM, no `window` — unit-tested in `theme.test.ts`.
 * - `applyTheme` — resolves the mode against the live `matchMedia`
 *   preference and writes `<html data-theme="…">`, the cascade root
 *   that `tokens.css` keys off. Returns the resolved theme so callers
 *   can hand it to the CodeMirror theme generator.
 * - `watchSystemTheme` — subscribes to OS appearance changes so an
 *   app sitting in `system` mode re-themes without a reload.
 *
 * Why `system` resolution lives in the frontend: Rust only stores the
 * `"light" | "dark" | "system"` string (spec §5 deviation #5). The
 * webview is the only place that can see `prefers-color-scheme`.
 */

/** The user-facing theme preference, persisted as `appearance.theme_mode`. */
export type ThemeMode = "light" | "dark" | "system";

/** A concrete theme — what actually drives the `data-theme` attribute. */
export type ResolvedTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Collapse a {@link ThemeMode} to a concrete {@link ResolvedTheme}.
 * Pure: `prefersDark` is supplied by the caller rather than read from
 * `matchMedia`, so this is testable with no DOM.
 */
export function resolveTheme(
  mode: ThemeMode,
  prefersDark: boolean,
): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

/** Read the live OS dark-mode preference. */
function osPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * Resolve `mode` against the current OS preference and write it to
 * `<html data-theme="…">`. Returns the resolved theme so the caller
 * can rebuild the CodeMirror theme from the now-current token values.
 */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode, osPrefersDark());
  document.documentElement.setAttribute("data-theme", resolved);
  return resolved;
}

/**
 * Subscribe to OS appearance changes. `onChange` fires with the new
 * resolved theme whenever `prefers-color-scheme` flips; the caller
 * decides whether to act (only relevant while the user is in `system`
 * mode). Returns an unsubscribe function for `onCleanup`.
 */
export function watchSystemTheme(
  onChange: (resolved: ResolvedTheme) => void,
): () => void {
  const mq = window.matchMedia(DARK_QUERY);
  const handler = (e: MediaQueryListEvent): void => {
    onChange(e.matches ? "dark" : "light");
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
