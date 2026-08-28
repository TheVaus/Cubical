// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

const ipc = vi.hoisted(() => ({
  listTagAssignments: vi.fn(async () => ({ assignments: [] as unknown[] })),
  search: vi.fn(async () => ({ hits: [], total: 0 })),
  searchIndexStatus: vi.fn(async () => null),
  renameTag: vi.fn(async () => ({ rename_op_id: 1, pending_count: 0 })),
}));

vi.mock("../api/ipc", () => ipc);

const { listTagAssignments } = ipc;

import type { FileEntry } from "../api/ipc";
import ExplorerPanel from "./ExplorerPanel";
import type { FileActions } from "./fileActions";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});
beforeEach(() => {
  listTagAssignments.mockClear();
});

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host;
}

const entry = (path: string): FileEntry => ({
  path,
  type_id: "markdown",
  size_bytes: 0,
  mtime_unix: 0,
});

function stubActions(): FileActions {
  return {
    contextMenu: () => null,
    openContextMenu: vi.fn(),
    closeContextMenu: vi.fn(),
    deleteTarget: () => null,
    deleteInFlight: () => false,
    renamingPath: () => null,
    startRename: vi.fn(),
    renamingTag: () => null,
    startTagRename: vi.fn(),
    newFile: vi.fn(async () => {}),
    newFolder: vi.fn(async () => {}),
    newFileInTree: vi.fn(async () => {}),
    newFolderInTree: vi.fn(async () => {}),
    requestDelete: vi.fn(),
    cancelDelete: vi.fn(),
    confirmDelete: vi.fn(async () => {}),
    reset: vi.fn(),
  };
}

interface PanelOver {
  mode?: "files" | "tags";
  refreshSignal?: () => number;
  onModeChange?: (mode: string) => void;
  onRefresh?: () => void;
}

function panel(over: PanelOver = {}) {
  return mount(() => (
    <ExplorerPanel
      files={[entry("one.md")]}
      folders={[]}
      vaultId="v1"
      selectedPath={null}
      mode={over.mode ?? "files"}
      refreshSignal={(over.refreshSignal ?? (() => 0))()}
      actions={stubActions()}
      onModeChange={over.onModeChange ?? (() => {})}
      onRefresh={over.onRefresh ?? (() => {})}
      onNavigate={() => {}}
      onSelectFile={() => {}}
      onRenameCommit={() => {}}
    />
  ));
}

const button = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

const refreshButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('button[aria-label^="Refresh"]') ??
  host.querySelector<HTMLButtonElement>(
    'button[aria-label="Tags are up to date"]',
  );

describe("ExplorerPanel mode switch", () => {
  it("shows the file tree in files mode", () => {
    const host = panel({ mode: "files" });
    expect(host.querySelector('[aria-label="Vault files"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Vault tags"]')).toBeNull();
  });

  it("shows the tag tree in tags mode", () => {
    const host = panel({ mode: "tags" });
    expect(host.querySelector('[aria-label="Vault tags"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Vault files"]')).toBeNull();
  });

  it("reports the chosen mode so it can be persisted", () => {
    const onModeChange = vi.fn();
    const host = panel({ mode: "files", onModeChange });
    const tags = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Tags",
    )!;
    tags.click();
    expect(onModeChange).toHaveBeenCalledWith("tags");
  });

  it("offers file creation only in files mode", () => {
    expect(button(panel({ mode: "files" }), "New file")).not.toBeNull();
    expect(button(panel({ mode: "tags" }), "New file")).toBeNull();
  });

  it("fetches tag assignments when tags mode opens", () => {
    panel({ mode: "tags" });
    expect(listTagAssignments).toHaveBeenCalledWith({ vault_id: "v1" });
  });

  it("does not fetch tag assignments while in files mode", () => {
    panel({ mode: "files" });
    expect(listTagAssignments).not.toHaveBeenCalled();
  });
});

describe("ExplorerPanel refresh button", () => {
  it("is disabled in tags mode while the tree is up to date", () => {
    const host = panel({ mode: "tags" });
    expect(refreshButton(host)!.disabled).toBe(true);
  });

  it("enables in tags mode once vault content changes", () => {
    const [tick, setTick] = createSignal(0);
    const host = panel({ mode: "tags", refreshSignal: tick });
    expect(refreshButton(host)!.disabled).toBe(true);
    setTick(1);
    expect(refreshButton(host)!.disabled).toBe(false);
  });

  it("refetches assignments and goes quiet again when clicked", () => {
    const [tick, setTick] = createSignal(0);
    const host = panel({ mode: "tags", refreshSignal: tick });
    setTick(1);
    listTagAssignments.mockClear();
    refreshButton(host)!.click();
    expect(listTagAssignments).toHaveBeenCalledTimes(1);
    expect(refreshButton(host)!.disabled).toBe(true);
  });

  it("stays clickable in files mode, where a missed watcher event is unknowable", () => {
    const onRefresh = vi.fn();
    const host = panel({ mode: "files", onRefresh });
    const btn = refreshButton(host)!;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(onRefresh).toHaveBeenCalled();
  });
});
