// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import OmniBar from "./OmniBar";
import CommandPalette from "@ds/components/overlay/CommandPalette/CommandPalette";
import type { OmniItem, RankedItem } from "./ranker";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host;
}

const ITEMS: OmniItem[] = [
  { kind: "note", title: "Release notes", path: "notes/release-notes.md" },
  { kind: "note", title: "Reading list", path: "notes/reading-list.md" },
  { kind: "tag", tag: "research" },
  { kind: "command", id: "statusbar.toggle", title: "Toggle status bar" },
];

const RECENT: RankedItem[] = [
  {
    item: { kind: "note", title: "Release notes", path: "notes/release-notes.md" },
    score: 0,
    matchedIndices: [],
  },
];

const input = () => document.querySelector("input") as HTMLInputElement | null;
const listbox = () => document.querySelector('[role="listbox"]');
const options = () =>
  Array.from(document.querySelectorAll('[role="option"]')) as HTMLElement[];

function type(text: string) {
  const el = input()!;
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(key: string) {
  input()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function renderBar(over: Partial<Parameters<typeof OmniBar>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onOpenNote: vi.fn(),
    onOpenTag: vi.fn(),
    onRunCommand: vi.fn(),
  };
  mount(() => (
    <OmniBar
      open={true}
      items={ITEMS}
      recentNotes={RECENT}
      onClose={handlers.onClose}
      onOpenNote={handlers.onOpenNote}
      onOpenTag={handlers.onOpenTag}
      onRunCommand={handlers.onRunCommand}
      {...over}
    />
  ));
  return handlers;
}

describe("OmniBar over the design-system CommandPalette", () => {
  it("renders nothing while closed", () => {
    renderBar({ open: false });
    expect(input()).toBeNull();
    expect(listbox()).toBeNull();
  });

  it("shows recent notes with their path detail when the query is empty", () => {
    renderBar();
    expect(options()).toHaveLength(1);
    expect(options()[0]!.textContent).toContain("Release notes");
    expect(
      options()[0]!.querySelector(".command-item__detail")?.textContent,
    ).toBe("notes/release-notes.md");
  });

  it("ranks on input and marks the matched characters", () => {
    renderBar();
    type("rel");
    const first = options()[0]!;
    expect(first.textContent).toContain("Release notes");
    expect(
      Array.from(first.querySelectorAll("mark")).map((m) => m.textContent),
    ).toEqual(["R", "e", "l"]);
  });

  it("badges each kind with its own icon", () => {
    renderBar();
    type("e");
    const icons = options().map((o) => o.querySelector(".ds-icon"));
    expect(icons.every((i) => i !== null)).toBe(true);
  });

  it("wires aria-activedescendant to the selected option", () => {
    renderBar();
    const id = options()[0]!.id;
    expect(id).not.toBe("");
    expect(input()!.getAttribute("aria-activedescendant")).toBe(id);
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("moves the selection with the arrow keys", () => {
    renderBar();
    type("e");
    expect(options().length).toBeGreaterThan(1);
    press("ArrowDown");
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(input()!.getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    press("ArrowUp");
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("clamps the selection at both ends", () => {
    renderBar();
    press("ArrowUp");
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    type("release notes");
    press("ArrowDown");
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("opens the selected note on Enter and closes", () => {
    const h = renderBar();
    type("release notes");
    press("Enter");
    expect(h.onOpenNote).toHaveBeenCalledWith("notes/release-notes.md");
    expect(h.onClose).toHaveBeenCalled();
  });

  it("opens a tag when its row is clicked", () => {
    const h = renderBar();
    type("research");
    options()[0]!.click();
    expect(h.onOpenTag).toHaveBeenCalledWith("research");
    expect(h.onClose).toHaveBeenCalled();
  });

  it("runs a command when its row is activated", () => {
    const h = renderBar();
    type("toggle status bar");
    press("Enter");
    expect(h.onRunCommand).toHaveBeenCalledWith("statusbar.toggle");
  });

  it("selects the row the pointer moves over", () => {
    renderBar();
    type("e");
    options()[1]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("distinguishes an empty vault from an empty result set", () => {
    renderBar({ items: [], recentNotes: [] });
    expect(document.querySelector(".command-empty")?.textContent).toBe(
      "No notes yet",
    );
    dispose?.();
    document.body.innerHTML = "";
    renderBar();
    type("zzzzqqq");
    expect(document.querySelector(".command-empty")?.textContent).toBe(
      "No notes or tags match",
    );
  });

  it("closes on Escape", () => {
    const h = renderBar();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(h.onClose).toHaveBeenCalled();
  });

  it("names the dialog and its two regions", () => {
    renderBar();
    expect(
      document.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
    ).toBe("Quick switcher");
    expect(input()!.getAttribute("aria-label")).toBe("Search notes and tags");
    expect(listbox()!.getAttribute("aria-label")).toBe("Results");
  });
});

describe("CommandPalette flat mode keeps its prior behaviour", () => {
  it("filters a flat command list by substring and runs on click", () => {
    const onRun = vi.fn();
    const [open, setOpen] = createSignal(true);
    mount(() => (
      <CommandPalette
        open={open()}
        onClose={() => setOpen(false)}
        commands={[
          { id: "a", label: "Open Vault…", onRun },
          { id: "b", label: "Toggle theme", onRun: () => {} },
        ]}
      />
    ));
    expect(document.querySelectorAll(".command-item")).toHaveLength(2);
    type("vault");
    const rows = Array.from(
      document.querySelectorAll(".command-item"),
    ) as HTMLElement[];
    expect(rows).toHaveLength(1);
    rows[0]!.click();
    expect(onRun).toHaveBeenCalled();
    expect(open()).toBe(false);
  });

  it("stays a plain list with no selection semantics", () => {
    mount(() => (
      <CommandPalette
        open={true}
        onClose={() => {}}
        commands={[{ id: "a", label: "Open Vault…", onRun: () => {} }]}
      />
    ));
    expect(listbox()).toBeNull();
    expect(options()).toHaveLength(0);
    expect(input()!.hasAttribute("aria-activedescendant")).toBe(false);
    expect(
      document.querySelector('[role="dialog"]')?.hasAttribute("aria-label"),
    ).toBe(false);
  });

  it("keeps its default placeholder and empty label", () => {
    mount(() => (
      <CommandPalette open={true} onClose={() => {}} commands={[]} />
    ));
    expect(input()!.placeholder).toBe("Type a command…");
    expect(document.querySelector(".command-empty")?.textContent).toBe(
      "No matching commands.",
    );
  });
});
