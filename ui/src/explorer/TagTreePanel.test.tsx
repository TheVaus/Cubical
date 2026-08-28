// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const ipc = vi.hoisted(() => ({
  listTagAssignments: vi.fn(async () => ({
    assignments: [
      { tag_path: "project/alpha", file_path: "one.md" },
      { tag_path: "urgent", file_path: "one.md" },
    ],
  })),
  renameTag: vi.fn(async () => ({ rename_op_id: 7, pending_count: 0 })),
}));

vi.mock("../api/ipc", () => ipc);

import type { FileEntry } from "../api/ipc";
import TagTreePanel from "./TagTreePanel";
import type { FileActions } from "./fileActions";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});
beforeEach(() => {
  ipc.renameTag.mockClear();
  ipc.listTagAssignments.mockClear();
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

function stubActions(over: Partial<FileActions> = {}): FileActions {
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
    ...over,
  };
}

function panel(actions: FileActions) {
  return mount(() => (
    <TagTreePanel
      files={[entry("one.md")]}
      vaultId="v1"
      selectedPath={null}
      reloadToken={0}
      actions={actions}
      onSelectFile={() => {}}
      onRenameCommit={() => {}}
    />
  ));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const rowNames = (host: HTMLElement) =>
  [...host.querySelectorAll(".tree-row__name")].map((n) => n.textContent);

const commit = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
};

describe("TagTreePanel tag rename", () => {
  it("renames the tag under its parent, keeping the rest of the path", async () => {
    const actions = stubActions({ renamingTag: () => "project/alpha" });
    const host = panel(actions);
    await flush();

    const input = host.querySelector<HTMLInputElement>(".tree-row__input")!;
    expect(input.value).toBe("alpha");
    commit(input, "beta");
    await flush();

    expect(ipc.renameTag).toHaveBeenCalledWith({
      vault_id: "v1",
      old_tag: "project/alpha",
      new_tag: "project/beta",
    });
  });

  it("does not call the vault-wide rewrite when the name is unchanged", async () => {
    const actions = stubActions({ renamingTag: () => "urgent" });
    const host = panel(actions);
    await flush();

    commit(host.querySelector<HTMLInputElement>(".tree-row__input")!, "urgent");
    await flush();

    expect(ipc.renameTag).not.toHaveBeenCalled();
  });

  it("does not call the vault-wide rewrite for an empty name", async () => {
    const actions = stubActions({ renamingTag: () => "urgent" });
    const host = panel(actions);
    await flush();

    commit(host.querySelector<HTMLInputElement>(".tree-row__input")!, "   ");
    await flush();

    expect(ipc.renameTag).not.toHaveBeenCalled();
  });

  it("refetches assignments after a rename lands", async () => {
    const actions = stubActions({ renamingTag: () => "urgent" });
    const host = panel(actions);
    await flush();
    ipc.listTagAssignments.mockClear();

    commit(host.querySelector<HTMLInputElement>(".tree-row__input")!, "later");
    await flush();
    await flush();

    expect(ipc.listTagAssignments).toHaveBeenCalledTimes(1);
  });

  it("lists a file under every tag it carries", async () => {
    const host = panel(stubActions());
    await flush();
    expect(rowNames(host)).toEqual([
      "project",
      "alpha",
      "one.md",
      "urgent",
      "one.md",
    ]);
  });
});
