// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import type { DanglingLinkGroup } from "../api/integrity";

const listDanglingLinks = vi.fn();
const repairDanglingLink = vi.fn();

vi.mock("../api/integrity", () => ({
  listDanglingLinks: (...args: unknown[]) => listDanglingLinks(...args),
  repairDanglingLink: (...args: unknown[]) => repairDanglingLink(...args),
}));

import IntegrityPanel from "./IntegrityPanel";

const flush = () => new Promise((r) => setTimeout(r, 0));

const GROUP: DanglingLinkGroup = {
  target_raw: "plan",
  missing_path: "notes/plan.md",
  total: 2,
  occurrences: [{ source_path: "src.md", count: 2 }],
  candidates: [
    { path: "archive/roadmap.md", rank: "frontmatter_title" },
    { path: "notes/planning.md", rank: "case_insensitive_basename" },
  ],
};

let dispose: (() => void) | undefined;

beforeEach(() => {
  listDanglingLinks.mockReset();
  repairDanglingLink.mockReset();
  listDanglingLinks.mockResolvedValue({ groups: [GROUP], truncated: false });
  repairDanglingLink.mockResolvedValue({
    files_rewritten: 1,
    refs_updated: 2,
    pending_count: 0,
  });
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function mount(el: () => unknown) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el as never, host);
  return host;
}

const noop = () => {};

describe("IntegrityPanel", () => {
  it("lists a dangling group with its token, missing path and referrers", async () => {
    const host = mount(() => (
      <IntegrityPanel vaultId="v1" refreshSignal={0} onRowClick={noop} />
    ));
    await flush();

    expect(listDanglingLinks).toHaveBeenCalledWith({ vault_id: "v1" });
    const text = host.textContent ?? "";
    expect(text).toContain("[[plan]]");
    expect(text).toContain("was notes/plan.md");
    expect(text).toContain("src.md");
    expect(text).toContain("2 links in 1 note");
  });

  it("shows the empty state when nothing is dangling", async () => {
    listDanglingLinks.mockResolvedValue({ groups: [], truncated: false });
    const host = mount(() => (
      <IntegrityPanel vaultId="v1" refreshSignal={0} onRowClick={noop} />
    ));
    await flush();
    expect(host.textContent).toContain("No dangling links");
  });

  it("hides candidates until the user opens the reattach chooser", async () => {
    const host = mount(() => (
      <IntegrityPanel vaultId="v1" refreshSignal={0} onRowClick={noop} />
    ));
    await flush();

    expect(host.querySelector(".ds-popover__panel")).toBeNull();
    expect(repairDanglingLink).not.toHaveBeenCalled();

    const toggle = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Reattach to…",
    )!;
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const panel = host.querySelector(".ds-popover__panel");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("archive/roadmap.md");
    expect(panel!.textContent).toContain("title matches");
    expect(repairDanglingLink).not.toHaveBeenCalled();
  });

  it("repairs only the candidate the user picked, then reloads", async () => {
    const onRepaired = vi.fn();
    const host = mount(() => (
      <IntegrityPanel
        vaultId="v1"
        refreshSignal={0}
        onRowClick={noop}
        onRepaired={onRepaired}
      />
    ));
    await flush();

    const toggle = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Reattach to…",
    )!;
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const pick = host.querySelector(
      '[aria-label="Reattach [[plan]] to notes/planning.md"]',
    )!;
    pick.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(repairDanglingLink).toHaveBeenCalledTimes(1);
    expect(repairDanglingLink).toHaveBeenCalledWith({
      vault_id: "v1",
      target_raw: "plan",
      to_path: "notes/planning.md",
    });
    expect(onRepaired).toHaveBeenCalledTimes(1);
    expect(listDanglingLinks).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".ds-popover__panel")).toBeNull();
  });

  it("opens a referring note when its row is clicked", async () => {
    const onRowClick = vi.fn();
    const host = mount(() => (
      <IntegrityPanel vaultId="v1" refreshSignal={0} onRowClick={onRowClick} />
    ));
    await flush();

    const row = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "src.md",
    )!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRowClick).toHaveBeenCalledWith("src.md");
  });

  it("surfaces a query failure as an alert", async () => {
    listDanglingLinks.mockRejectedValue(new Error("index offline"));
    const host = mount(() => (
      <IntegrityPanel vaultId="v1" refreshSignal={0} onRowClick={noop} />
    ));
    await flush();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("index offline");
  });

  it("stays idle with no vault open", async () => {
    const host = mount(() => (
      <IntegrityPanel vaultId={null} refreshSignal={0} onRowClick={noop} />
    ));
    await flush();
    expect(listDanglingLinks).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Open a vault");
  });
});

