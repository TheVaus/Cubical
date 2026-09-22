// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

const searchIpc = vi.hoisted(() => ({
  search: vi.fn(async () => ({
    hits: [],
    total_estimated: 0,
    took_ms: 0,
    still_indexing: false,
  })),
  searchIndexStatus: vi.fn(async () => ({
    state: "ready",
    indexed_files: 0,
    total_files: 0,
    last_commit_secs: null,
  })),
}));

vi.mock("../api/search", () => searchIpc);
vi.mock("../api/ipc", () => ({
  listTagAssignments: vi.fn(async () => ({ assignments: [] as unknown[] })),
  renameTag: vi.fn(async () => ({ rename_op_id: 1, pending_count: 0 })),
}));

import type { FileActions } from "../explorer/fileActions";
import { ExplorerPanel } from "./composed";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

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
  } as unknown as FileActions;
}

function mount(initial: boolean) {
  const [on, setOn] = createSignal(initial);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <ExplorerPanel
        files={[]}
        folders={[]}
        vaultId="v1"
        selectedPath={null}
        mode="files"
        refreshSignal={0}
        corePlugins={{ search: on() }}
        actions={stubActions()}
        onModeChange={() => {}}
        onRefresh={() => {}}
        onNavigate={() => {}}
        onSelectFile={() => {}}
        onRenameCommit={() => {}}
      />
    ),
    host,
  );
  const bar = () => host.querySelector('input[placeholder="Search notes…"]');
  return { setOn, bar };
}

describe("the explorer's search slot follows the search plugin", () => {
  it("offers no search bar and asks the index nothing while the plugin is off", async () => {
    const h = mount(false);
    await flush();
    expect(h.bar()).toBeNull();
    expect(searchIpc.searchIndexStatus).not.toHaveBeenCalled();
    expect(searchIpc.search).not.toHaveBeenCalled();
  });

  it("removes the bar when switched off and brings it back when switched on", async () => {
    const h = mount(true);
    await flush();
    expect(h.bar()).not.toBeNull();

    h.setOn(false);
    await flush();
    expect(h.bar()).toBeNull();

    h.setOn(true);
    await flush();
    expect(h.bar()).not.toBeNull();
  });
});
