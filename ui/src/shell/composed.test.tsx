// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { EditorView } from "@codemirror/view";

import type { PropertyResolver } from "../editor/propertySlot";
import { Editor } from "./composed";

const DOC =
  "intro\n\n$$E = mc^2$$\n\nShe was `= 5-3` old.\n\nAge: [[Gandalf.age]].\n\ntail\n";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function countingResolver() {
  let gets = 0;
  const resolver: PropertyResolver = {
    get: () => {
      gets++;
      return { kind: "resolved", value: 2019 };
    },
    fetch: () => undefined,
    resolve: () => Promise.reject(new Error("not used")),
    invalidate: () => undefined,
    markStale: () => undefined,
    onUpdate: () => () => undefined,
    version: () => 0,
  };
  return { resolver, gets: () => gets };
}

function mount() {
  const [math, setMath] = createSignal(true);
  const [equations, setEquations] = createSignal(true);
  const [propertyRefs, setPropertyRefs] = createSignal(true);
  const [raw, setRaw] = createSignal(false);
  const { resolver, gets } = countingResolver();
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <Editor
        value={DOC}
        resolvedTheme="light"
        rawSource={raw()}
        propertyResolver={resolver}
        mathEnabled={math()}
        equationsEnabled={equations()}
        propertyRefsEnabled={propertyRefs()}
      />
    ),
    host,
  );
  const editor = host.querySelector<HTMLElement>(".cm-editor");
  const view = editor ? EditorView.findFromDOM(editor) : null;
  if (!view) throw new Error("editor did not mount");
  const shown = () => ({
    math: host.querySelector(".cm-math") !== null,
    equation: host.querySelector(".cm-equation") !== null,
    propertyRef: host.querySelector(".cm-md-propref") !== null,
  });
  return {
    view,
    host,
    shown,
    gets,
    setMath,
    setEquations,
    setPropertyRefs,
    setRaw,
  };
}

describe("composed Editor preview toggles", () => {
  it("renders every preview block by default", () => {
    const { shown } = mount();
    expect(shown()).toEqual({ math: true, equation: true, propertyRef: true });
  });

  it("switches one block off and on in the live view", () => {
    const { view, host, shown, setMath, setPropertyRefs } = mount();

    setMath(false);
    expect(shown()).toEqual({ math: false, equation: true, propertyRef: true });

    setPropertyRefs(false);
    expect(shown()).toEqual({ math: false, equation: true, propertyRef: false });

    setMath(true);
    setPropertyRefs(true);
    expect(shown()).toEqual({ math: true, equation: true, propertyRef: true });
    expect(EditorView.findFromDOM(host.querySelector(".cm-editor")!)).toBe(view);
  });

  it("does not resolve property refs again when another block toggles", () => {
    const { gets, setMath, setEquations } = mount();
    const before = gets();

    setMath(false);
    setMath(true);
    setEquations(false);

    expect(gets()).toBe(before);
  });

  it("applies a toggle flipped while raw source is on once raw turns off", () => {
    const { shown, setRaw, setEquations } = mount();

    setRaw(true);
    expect(shown()).toEqual({ math: false, equation: false, propertyRef: false });

    setEquations(false);
    setRaw(false);
    expect(shown()).toEqual({ math: true, equation: false, propertyRef: true });
  });
});
