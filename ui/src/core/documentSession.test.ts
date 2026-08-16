import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/ipc", () => ({
  readFileText: vi.fn(),
  writeFileText: vi.fn(),
}));

import { readFileText, writeFileText } from "../api/ipc";
import {
  createDocumentSession,
  type DocumentSessionDeps,
} from "./documentSession";

const wrote = writeFileText as unknown as ReturnType<typeof vi.fn>;
const read = readFileText as unknown as ReturnType<typeof vi.fn>;

const AUTOSAVE_MS = 300;

const build = (over: Partial<DocumentSessionDeps> = {}) => {
  let content = "typed";
  const editor = {
    getContent: () => content,
    replaceContent: vi.fn((next: string) => {
      content = next;
    }),
  };
  const reportError = vi.fn();
  const onWritten = vi.fn();
  const onContentReplaced = vi.fn();
  const session = createRoot(() =>
    createDocumentSession({
      vaultId: () => "v1",
      path: () => "note.md",
      editor: () => editor,
      autosaveDebounceMs: AUTOSAVE_MS,
      reportError,
      onWritten,
      onContentReplaced,
      ...over,
    }),
  );
  return {
    session,
    editor,
    reportError,
    onWritten,
    onContentReplaced,
    setContent: (next: string) => {
      content = next;
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  wrote.mockReset();
  wrote.mockResolvedValue({ new_content_hash: "h-written" });
  read.mockReset();
  read.mockResolvedValue({ content: "from disk" });
});

afterEach(() => vi.useRealTimers());

describe("writing", () => {
  it("does not write when nothing is dirty", async () => {
    const { session } = build();
    await session.flush();
    expect(wrote).not.toHaveBeenCalled();
  });

  it("sends the seen hash it adopted, so the engine can detect a clobber", async () => {
    const { session } = build();
    session.adopt("h-opened");
    session.markDirty();

    await session.flush();

    expect(wrote).toHaveBeenCalledWith({
      vault_id: "v1",
      path: "note.md",
      content: "typed",
      expected_seen_hash: "h-opened",
    });
  });

  it("omits the seen hash for a document it has never seen on disk", async () => {
    const { session } = build();
    session.markDirty();

    await session.flush();

    expect(wrote.mock.calls[0]?.[0]).not.toHaveProperty("expected_seen_hash");
  });

  it("stays dirty when the buffer changed while the write was in flight", async () => {
    const { session, setContent } = build();
    session.markDirty();
    wrote.mockImplementation(async () => {
      setContent("typed more");
      return { new_content_hash: "h-written" };
    });

    await session.flush();

    expect(session.isDirty()).toBe(true);
  });

  it("clears dirty when the buffer is unchanged by the time the write lands", async () => {
    const { session } = build();
    session.markDirty();

    await session.flush();

    expect(session.isDirty()).toBe(false);
  });

  it("serialises overlapping flushes instead of racing them", async () => {
    const { session } = build();
    let resolveFirst: (v: unknown) => void = () => {};
    wrote.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveFirst = r;
        }),
    );
    wrote.mockResolvedValue({ new_content_hash: "h2" });

    session.markDirty();
    const first = session.flush();
    await Promise.resolve();
    expect(wrote).toHaveBeenCalledTimes(1);

    session.markDirty();
    const second = session.flush();
    await Promise.resolve();
    expect(wrote).toHaveBeenCalledTimes(1);

    resolveFirst({ new_content_hash: "h1" });
    await Promise.all([first, second]);
    expect(wrote).toHaveBeenCalledTimes(2);
  });

  it("surfaces a write failure without clearing dirty", async () => {
    wrote.mockRejectedValue(new Error("read-only volume"));
    const { session, reportError } = build();
    session.markDirty();

    await session.flush();

    expect(reportError).toHaveBeenCalledWith("read-only volume");
    expect(session.isDirty()).toBe(true);
  });
});

describe("the autosave debounce", () => {
  it("writes once after the quiet period", async () => {
    const { session } = build();
    session.markDirty();

    session.scheduleWrite();
    session.scheduleWrite();
    vi.advanceTimersByTime(AUTOSAVE_MS);
    await vi.runAllTicks();

    expect(wrote).toHaveBeenCalledTimes(1);
  });

  it("refuses to schedule while a conflict is unresolved", () => {
    const { session } = build();
    session.markDirty();
    session.applyExternalChange("note.md", "h-external");

    session.scheduleWrite();
    vi.advanceTimersByTime(AUTOSAVE_MS * 4);

    expect(wrote).not.toHaveBeenCalled();
  });

  it("flush cancels the pending timer rather than writing twice", async () => {
    const { session } = build();
    session.markDirty();
    session.scheduleWrite();

    await session.flush();
    vi.advanceTimersByTime(AUTOSAVE_MS * 4);

    expect(wrote).toHaveBeenCalledTimes(1);
  });
});

