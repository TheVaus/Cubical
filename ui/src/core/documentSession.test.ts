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

// A write only reaches writeFileText through `prior.then(performWrite)`, so a
// fired timer proves nothing until the microtask queue has drained. Every
// assertion about whether a write happened goes through one of these two.
const settle = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

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

const seenHashOfLastWrite = () =>
  wrote.mock.calls.at(-1)?.[0].expected_seen_hash;

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

  it("adopts the hash the engine returns, so the next write chains off it", async () => {
    const { session } = build();
    session.markDirty();
    await session.flush();

    session.markDirty();
    await session.flush();

    expect(seenHashOfLastWrite()).toBe("h-written");
  });

  it("reports a completed write so downstream indexes can refresh", async () => {
    const { session, onWritten } = build();
    session.markDirty();

    await session.flush();

    expect(onWritten).toHaveBeenCalledTimes(1);
  });

  it("does not report a write that failed", async () => {
    wrote.mockRejectedValue(new Error("nope"));
    const { session, onWritten } = build();
    session.markDirty();

    await session.flush();

    expect(onWritten).not.toHaveBeenCalled();
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
    await settle();
    expect(wrote).toHaveBeenCalledTimes(1);

    session.markDirty();
    const second = session.flush();
    await settle();
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
    await advance(AUTOSAVE_MS);

    expect(wrote).toHaveBeenCalledTimes(1);
  });

  it("refuses to schedule while a conflict is unresolved", async () => {
    const { session } = build();
    session.markDirty();
    session.applyExternalChange("note.md", "h-external");

    session.scheduleWrite();
    await advance(AUTOSAVE_MS * 4);

    expect(wrote).not.toHaveBeenCalled();
  });

  it("flush cancels the pending timer rather than writing twice", async () => {
    const { session } = build();
    session.markDirty();
    session.scheduleWrite();

    await session.flush();
    await advance(AUTOSAVE_MS * 4);

    expect(wrote).toHaveBeenCalledTimes(1);
  });
});

