import { describe, expect, it } from "vitest";

import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  TERMINAL_TOKENS,
  deriveTerminalAppearance,
  deriveTerminalTheme,
  type TerminalTokens,
} from "./theme";

function tokens(overrides: Partial<TerminalTokens> = {}): TerminalTokens {
  const base = {} as TerminalTokens;
  for (const token of TERMINAL_TOKENS) base[token] = "";
  return { ...base, ...overrides };
}

describe("deriveTerminalTheme", () => {
  it("takes every colour from DS tokens", () => {
    const theme = deriveTerminalTheme(
      tokens({
        "--c-fg-primary": "#e6e6e6",
        "--c-bg-primary": "#101014",
        "--editor-caret": "#7aa2f7",
        "--term-ansi-red": "#c9563c",
      }),
    );

    expect(theme.foreground).toBe("#e6e6e6");
    expect(theme.background).toBe("#101014");
    expect(theme.cursor).toBe("#7aa2f7");
    expect(theme.red).toBe("#c9563c");
  });

  it("omits a key rather than inventing a colour of its own", () => {
    const theme = deriveTerminalTheme(tokens({ "--c-fg-primary": "  " }));

    expect(theme.foreground).toBeUndefined();
    expect(Object.keys(theme)).toHaveLength(0);
  });
});

describe("deriveTerminalAppearance", () => {
  it("reads the monospace face and metrics from tokens", () => {
    const appearance = deriveTerminalAppearance(
      tokens({
        "--font-mono": "  Berkeley Mono, monospace ",
        "--text-sm": "14px",
        "--leading-tight": "1.35",
      }),
    );

    expect(appearance.fontFamily).toBe("Berkeley Mono, monospace");
    expect(appearance.fontSize).toBe(14);
    expect(appearance.lineHeight).toBe(1.35);
  });

  it("falls back when a token is missing or not a usable number", () => {
    const appearance = deriveTerminalAppearance(
      tokens({ "--text-sm": "", "--leading-tight": "0" }),
    );

    expect(appearance.fontFamily).toBe("monospace");
    expect(appearance.fontSize).toBe(DEFAULT_FONT_SIZE);
    expect(appearance.lineHeight).toBe(DEFAULT_LINE_HEIGHT);
  });

  it("refuses a unit xterm.js cannot use, rather than reading 1rem as 1px", () => {
    const appearance = deriveTerminalAppearance(
      tokens({ "--text-sm": "1rem", "--leading-tight": "1.2em" }),
    );

    expect(appearance.fontSize).toBe(DEFAULT_FONT_SIZE);
    expect(appearance.lineHeight).toBe(DEFAULT_LINE_HEIGHT);
  });
});
