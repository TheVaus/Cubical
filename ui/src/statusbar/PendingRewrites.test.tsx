// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

vi.mock("../api/ipc", () => ({
  flushPendingRewrites: vi.fn(),
  getPendingRewritesBreakdown: vi.fn(),
  listRecentRenameOps: vi.fn(),
  undoRename: vi.fn(),
}));

import {
  flushPendingRewrites,
  getPendingRewritesBreakdown,
  listRecentRenameOps,
} from "../api/ipc";
import PendingRewrites from "./PendingRewrites";

const flush = flushPendingRewrites as unknown as ReturnType<typeof vi.fn>;
const breakdown = getPendingRewritesBreakdown as unknown as ReturnType<
  typeof vi.fn
>;
const ops = listRecentRenameOps as unknown as ReturnType<typeof vi.fn>;

let dispose: (() => void) | undefined;

const mount = (initialCount: number) => {
  const [count, setCount] = createSignal(initialCount);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <PendingRewrites vaultId="v1" count={count()} onError={() => {}} />
    ),
    host,
  );
  return { host, setCount };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

const badge = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>("button[aria-expanded]");

const popoverOpen = (host: HTMLElement) =>
  host.querySelector('[role="dialog"]') !== null;

beforeEach(() => {
  flush.mockReset();
  breakdown.mockReset();
  breakdown.mockResolvedValue({ rows: [{ target_file: "a.md", count: 1 }] });
  ops.mockReset();
  ops.mockResolvedValue({ ops: [] });
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("PendingRewrites", () => {
  it("does not reopen by itself when the count drops to zero and comes back", async () => {
    const { host, setCount } = mount(1);
    badge(host)!.click();
    await settle();
    expect(popoverOpen(host)).toBe(true);

    setCount(0);
    setCount(2);
    await settle();

    expect(popoverOpen(host)).toBe(false);
  });

  it("stays closed when a flush lands after the popover was dismissed", async () => {
    let land: () => void = () => {};
    flush.mockReturnValue(
      new Promise<void>((r) => {
        land = r;
      }),
    );
    const { host } = mount(1);
    badge(host)!.click();
    await settle();
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent === "Save all pending changes")!
      .click();

    badge(host)!.click();
    expect(popoverOpen(host)).toBe(false);
    land();
    await settle();

    expect(popoverOpen(host)).toBe(false);
  });
});
