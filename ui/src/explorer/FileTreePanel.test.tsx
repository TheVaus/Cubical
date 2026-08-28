// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import type { FileEntry } from "../api/ipc";
import FileTreePanel from "./FileTreePanel";
import type { FileActions } from "./fileActions";

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

const entry = (path: string, typeId = "markdown"): FileEntry => ({
  path,
  type_id: typeId,
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

interface PanelOver {
  files?: FileEntry[];
  folders?: string[];
  selectedPath?: string | null;
  actions?: FileActions;
  onSelectFile?: (e: FileEntry) => void;
  onRenameCommit?: (from: string, target: string, isFolder: boolean) => void;
}

function panel(over: PanelOver = {}) {
  return mount(() => (
    <FileTreePanel
      files={over.files ?? []}
      folders={over.folders ?? []}
      vaultId="v1"
      selectedPath={over.selectedPath ?? null}
      actions={over.actions ?? stubActions()}
      onSelectFile={over.onSelectFile ?? (() => {})}
      onRenameCommit={over.onRenameCommit ?? (() => {})}
    />
  ));
}

const names = (host: HTMLElement) =>
  [...host.querySelectorAll(".tree-row__name")].map((n) => n.textContent);

describe("FileTreePanel", () => {
  it("shows the empty state when the vault has no files", () => {
    const host = panel();
    expect(host.textContent).toContain("No files yet…");
  });

  it("renders folders above their files", () => {
    const host = panel({
      files: [entry("notes/a.md"), entry("b.md")],
      folders: ["notes"],
    });
    expect(names(host)).toEqual(["notes", "a.md", "b.md"]);
  });

  it("hides a folder's children when it is collapsed, and restores them", () => {
    const host = panel({
      files: [entry("notes/a.md"), entry("b.md")],
      folders: ["notes"],
    });
    // The row carries `collapsed`, so toggling rebuilds its node — re-query.
    const folderRow = () =>
      host.querySelector(".tree-row--folder") as HTMLElement;

    folderRow().click();
    expect(names(host)).toEqual(["notes", "b.md"]);

    folderRow().click();
    expect(names(host)).toEqual(["notes", "a.md", "b.md"]);
  });

  it("marks the selected file", () => {
    const host = panel({
      files: [entry("a.md"), entry("b.md")],
      selectedPath: "b.md",
    });
    const selected = host.querySelectorAll(".tree-row--selected");
    expect(selected.length).toBe(1);
    expect(selected[0]!.textContent).toBe("b.md");
  });

  it("hands the clicked file's entry back to the caller", () => {
    const onSelectFile = vi.fn();
    const host = panel({ files: [entry("a.md")], onSelectFile });
    (host.querySelector(".tree-row--file") as HTMLElement).click();
    expect(onSelectFile).toHaveBeenCalledWith(entry("a.md"));
  });

  it("does not select a file while its name is being edited", () => {
    const onSelectFile = vi.fn();
    const host = panel({
      files: [entry("a.md")],
      actions: stubActions({ renamingPath: () => "a.md" }),
      onSelectFile,
    });
    (host.querySelector(".tree-row--file") as HTMLElement).click();
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  it("commits a rename against the file's own folder, not the vault root", () => {
    const onRenameCommit = vi.fn();
    const host = panel({
      files: [entry("notes/a.md")],
      folders: ["notes"],
      actions: stubActions({ renamingPath: () => "notes/a.md" }),
      onRenameCommit,
    });
    const input = host.querySelector(".tree-row__input") as HTMLInputElement;
    input.value = "renamed.md";
    input.dispatchEvent(new FocusEvent("blur"));
    expect(onRenameCommit).toHaveBeenCalledWith(
      "notes/a.md",
      "notes/renamed.md",
      false,
    );
  });

  it("commits a folder rename as a folder", () => {
    const onRenameCommit = vi.fn();
    const host = panel({
      files: [entry("notes/a.md")],
      folders: ["notes"],
      actions: stubActions({ renamingPath: () => "notes" }),
      onRenameCommit,
    });
    const input = host.querySelector(".tree-row__input") as HTMLInputElement;
    input.value = "archive";
    input.dispatchEvent(new FocusEvent("blur"));
    expect(onRenameCommit).toHaveBeenCalledWith("notes", "archive", true);
  });

  it("flags a note whose name cannot round-trip as a wikilink", () => {
    const host = panel({ files: [entry("a.b.md")] });
    expect(host.querySelector(".tree-row__name--dotted")).not.toBeNull();
  });

  it("marks a file Cubical has no viewer for as unsupported", () => {
    const host = panel({ files: [entry("archive.zip", "binary")] });
    expect(host.querySelector(".tree-row--unsupported")).not.toBeNull();
  });

  it("opens the context menu for empty space when the list itself is right-clicked", () => {
    const openContextMenu = vi.fn();
    const host = panel({ actions: stubActions({ openContextMenu }) });
    host
      .querySelector('[role="listbox"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(openContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "empty", path: "" }),
    );
  });

  it("falls through to the empty-space menu on a file it cannot open", () => {
    const openContextMenu = vi.fn();
    const host = panel({
      files: [entry("archive.zip", "binary")],
      actions: stubActions({ openContextMenu }),
    });
    host
      .querySelector(".tree-row--file")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(openContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "empty" }),
    );
  });
});
