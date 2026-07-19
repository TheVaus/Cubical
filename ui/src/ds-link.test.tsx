// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render } from "solid-js/web";
import Link from "@ds/components/forms/Link/Link";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host;
}

describe("Link", () => {
  it("defaults to a <button type=\"button\"> with class ds-link, and fires onClick", () => {
    let clicked = 0;
    const host = mount(() => (
      <Link onClick={() => { clicked += 1; }}>Open as raw</Link>
    ));
    const button = host.querySelector("button")!;
    expect(button).toBeTruthy();
    expect(button.getAttribute("type")).toBe("button");
    expect(button.classList.contains("ds-link")).toBe(true);
    expect(host.querySelector("a")).toBeNull();
    button.click();
    expect(clicked).toBe(1);
  });

  it("renders an <a> with the given href and class ds-link when href is set", () => {
    const host = mount(() => (
      <Link href="https://example.com">Visit</Link>
    ));
    const anchor = host.querySelector("a")!;
    expect(anchor).toBeTruthy();
    expect(anchor.getAttribute("href")).toBe("https://example.com");
    expect(anchor.classList.contains("ds-link")).toBe(true);
    expect(host.querySelector("button")).toBeNull();
  });

  it("applies the xs size modifier class when size=\"xs\"", () => {
    const host = mount(() => (
      <Link size="xs" onClick={() => {}}>Small link</Link>
    ));
    const button = host.querySelector("button")!;
    expect(button.classList.contains("ds-link--xs")).toBe(true);
  });
});
