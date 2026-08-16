import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/ipc", () => ({
  createFile: vi.fn(),
  createFolder: vi.fn(() => Promise.resolve({})),
  deleteFile: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../toastState", () => ({ showToast: vi.fn() }));

import { createFile, createFolder, deleteFile } from "../api/ipc";
import { showToast } from "../toastState";
import { createFileActions, type FileActionsDeps } from "./fileActions";

const created = createFile as unknown as ReturnType<typeof vi.fn>;
const createdDir = createFolder as unknown as ReturnType<typeof vi.fn>;
const deleted = deleteFile as unknown as ReturnType<typeof vi.fn>;
const toasted = showToast as unknown as ReturnType<typeof vi.fn>;

const build = (over: Partial<FileActionsDeps> = {}) => {
  const reportError = vi.fn();
  const refreshFileList = vi.fn(() => Promise.resolve());
  const openCreatedFile = vi.fn(() => Promise.resolve());
  const actions = createRoot(() =>
    createFileActions({
      vaultId: () => "v1",
      refreshFileList,
      openCreatedFile,
      reportError,
      countFilesUnderFolder: () => 3,
      ...over,
    }),
  );
  return { actions, reportError, refreshFileList, openCreatedFile };
};

beforeEach(() => {
  created.mockReset();
  created.mockResolvedValue({ path: "Untitled.md", content_hash: "h1" });
  createdDir.mockReset();
  createdDir.mockResolvedValue({});
  deleted.mockReset();
  deleted.mockResolvedValue({});
  toasted.mockReset();
});

describe("creating from the toolbar", () => {
  it("refreshes the list and opens what it made", async () => {
    const { actions, refreshFileList, openCreatedFile } = build();

    await actions.newFile("");

    expect(created).toHaveBeenCalledWith({ vault_id: "v1", parent_dir: "" });
    expect(refreshFileList).toHaveBeenCalled();
    expect(openCreatedFile).toHaveBeenCalledWith("Untitled.md", "h1");
  });

  it("reports a failure through the error banner, not a toast", async () => {
    created.mockRejectedValue(new Error("disk full"));
    const { actions, reportError } = build();

    await actions.newFile("");

    expect(reportError).toHaveBeenCalledWith("disk full");
    expect(toasted).not.toHaveBeenCalled();
  });

  it("does nothing without an open vault", async () => {
    const { actions, refreshFileList } = build({ vaultId: () => null });

    await actions.newFile("");
    await actions.newFolder("");

    expect(created).not.toHaveBeenCalled();
    expect(createdDir).not.toHaveBeenCalled();
    expect(refreshFileList).not.toHaveBeenCalled();
  });
});

describe("creating from the tree context menu", () => {
  it("puts the new file straight into rename mode", async () => {
    const { actions, openCreatedFile } = build();

    await actions.newFileInTree("notes");

    expect(created).toHaveBeenCalledWith({
      vault_id: "v1",
      parent_dir: "notes",
    });
    expect(actions.renamingPath()).toBe("Untitled.md");
    expect(openCreatedFile).not.toHaveBeenCalled();
  });

  it("reports a failure through a toast, not the error banner", async () => {
    created.mockRejectedValue(new Error("nope"));
    const { actions, reportError } = build();

    await actions.newFileInTree("notes");

    expect(toasted).toHaveBeenCalledWith("nope");
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("delete", () => {
  it("counts the files under a folder but not under a file", () => {
    const { actions } = build();

    actions.requestDelete("notes", "folder");
    expect(actions.deleteTarget()).toEqual({
      path: "notes",
      kind: "folder",
      fileCount: 3,
    });

    actions.requestDelete("a.md", "file");
    expect(actions.deleteTarget()?.fileCount).toBe(0);
  });

  it("clears the target once the delete lands", async () => {
    const { actions } = build();
    actions.requestDelete("a.md", "file");

    await actions.confirmDelete();

    expect(deleted).toHaveBeenCalledWith({ vault_id: "v1", path: "a.md" });
    expect(actions.deleteTarget()).toBeNull();
    expect(actions.deleteInFlight()).toBe(false);
  });

  it("keeps the dialog open and drops the in-flight flag when it fails", async () => {
    deleted.mockRejectedValue(new Error("locked"));
    const { actions } = build();
    actions.requestDelete("a.md", "file");

    await actions.confirmDelete();

    expect(toasted).toHaveBeenCalledWith("locked");
    expect(actions.deleteTarget()).not.toBeNull();
    expect(actions.deleteInFlight()).toBe(false);
  });

  it("does nothing with no target", async () => {
    const { actions } = build();

    await actions.confirmDelete();

    expect(deleted).not.toHaveBeenCalled();
  });
});

describe("reset", () => {
  it("clears every transient surface, as a vault switch requires", () => {
    const { actions } = build();
    actions.openContextMenu({ kind: "file", path: "a.md", x: 1, y: 2 });
    actions.requestDelete("a.md", "file");
    actions.startRename("a.md");

    actions.reset();

    expect(actions.contextMenu()).toBeNull();
    expect(actions.deleteTarget()).toBeNull();
    expect(actions.renamingPath()).toBeNull();
    expect(actions.deleteInFlight()).toBe(false);
  });
});
