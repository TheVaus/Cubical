/**
 * Vertical cursor motion correction around tall block decorations
 * (L4-A-fix, embed cursor-jump).
 *
 * CM6 computes ArrowUp/ArrowDown from screen geometry: it moves the
 * cursor up/down by roughly one line-height and resolves the position
 * at those coordinates. A rendered embed card is a single *document*
 * line but occupies *many* screen rows, so "one line-height up/down"
 * lands inside the card's vertical span. Because the card is an atomic
 * block, CM snaps to the document line before/after the whole card —
 * overshooting by one or more document lines and making it impossible
 * to land the cursor on the embed line (where the raw source would be
 * revealed for editing).
 *
 * atomicRanges does NOT help here: it governs logical (horizontal)
 * motion, not geometric vertical motion. The fix is at the input
 * layer — detect when geometric motion overshoots by more than one
 * document line (which only happens at a tall block) and correct it to
 * exactly one document line. Normal lines (including soft-wrapped
 * paragraphs, whose visual motion stays within ±1 document line) never
 * overshoot, so their default visual motion is left untouched.
 */

import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * Decide whether the default geometric vertical motion overshot, and
 * if so return the corrected cursor head (exactly one document line
 * from the start, same column clamped). Returns `null` to accept the
 * default motion.
 *
 * Pure over `EditorState` — no view/layout — so it is unit-testable.
 *
 * @param state       current editor state
 * @param startHead   cursor head before the move
 * @param visualHead  head the default geometric motion would land on
 * @param forward     true for ArrowDown, false for ArrowUp
 */
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

/**
 * Keymap command for one vertical direction. Computes the default
 * geometric target, and if it overshot a tall block, dispatches the
 * corrected single-document-line move instead. Returns `false` (so the
 * default keymap runs) when no correction is needed or when the
 * selection is non-empty (shift-select / range — leave to default).
 */
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
