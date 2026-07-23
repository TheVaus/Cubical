export interface LaidLine {
  text: string;
}

export interface MinimapLayout {
  lines: LaidLine[];
  contentHeight: number;
}

export interface ViewportInfo {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface IndicatorRect {
  top: number;
  height: number;
}

export interface MinimapColors {
  text: string;
  background: string;
  indicator: string;
}