describe("IntegrityPanel — a refresh must not blank the list", () => {
  it("keeps rows on screen while a same-vault refresh is in flight", async () => {
    const [tick, setTick] = createSignal(0);
    const host = mount(() => (
      <IntegrityPanel vaultId="v1" refreshSignal={tick()} onRowClick={noop} />
    ));
    await flush();
    expect(host.textContent).toContain("plan");

    let release!: (v: {
      groups: DanglingLinkGroup[];
      truncated: boolean;
    }) => void;
    listDanglingLinks.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve as never;
      }),
    );

    setTick(1);
    await flush();

    expect(host.textContent).not.toContain("Loading…");
    expect(host.textContent).toContain("plan");

    release({ groups: [{ ...GROUP }], truncated: false });
    await flush();
    expect(host.textContent).toContain("plan");
  });

  it("shows the new groups after a refresh that changed them", async () => {
    const [tick, setTick] = createSignal(0);
    const host = mount(() => (
      <IntegrityPanel vaultId="v1" refreshSignal={tick()} onRowClick={noop} />
    ));
    await flush();
    expect(host.textContent).toContain("[[plan]]");

    listDanglingLinks.mockResolvedValue({
      groups: [{ ...GROUP, target_raw: "roadmap", missing_path: "roadmap.md" }],
      truncated: false,
    });
    setTick(1);
    await flush();

    expect(host.textContent).toContain("[[roadmap]]");
    expect(host.textContent).not.toContain("[[plan]]");
  });

  it("reuses the row DOM node across a refresh that changed nothing", async () => {
    const [tick, setTick] = createSignal(0);
    const host = mount(() => (
      <IntegrityPanel vaultId="v1" refreshSignal={tick()} onRowClick={noop} />
    ));
    await flush();
    const before = host.querySelector('li[role="listitem"]');
    expect(before).not.toBeNull();

    listDanglingLinks.mockResolvedValue({
      groups: [
        {
          ...GROUP,
          occurrences: GROUP.occurrences.map((o) => ({ ...o })),
          candidates: GROUP.candidates.map((c) => ({ ...c })),
        },
      ],
      truncated: false,
    });
    setTick(1);
    await flush();

    expect(host.querySelector('li[role="listitem"]')).toBe(before);
  });

  it("still blanks to loading when the vault changes", async () => {
    const [vault, setVault] = createSignal("v1");
    const host = mount(() => (
      <IntegrityPanel vaultId={vault()} refreshSignal={0} onRowClick={noop} />
    ));
    await flush();
    expect(host.textContent).toContain("plan");

    listDanglingLinks.mockReturnValueOnce(new Promise(() => {}));
    setVault("v2");
    await flush();

    expect(host.textContent).toContain("Loading…");
    expect(host.textContent).not.toContain("notes/plan.md");
  });
});

describe("IntegrityPanel — responses outliving their vault", () => {
  it("drops a list response that lands after the vault closed", async () => {
    const [vault, setVault] = createSignal<string | null>("v1");
    let release!: (v: { groups: DanglingLinkGroup[]; truncated: boolean }) => void;
    listDanglingLinks.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve as never;
      }),
    );
    const host = mount(() => (
      <IntegrityPanel vaultId={vault()} refreshSignal={0} onRowClick={noop} />
    ));
    await flush();

    setVault(null);
    release({ groups: [GROUP], truncated: false });
    await flush();

    expect(host.textContent).toContain("Open a vault");
    expect(host.textContent).not.toContain("[[plan]]");
  });

  it("does not reload the old vault when a repair finishes after a switch", async () => {
    const [vault, setVault] = createSignal("v1");
    const onRepaired = vi.fn();
    const host = mount(() => (
      <IntegrityPanel
        vaultId={vault()}
        refreshSignal={0}
        onRowClick={noop}
        onRepaired={onRepaired}
      />
    ));
    await flush();

    let finish!: (v: unknown) => void;
    repairDanglingLink.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const toggle = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Reattach to…",
    )!;
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    host
      .querySelector('[aria-label="Reattach [[plan]] to notes/planning.md"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    listDanglingLinks.mockResolvedValue({ groups: [], truncated: false });
    setVault("v2");
    await flush();
    listDanglingLinks.mockClear();

    finish({ files_rewritten: 1, refs_updated: 2, pending_count: 0 });
    await flush();

    expect(listDanglingLinks).not.toHaveBeenCalled();
    expect(onRepaired).not.toHaveBeenCalled();
    expect(host.textContent).toContain("No dangling links");
  });
});
