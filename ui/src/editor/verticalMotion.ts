import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export function correctedVerticalHead(
  state: EditorState,
  startHead: number,
  visualHead: number,
  forward: boolean,
): number | null {
  const startLine = state.doc.lineAt(startHead).number;
  const visualLine = state.doc.lineAt(visualHead).number;
  const overshoot = forward
    ? visualLine > startLine + 1
    : visualLine < startLine - 1;
  if (!overshoot) return null;
  const targetNum = forward
    ? Math.min(startLine + 1, state.doc.lines)
    : Math.max(startLine - 1, 1);
  const startCol = startHead - state.doc.line(startLine).from;
  const targetLine = state.doc.line(targetNum);
  return Math.min(targetLine.from + startCol, targetLine.to);
}

export function verticalDocLineMotion(
  view: EditorView,
  forward: boolean,
): boolean {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const visual = view.moveVertically(range, forward);
  const corrected = correctedVerticalHead(
    view.state,
    range.head,
    visual.head,
    forward,
  );
  if (corrected === null) return false;
  view.dispatch({
    selection: EditorSelection.cursor(corrected),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}
