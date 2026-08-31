// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

vi.mock("../api/ipc", () => ({
  listTagAssignments: vi.fn(async () => ({ assignments: [] as unknown[] })),
  search: vi.fn(async () => ({
    hits: [],
    total_estimated: 0,
    still_indexing: false,
  })),
  searchIndexStatus: vi.fn(async () => ({ state: "idle" })),
  renameTag: vi.fn(async () => ({ rename_op_id: 1, pending_count: 0 })),
}));

vi.mock("../sidebar/SearchBar", () => ({
  default: () => {
    throw new Error("search chrome exploded");
  },
}));

import type { FileEntry } from "../api/ipc";
import ExplorerPanel from "./ExplorerPanel";
import type { FileActions } from "./fileActions";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

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

describe("search is a sibling of the tree, not its parent", () => {
  it("keeps the file tree mounted when the search chrome throws", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.appendChild(host);
    dispose = render(
      () => (
        <ExplorerPanel
          files={[entry("one.md")]}
          folders={[]}
          vaultId="v1"
          selectedPath={null}
          mode="files"
          refreshSignal={0}
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

    expect(host.querySelector('[aria-label="Vault files"]')).not.toBeNull();
    expect(host.textContent).toContain("Search stopped");
    errors.mockRestore();
  });
});
