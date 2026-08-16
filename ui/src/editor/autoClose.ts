import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

const PAIRS = ["(", "[", "{"];

const bracketLanguageData = EditorState.languageData.of(() => [
  { closeBrackets: { brackets: PAIRS } },
]);

const FENCE = /^(\s*)(`{3,}|~{3,})([^`~]*)$/;

export interface Fence {
  indent: string;
  marker: string;
}

export function openerAt(line: string): Fence | null {
  const m = FENCE.exec(line);
  if (m === null) return null;
  const info = (m[3] ?? "").trim();
  if (info.includes("`") || info.includes("~")) return null;
  return { indent: m[1] ?? "", marker: m[2] ?? "" };
}

export function isOpenAbove(before: string): boolean {
  let open: Fence | null = null;
  for (const line of before.split("\n")) {
    const m = FENCE.exec(line);
    if (m === null) continue;
    const marker = m[2] ?? "";
    const info = (m[3] ?? "").trim();
    if (open === null) {
      open = { indent: m[1] ?? "", marker };
      continue;
    }
    if (marker[0] !== open.marker[0]) continue;
    if (marker.length < open.marker.length) continue;
    if (info.length !== 0) continue;
    open = null;
  }
  return open !== null;
}

export function isClosedBelow(after: string, fence: Fence): boolean {
  for (const line of after.split("\n")) {
    const m = FENCE.exec(line);
    if (m === null) continue;
    if (!(m[2] ?? "").startsWith(fence.marker[0] ?? "")) continue;
    return (m[3] ?? "").trim().length === 0;
  }
  return false;
}

export function closingInsert(fence: Fence): string {
  return `\n\n${fence.indent}${fence.marker}`;
}

export function completeFence(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  if (range.head !== line.to) return false;

  const fence = openerAt(line.text);
  if (fence === null) return false;
  if (isOpenAbove(state.sliceDoc(0, line.from))) return false;
  if (isClosedBelow(state.sliceDoc(line.to, state.doc.length), fence)) {
    return false;
  }

  view.dispatch({
    changes: { from: line.to, insert: closingInsert(fence) },
    selection: { anchor: line.to + 1 },
    scrollIntoView: true,
    userEvent: "input.complete",
  });
  return true;
}

// defaultKeymap is registered ahead of this and binds Enter and Backspace, so
// both handlers have to outrank it to ever run.
export const autoCloseExtension: Extension = [
  bracketLanguageData,
  closeBrackets(),
  Prec.high(
    keymap.of([{ key: "Enter", run: completeFence }, ...closeBracketsKeymap]),
  ),
];
