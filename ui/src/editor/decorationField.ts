import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import {
  StateField,
  type EditorState,
  type StateEffectType,
  type Transaction,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

export interface DecorationFieldSpec {
  build: (state: EditorState) => DecorationSet;
  effects?: readonly StateEffectType<null>[];
  watch?: readonly ((state: EditorState) => unknown)[];
}

const activeLine = (state: EditorState): number =>
  state.doc.lineAt(state.selection.main.head).number;

export function decorationsAreStale(
  spec: DecorationFieldSpec,
  tr: Transaction,
): boolean {
  if (tr.docChanged) return true;
  if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) return true;
  if (activeLine(tr.startState) !== activeLine(tr.state)) return true;
  if (spec.effects?.some((kind) => tr.effects.some((e) => e.is(kind)))) {
    return true;
  }
  return (
    spec.watch?.some((read) => read(tr.startState) !== read(tr.state)) ?? false
  );
}

export function decorationField(
  spec: DecorationFieldSpec,
): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: (state) => spec.build(state),
    update: (deco, tr) =>
      decorationsAreStale(spec, tr) ? spec.build(tr.state) : deco,
    provide: (f) => [
      EditorView.decorations.from(f),
      EditorView.atomicRanges.of(
        (view) => view.state.field(f, false) ?? Decoration.none,
      ),
    ],
  });
}
