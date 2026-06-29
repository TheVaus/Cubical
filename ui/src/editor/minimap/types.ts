/** Shared types for the document minimap (read-only Pretext canvas strip). */

/** One wrapped row of the laid-out document (v1: text only). */
export interface LaidLine {
  text: string;
}

/** A full-document layout at minimap scale. */
export interface MinimapLayout {
  lines: LaidLine[];
  /** Total pixel height of all lines at the chosen line height. */
  contentHeight: number;
}

/** The editor scroll geometry the minimap mirrors. */
export interface ViewportInfo {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** The viewport-indicator rectangle, in strip-local pixels. */
export interface IndicatorRect {
  top: number;
  height: number;
}

/** Colors pulled from the resolved CM theme. */
export interface MinimapColors {
  text: string;
  background: string;
  indicator: string;
}
