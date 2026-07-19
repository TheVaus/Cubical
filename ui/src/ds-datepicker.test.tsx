// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render } from "solid-js/web";
import DatePicker from "@ds/components/forms/DatePicker/DatePicker";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host.querySelector("input")!;
}

describe("DatePicker", () => {
  it("renders a native date input by default", () => {
    const input = mount(() => <DatePicker value="" onInput={() => {}} />);
    expect(input.type).toBe("date");
  });

  it("renders a datetime-local input when type='datetime-local'", () => {
    const input = mount(() => (
      <DatePicker type="datetime-local" value="" onInput={() => {}} />
    ));
    expect(input.type).toBe("datetime-local");
  });

  it("reflects the value prop", () => {
    const input = mount(() => <DatePicker value="2026-07-19" onInput={() => {}} />);
    expect(input.value).toBe("2026-07-19");
  });

  it("fires onInput with the value string on input", () => {
    let received: string | undefined;
    const input = mount(() => (
      <DatePicker value="" onInput={(v) => { received = v; }} />
    ));
    input.value = "2026-07-19";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(received).toBe("2026-07-19");
  });

  it("fires onChange with the value string on change", () => {
    let received: string | undefined;
    const input = mount(() => (
      <DatePicker value="" onInput={() => {}} onChange={(v) => { received = v; }} />
    ));
    input.value = "2026-07-19";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(received).toBe("2026-07-19");
  });

  it("forwards ref to the underlying input element", () => {
    let received: HTMLInputElement | undefined;
    const input = mount(() => (
      <DatePicker value="" onInput={() => {}} ref={(el) => { received = el; }} />
    ));
    expect(received).toBe(input);
  });
});
