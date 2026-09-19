// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import RenameInput from "./RenameInput";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const mount = () => {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  dispose = render(
    () => <RenameInput value="a.md" onCommit={onCommit} onCancel={onCancel} />,
    host,
  );
  const input = host.querySelector("input")!;
  const key = (k: string) =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  const blur = () => input.dispatchEvent(new FocusEvent("blur"));
  return { input, key, blur, onCommit, onCancel };
};

describe("RenameInput", () => {
  it("commits once when Enter is followed by the blur of its removal", () => {
    const r = mount();
    r.key("Enter");
    r.blur();
    expect(r.onCommit).toHaveBeenCalledTimes(1);
  });

  it("does not commit when Escape is followed by a blur", () => {
    const r = mount();
    r.key("Escape");
    r.blur();
    expect(r.onCancel).toHaveBeenCalledTimes(1);
    expect(r.onCommit).not.toHaveBeenCalled();
  });

  it("commits on a plain blur", () => {
    const r = mount();
    r.blur();
    expect(r.onCommit).toHaveBeenCalledWith("a.md");
  });

  it("takes focus on every mount, not only the first autofocus", async () => {
    mount();
    dispose?.();
    const r = mount();
    await Promise.resolve();
    expect(document.activeElement).toBe(r.input);
  });
});
