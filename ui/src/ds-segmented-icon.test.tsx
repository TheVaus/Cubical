// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render } from "solid-js/web";
import SegmentedControl from "@ds/components/forms/SegmentedControl/SegmentedControl";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

describe("SegmentedControl icon option", () => {
  it("renders an icon before the label when icon is set", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    dispose = render(
      () => (
        <SegmentedControl
          options={[{ label: "dark", value: "dark", icon: "moon" }]}
          value="dark"
          onChange={() => {}}
        />
      ),
      host,
    );
    expect(host.querySelector("svg.ds-icon")).not.toBeNull();
    expect(host.textContent).toContain("dark");
  });

  it("renders no icon when icon is absent (prior behavior)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    dispose = render(
      () => (
        <SegmentedControl
          options={[{ label: "light", value: "light" }]}
          value="light"
          onChange={() => {}}
        />
      ),
      host,
    );
    expect(host.querySelector("svg.ds-icon")).toBeNull();
  });
});
