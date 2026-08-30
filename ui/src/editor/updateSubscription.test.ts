import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { createUpdateSubscriber } from "./updateSubscription";
import type { UpdateSource } from "./updateSubscription";

const effect = StateEffect.define<null>();

function fakeSource() {
  let handlers: (() => void)[] = [];
  const source: UpdateSource = {
    onUpdate(handler) {
      handlers.push(handler);
      return () => {
        handlers = handlers.filter((h) => h !== handler);
      };
    },
  };
  return { source, fire: () => handlers.forEach((h) => h()), count: () => handlers.length };
}

function fakeView() {
  const dispatched: unknown[] = [];
  const view = { dispatch: (spec: unknown) => dispatched.push(spec) };
  return { view: view as unknown as EditorView, dispatched };
}

describe("createUpdateSubscriber", () => {
  it("dispatches the effect when the source updates", () => {
    createRoot((dispose) => {
      const { source, fire } = fakeSource();
      const { view, dispatched } = fakeView();

      createUpdateSubscriber(effect)(source, view);
      fire();

      expect(dispatched).toHaveLength(1);
      dispose();
    });
  });

  it("releases the previous subscription when the source is replaced", () => {
    createRoot((dispose) => {
      const first = fakeSource();
      const second = fakeSource();
      const { view } = fakeView();

      const subscribe = createUpdateSubscriber(effect);
      subscribe(first.source, view);
      subscribe(second.source, view);

      expect(first.count()).toBe(0);
      expect(second.count()).toBe(1);
      dispose();
    });
  });

  it("releases the subscription when the owner is disposed", () => {
    const { source, count } = fakeSource();
    const { view } = fakeView();

    createRoot((dispose) => {
      createUpdateSubscriber(effect)(source, view);
      expect(count()).toBe(1);
      dispose();
    });

    expect(count()).toBe(0);
  });

  it("does not subscribe without a source or a view", () => {
    createRoot((dispose) => {
      const { source, count } = fakeSource();
      const subscribe = createUpdateSubscriber(effect);

      subscribe(null, fakeView().view);
      subscribe(source, undefined);

      expect(count()).toBe(0);
      dispose();
    });
  });
});
