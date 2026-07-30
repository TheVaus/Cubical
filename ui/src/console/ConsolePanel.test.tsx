// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

vi.mock("../api/ipc", () => ({
  consoleExec: vi.fn(async () => ({ stdout: "A.md\nB.md\n", stderr: "", code: 0 })),
}));

import { ConsolePanel } from "./ConsolePanel";
import { consoleExec } from "../api/ipc";

const flush = () => new Promise((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host;
}

function typeAndSubmit(input: HTMLInputElement, line: string) {
  input.value = line;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

describe("ConsolePanel", () => {
  it("runs a line and renders stdout in the scrollback, then clears the input", async () => {
    const host = mount(() => <ConsolePanel vaultId="v1" />);
    const input = host.querySelector('[aria-label="Console input"]') as HTMLInputElement;
    typeAndSubmit(input, "list");
    expect(consoleExec).toHaveBeenCalledWith("v1", "list");
    await flush();
    const text = host.querySelector(".console__scrollback")!.textContent;
    expect(text).toContain("A.md");
    expect(text).toContain("B.md");
    expect(input.value).toBe("");
  });

  it("recalls the previous command with ArrowUp", async () => {
    const host = mount(() => <ConsolePanel vaultId="v1" />);
    const input = host.querySelector('[aria-label="Console input"]') as HTMLInputElement;
    typeAndSubmit(input, "list");
    await flush();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(input.value).toBe("list");
  });
});
