// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import FeatureBoundary from "./FeatureBoundary";

let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mount(el: () => unknown): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el as never, host);
  return host;
}

const Bomb = () => {
  throw new Error("feature exploded");
};

describe("FeatureBoundary", () => {
  it("keeps a sibling feature mounted when one throws", () => {
    const host = mount(() => (
      <>
        <FeatureBoundary feature="Graph">
          <Bomb />
        </FeatureBoundary>
        <FeatureBoundary feature="Editor">
          <p>the note is still here</p>
        </FeatureBoundary>
      </>
    ));

    expect(host.textContent).toContain("the note is still here");
    expect(host.textContent).toContain("Graph stopped");
    expect(host.textContent).toContain("feature exploded");
  });

  it("names the feature that failed, not the one that did not", () => {
    const host = mount(() => (
      <FeatureBoundary feature="File viewer">
        <Bomb />
      </FeatureBoundary>
    ));

    expect(host.textContent).toContain("File viewer stopped");
    expect(host.textContent).not.toContain("Editor");
  });

  it("renders the feature again after Try again", () => {
    const [broken, setBroken] = createSignal(true);
    const Flaky = () => {
      if (broken()) throw new Error("not yet");
      return <p>recovered</p>;
    };

    const host = mount(() => (
      <FeatureBoundary feature="Terminal">
        <Flaky />
      </FeatureBoundary>
    ));
    expect(host.textContent).toContain("Terminal stopped");

    setBroken(false);
    const retry = host.querySelector("button");
    retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(host.textContent).toContain("recovered");
    expect(host.textContent).not.toContain("Terminal stopped");
  });

  it("logs the failure so it is not swallowed", () => {
    mount(() => (
      <FeatureBoundary feature="Status bar">
        <Bomb />
      </FeatureBoundary>
    ));

    expect(console.error).toHaveBeenCalledWith(
      "Status bar failed",
      expect.any(Error),
    );
  });
});
