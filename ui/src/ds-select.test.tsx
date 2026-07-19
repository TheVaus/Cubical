// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render } from "solid-js/web";
import Select from "@ds/components/forms/Select/Select";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host.querySelector("select")!;
}

describe("Select", () => {
  it("renders one option per option, using label ?? value, and reflects the value prop", () => {
    const select = mount(() => (
      <Select
        options={[{ value: "a" }, { value: "b", label: "Bee" }]}
        value="b"
        onChange={() => {}}
      />
    ));
    const options = Array.from(select.querySelectorAll("option"));
    expect(options).toHaveLength(2);
    expect(options[0]?.value).toBe("a");
    expect(options[0]?.textContent).toBe("a");
    expect(options[1]?.value).toBe("b");
    expect(options[1]?.textContent).toBe("Bee");
    expect(select.value).toBe("b");
  });

  it("fires onChange with the option's value string when changed", () => {
    let received: string | undefined;
    const select = mount(() => (
      <Select
        options={[{ value: "a" }, { value: "b" }]}
        value="a"
        onChange={(v) => { received = v; }}
      />
    ));
    select.value = "b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(received).toBe("b");
  });

  it("disables the native select when disabled is set", () => {
    const select = mount(() => (
      <Select
        options={[{ value: "a" }]}
        value="a"
        onChange={() => {}}
        disabled
      />
    ));
    expect(select.disabled).toBe(true);
  });
});