describe("an external change to the open file", () => {
  it("ignores the echo of our own write", async () => {
    const { session, editor } = build();
    session.markDirty();
    await session.flush();

    session.applyExternalChange("note.md", "h-written");
    await settle();

    expect(session.conflictHash()).toBeNull();
    expect(editor.replaceContent).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("recognises its own echo through isOwnWriteEchoOf", async () => {
    const { session } = build();
    session.markDirty();
    await session.flush();

    expect(session.isOwnWriteEchoOf("note.md", "h-written")).toBe(true);
    expect(session.isOwnWriteEchoOf("note.md", "h-other")).toBe(false);
    expect(session.isOwnWriteEchoOf("elsewhere.md", "h-written")).toBe(false);
    expect(session.isOwnWriteEchoOf("note.md", null)).toBe(false);
  });

  it("treats a seeded hash as its own write, so a fresh create is not a conflict", () => {
    const { session } = build();
    session.adopt("h-created");

    expect(session.isOwnWriteEchoOf("note.md", "h-created")).toBe(true);
  });

  it("ignores a change to some other file", async () => {
    const { session } = build();
    session.markDirty();

    session.applyExternalChange("elsewhere.md", "h-external");
    await settle();

    expect(session.conflictHash()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("silently reloads when the buffer is clean", async () => {
    const { session, editor, onContentReplaced } = build();

    session.applyExternalChange("note.md", "h-external");
    await settle();

    expect(editor.replaceContent).toHaveBeenCalledWith("from disk");
    expect(onContentReplaced).toHaveBeenCalledWith("from disk");
    expect(session.conflictHash()).toBeNull();
    expect(session.isDirty()).toBe(false);
  });

  it("adopts the external hash on a silent reload, so the next write is not a false clobber", async () => {
    const { session } = build();

    session.applyExternalChange("note.md", "h-external");
    await settle();

    session.markDirty();
    await session.flush();

    expect(seenHashOfLastWrite()).toBe("h-external");
  });

  it("raises a conflict instead of clobbering unsaved edits", async () => {
    const { session, editor } = build();
    session.markDirty();

    session.applyExternalChange("note.md", "h-external");
    await settle();

    expect(session.conflictHash()).toBe("h-external");
    expect(editor.replaceContent).not.toHaveBeenCalled();
  });

  it("cancels a queued autosave when it raises a conflict", async () => {
    const { session } = build();
    session.markDirty();
    session.scheduleWrite();

    session.applyExternalChange("note.md", "h-external");
    await advance(AUTOSAVE_MS * 4);

    expect(wrote).not.toHaveBeenCalled();
  });

  it("tracks the newest external hash while a conflict is unresolved, without reloading", async () => {
    const { session, editor } = build();
    session.markDirty();
    session.applyExternalChange("note.md", "h-first");

    session.applyExternalChange("note.md", "h-second");
    await settle();

    expect(session.conflictHash()).toBe("h-second");
    expect(editor.replaceContent).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
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

    expect(seenHashOfLastWrite()).toBe("h-external");
  });

  it("take-disk forgets the last written hash, so the disk copy is not read as our echo", async () => {
    const { session } = build();
    session.markDirty();
    await session.flush();
    session.markDirty();
    session.applyExternalChange("note.md", "h-external");

    await session.takeDisk();

    expect(session.isOwnWriteEchoOf("note.md", "h-written")).toBe(false);
  });

  it("keep-mine clears the conflict and lets the write through", async () => {
    const { session } = build();
    session.markDirty();
    session.applyExternalChange("note.md", "h-external");

    session.keepMine();
    expect(session.conflictHash()).toBeNull();

    await advance(AUTOSAVE_MS);
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

  it("forgets the last written hash, so the next document cannot inherit an echo", () => {
    const { session } = build();
    session.adopt("h-previous");

    session.reset();

    expect(session.isOwnWriteEchoOf("note.md", "h-previous")).toBe(false);
  });

  it("drops a queued autosave belonging to the outgoing document", async () => {
    const { session } = build();
    session.markDirty();
    session.scheduleWrite();

    session.reset();
    await advance(AUTOSAVE_MS * 4);

    expect(wrote).not.toHaveBeenCalled();
  });

  // The dangerous case. A stray timer surviving reset() looks harmless,
  // because flush() bails on `!dirty`. But with a write still in flight the
  // guard passes on `pendingWrite` instead, and the stray timer chains a
  // second write — with a null seen hash, against the document just switched
  // to. Reset must disarm the timer, not merely rely on dirty being false.
  it("does not let a queued write survive a reset taken mid-flight", async () => {
    const { session } = build();
    let resolveWrite: (v: unknown) => void = () => {};
    wrote.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveWrite = r;
        }),
    );

    session.markDirty();
    const inFlight = session.flush();
    await settle();
    expect(wrote).toHaveBeenCalledTimes(1);

    session.markDirty();
    session.scheduleWrite();
    session.reset();

    await advance(AUTOSAVE_MS * 4);
    resolveWrite({ new_content_hash: "h1" });
    await inFlight;
    await settle();

    expect(wrote).toHaveBeenCalledTimes(1);
  });

  it("clears an unresolved conflict", async () => {
    const { session } = build();
    session.markDirty();
    session.applyExternalChange("note.md", "h-external");

    session.reset();
    await settle();

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
    await advance(AUTOSAVE_MS * 4);
    expect(wrote).not.toHaveBeenCalled();
    expect(session.isDirty()).toBe(true);

    await session.flush();
    expect(seenHashOfLastWrite()).toBe("h-opened");
  });
});

describe("closing the window", () => {
  it("writes a dirty buffer straight out, skipping the debounce", async () => {
    const { session } = build();
    session.markDirty();
    session.scheduleWrite();

    session.writeBeforeUnload();
    await settle();

    expect(wrote).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is nothing to save", async () => {
    const { session } = build();
    session.writeBeforeUnload();
    await settle();
    expect(wrote).not.toHaveBeenCalled();
  });
});
