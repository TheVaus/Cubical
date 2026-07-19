// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render } from "solid-js/web";
import Icon from "@ds/components/graphics/Icon/Icon";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host.querySelector("svg")!;
}

describe("Icon", () => {
  it("defaults to 16px and is decorative when unlabeled", () => {
    const svg = mount(() => <Icon name="plus" />);
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
  });

  it("honors an explicit size", () => {
    const svg = mount(() => <Icon name="warning" size={20} />);
    expect(svg.getAttribute("width")).toBe("20");
  });

  it("is announced when labeled", () => {
    const svg = mount(() => <Icon name="info" ariaLabel="Details" />);
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Details");
    expect(svg.getAttribute("aria-hidden")).toBeNull();
  });
});
