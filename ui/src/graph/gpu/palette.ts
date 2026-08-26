import { packRgba, type Palette } from "./instances";

export const FALLBACK = "#8a8374";

export function parseColour(css: string, alpha = 1): number {
  const value = css.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const digits = hex[1]!;
    const full =
      digits.length === 3
        ? digits
            .split("")
            .map((d) => d + d)
            .join("")
        : digits;
    return packRgba(
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      alpha,
    );
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgb !== null) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter((p) => p.length > 0);
    const [r, g, b, a] = parts.map((p) => Number.parseFloat(p));
    if (r !== undefined && g !== undefined && b !== undefined) {
      return packRgba(r, g, b, a === undefined ? alpha : a * alpha);
    }
  }
  return packRgba(138, 131, 116, alpha);
}

export function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(name) || FALLBACK;
  return {
    note: parseColour(token("--c-accent")),
    attachment: parseColour(token("--c-fg-muted")),
    ghost: parseColour(token("--c-border-subtle")),
    tag: parseColour(token("--c-fg-primary"), 0.7),
    edge: parseColour(token("--c-fg-muted"), 0.35),
  };
}
