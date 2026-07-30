// @vitest-environment jsdom
import { render, fireEvent } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/ipc", () => ({
  consoleExec: vi.fn(async () => ({ stdout: "A.md\nB.md\n", stderr: "", code: 0 })),
}));

import { ConsolePanel } from "./ConsolePanel";
import { consoleExec } from "../api/ipc";

describe("ConsolePanel", () => {
  it("runs a line and renders stdout in the scrollback", async () => {
    const { getByLabelText, findByText } = render(() => <ConsolePanel vaultId="v1" />);
    const input = getByLabelText("Console input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "list" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(consoleExec).toHaveBeenCalledWith("v1", "list");
    await findByText("A.md");
    await findByText("B.md");
    expect(input.value).toBe(""); // cleared after submit
  });

  it("recalls the previous command with ArrowUp", async () => {
    const { getByLabelText, findByText } = render(() => <ConsolePanel vaultId="v1" />);
    const input = getByLabelText("Console input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "list" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await findByText("A.md");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("list");
  });
});