describe("an external change to the open file", () => {
  it("ignores the echo of our own write", async () => {
    const { session, editor } = build();
    session.markDirty();
    await session.flush();

    session.applyExternalChange("note.md", "h-written");

    expect(session.conflictHash()).toBeNull();
    expect(editor.replaceContent).not.toHaveBeenCalled();
  });

  it("ignores a change to some other file", () => {
    const { session } = build();
    session.markDirty();

    session.applyExternalChange("elsewhere.md", "h-external");

    expect(session.conflictHash()).toBeNull();
  });

  it("silently reloads when the buffer is clean", async () => {
    const { session, editor, onContentReplaced } = build();

    session.applyExternalChange("note.md", "h-external");
    await vi.runAllTicks();

    expect(editor.replaceContent).toHaveBeenCalledWith("from disk");
    expect(onContentReplaced).toHaveBeenCalledWith("from disk");
    expect(session.conflictHash()).toBeNull();
    expect(session.isDirty()).toBe(false);
  });

  it("raises a conflict instead of clobbering unsaved edits", () => {
    const { session, editor } = build();
    session.markDirty();

    session.applyExternalChange("note.md", "h-external");

    expect(session.conflictHash()).toBe("h-external");
    expect(editor.replaceContent).not.toHaveBeenCalled();
  });

  it("cancels a queued autosave when it raises a conflict", () => {
    const { session } = build();
    session.markDirty();
    session.scheduleWrite();

    session.applyExternalChange("note.md", "h-external");
    vi.advanceTimersByTime(AUTOSAVE_MS * 4);

    expect(wrote).not.toHaveBeenCalled();
  });

  it("keeps the first conflict hash rather than reloading mid-conflict", () => {
    const { session, editor } = build();
    session.markDirty();
    session.applyExternalChange("note.md", "h-first");

    session.applyExternalChange("note.md", "h-second");

    expect(session.conflictHash()).toBe("h-second");
    expect(editor.replaceContent).not.toHaveBeenCalled();
  });
});

describe("resolving a conflict", () => {
  it("take-disk replaces the buffer and adopts the external hash", async () => {
    const { session, editor, onContentReplaced } = build();
    session.markDirty();
    session.applyExternalChange("note.md", "h-external");

    await session.takeDisk();

    expect(editor.replaceContent).toHaveBeenCalledWith("from disk");
    expect(onContentReplaced).toHaveBeenCalledWith("from disk");
    expect(session.conflictHash()).toBeNull();
    expect(session.isDirty()).toBe(false);
  });

  it("take-disk writes back against the hash it adopted, not the stale one", async () => {
    const { session } = build();
    session.adopt("h-opened");
    session.markDirty();
    session.applyExternalChange("note.md", "h-external");
    await session.takeDisk();

    session.markDirty();
    await session.flush();

    expect(wrote.mock.calls[0]?.[0].expected_seen_hash).toBe("h-external");
  });

  it("keep-mine clears the conflict and lets the write through", async () => {
    const { session } = build();
    session.markDirty();
    session.applyExternalChange("note.md", "h-external");

    session.keepMine();
    expect(session.conflictHash()).toBeNull();

    vi.advanceTimersByTime(AUTOSAVE_MS);
    await vi.runAllTicks();
    expect(wrote).toHaveBeenCalledTimes(1);
  });
});

describe("reset, on switching documents", () => {
  it("forgets the hashes so the next document cannot inherit them", async () => {
    const { session } = build();
    session.adopt("h-previous");

    session.reset();
    session.markDirty();
    await session.flush();

    expect(wrote.mock.calls[0]?.[0]).not.toHaveProperty("expected_seen_hash");
  });

  it("drops a queued autosave belonging to the outgoing document", () => {
    const { session } = build();
    session.markDirty();
    session.scheduleWrite();

    session.reset();
    vi.advanceTimersByTime(AUTOSAVE_MS * 4);

    expect(wrote).not.toHaveBeenCalled();
  });

  it("clears an unresolved conflict", () => {
    const { session } = build();
    session.markDirty();
    session.applyExternalChange("note.md", "h-external");

    session.reset();

    expect(session.conflictHash()).toBeNull();
    expect(session.isDirty()).toBe(false);
  });
});

describe("cancelScheduledWrite", () => {
  it("drops the queued write without touching dirty or the hashes", async () => {
    const { session } = build();
    session.adopt("h-opened");
    session.markDirty();
    session.scheduleWrite();

    session.cancelScheduledWrite();
    vi.advanceTimersByTime(AUTOSAVE_MS * 4);
    expect(wrote).not.toHaveBeenCalled();
    expect(session.isDirty()).toBe(true);

    await session.flush();
    expect(wrote.mock.calls[0]?.[0].expected_seen_hash).toBe("h-opened");
  });
});

describe("closing the window", () => {
  it("writes a dirty buffer straight out, skipping the debounce", () => {
    const { session } = build();
    session.markDirty();
    session.scheduleWrite();

    session.writeBeforeUnload();

    expect(wrote).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is nothing to save", () => {
    const { session } = build();
    session.writeBeforeUnload();
    expect(wrote).not.toHaveBeenCalled();
  });
});
