// Invariants shared by every inline SVG mark (Icon, CubeMark, FileIcon).
// viewBox and stroke-width stay per-component; only these are shared.
export const SVG_INVARIANTS = {
  fill: "none",
  stroke: "currentColor",
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
};
