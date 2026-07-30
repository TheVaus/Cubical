export const COLOR_TOKENS = [
  "--c-bg-primary",
  "--c-fg-primary",
  "--c-fg-muted",
  "--c-border-subtle",
  "--c-border-strong",
  "--editor-caret",
  "--editor-selection-bg",
  "--term-ansi-black",
  "--term-ansi-red",
  "--term-ansi-green",
  "--term-ansi-yellow",
  "--term-ansi-blue",
  "--term-ansi-magenta",
  "--term-ansi-cyan",
  "--term-ansi-white",
  "--term-ansi-bright-black",
  "--term-ansi-bright-red",
  "--term-ansi-bright-green",
  "--term-ansi-bright-yellow",
  "--term-ansi-bright-blue",
  "--term-ansi-bright-magenta",
  "--term-ansi-bright-cyan",
  "--term-ansi-bright-white",
] as const;

export const METRIC_TOKENS = ["--font-mono", "--text-sm", "--leading-tight"] as const;

export const TERMINAL_TOKENS = [...COLOR_TOKENS, ...METRIC_TOKENS] as const;

export type TerminalToken = (typeof TERMINAL_TOKENS)[number];

export type TerminalTokens = Record<TerminalToken, string>;

export type TerminalThemeKey =
  | "foreground"
  | "background"
  | "cursor"
  | "cursorAccent"
  | "selectionBackground"
  | "selectionInactiveBackground"
  | "scrollbarSliderBackground"
  | "scrollbarSliderHoverBackground"
  | "scrollbarSliderActiveBackground"
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

export type TerminalTheme = Partial<Record<TerminalThemeKey, string>>;

export interface TerminalAppearance {
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

export const DEFAULT_FONT_SIZE = 13;

export const DEFAULT_LINE_HEIGHT = 1.2;

const THEME_MAP: Record<TerminalThemeKey, (typeof COLOR_TOKENS)[number]> = {
  foreground: "--c-fg-primary",
  background: "--c-bg-primary",
  cursor: "--editor-caret",
  cursorAccent: "--c-bg-primary",
  selectionBackground: "--editor-selection-bg",
  selectionInactiveBackground: "--editor-selection-bg",
  scrollbarSliderBackground: "--c-border-subtle",
  scrollbarSliderHoverBackground: "--c-border-strong",
  scrollbarSliderActiveBackground: "--c-fg-muted",
  black: "--term-ansi-black",
  red: "--term-ansi-red",
  green: "--term-ansi-green",
  yellow: "--term-ansi-yellow",
  blue: "--term-ansi-blue",
  magenta: "--term-ansi-magenta",
  cyan: "--term-ansi-cyan",
  white: "--term-ansi-white",
  brightBlack: "--term-ansi-bright-black",
  brightRed: "--term-ansi-bright-red",
  brightGreen: "--term-ansi-bright-green",
  brightYellow: "--term-ansi-bright-yellow",
  brightBlue: "--term-ansi-bright-blue",
  brightMagenta: "--term-ansi-bright-magenta",
  brightCyan: "--term-ansi-bright-cyan",
  brightWhite: "--term-ansi-bright-white",
};

function positiveNumber(raw: string, fallback: number): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function deriveTerminalTheme(tokens: TerminalTokens): TerminalTheme {
  const theme: TerminalTheme = {};
  for (const key of Object.keys(THEME_MAP) as TerminalThemeKey[]) {
    const value = (tokens[THEME_MAP[key]] ?? "").trim();
    if (value !== "") theme[key] = value;
  }
  return theme;
}

export function deriveTerminalAppearance(
  tokens: TerminalTokens,
): TerminalAppearance {
  const fontFamily = (tokens["--font-mono"] ?? "").trim();
  return {
    theme: deriveTerminalTheme(tokens),
    fontFamily: fontFamily === "" ? "monospace" : fontFamily,
    fontSize: positiveNumber(tokens["--text-sm"] ?? "", DEFAULT_FONT_SIZE),
    lineHeight: positiveNumber(
      tokens["--leading-tight"] ?? "",
      DEFAULT_LINE_HEIGHT,
    ),
  };
}

export function readTerminalTokens(): TerminalTokens {
  const computed = getComputedStyle(document.documentElement);
  const tokens = {} as TerminalTokens;
  for (const token of TERMINAL_TOKENS) {
    tokens[token] = computed.getPropertyValue(token).trim();
  }
  return tokens;
}

export function readTerminalAppearance(): TerminalAppearance {
  return deriveTerminalAppearance(readTerminalTokens());
}
