import { createSignal } from "solid-js";

import { readFileText, writeFileText } from "../api/ipc";
import { errorMessage } from "../errorMessage";
import { isOwnWriteEcho } from "../ownWrite";
import { createDebounced } from "./debounce";

export interface DocumentEditor {
  getContent: () => string;
  replaceContent: (next: string) => void;
}

export interface DocumentSessionDeps {
  vaultId: () => string | null;
  path: () => string | null;
  editor: () => DocumentEditor | null | undefined;
  autosaveDebounceMs: number;
  reportError: (message: string) => void;
  onWritten: () => void;
  onContentReplaced: (content: string) => void;
}

export interface DocumentSession {
  readonly conflictHash: () => string | null;
  readonly isDirty: () => boolean;
  readonly markDirty: () => void;
  readonly scheduleWrite: () => void;
  readonly cancelScheduledWrite: () => void;
  readonly flush: () => Promise<void>;
  readonly reset: () => void;
  readonly adopt: (knownHash: string | null) => void;
  readonly applyExternalChange: (
    changedPath: string,
    incomingHash: string | null | undefined,
  ) => void;
  readonly isOwnWriteEchoOf: (
    changedPath: string,
    incomingHash: string | null | undefined,
  ) => boolean;
  readonly takeDisk: () => Promise<void>;
  readonly keepMine: () => void;
  readonly writeBeforeUnload: () => void;
}

export function createDocumentSession(
  deps: DocumentSessionDeps,
): DocumentSession {
  const [conflictHash, setConflictHash] = createSignal<string | null>(null);

  let seenHash: string | null = null;
  let lastWrittenHash: string | null = null;
  let dirty = false;
  let pendingWrite: Promise<void> | null = null;
  let generation = 0;

  const performWrite = async (): Promise<void> => {
    const id = deps.vaultId();
    const path = deps.path();
    const editor = deps.editor();
    if (!id || !path || !editor) return;
    const content = editor.getContent();
    const writingFor = generation;
    try {
      const req: Parameters<typeof writeFileText>[0] = {
        vault_id: id,
        path,
        content,
      };
      if (seenHash !== null) req.expected_seen_hash = seenHash;
      const resp = await writeFileText(req);
      if (writingFor !== generation) return;
      lastWrittenHash = resp.new_content_hash;
      seenHash = resp.new_content_hash;
      if (editor.getContent() === content) {
        dirty = false;
      }
      deps.onWritten();
    } catch (e) {
      if (writingFor !== generation) return;
      deps.reportError(errorMessage(e));
    }
  };

  const autosave = createDebounced(() => void flush(), deps.autosaveDebounceMs);

  const flush = async (): Promise<void> => {
    if (conflictHash() !== null) return;
    autosave.cancel();
    if (!dirty && pendingWrite === null) return;
    const prior = pendingWrite ?? Promise.resolve();
    const next = prior.then(performWrite);
    pendingWrite = next;
    try {
      await next;
    } finally {
      if (pendingWrite === next) pendingWrite = null;
    }
  };

  const takeDisk = async (): Promise<void> => {
    const id = deps.vaultId();
    const path = deps.path();
    const editor = deps.editor();
    if (!id || !path || !editor) return;
    try {
      const resp = await readFileText({ vault_id: id, path });
      editor.replaceContent(resp.content);
      deps.onContentReplaced(resp.content);
      seenHash = conflictHash();
      lastWrittenHash = null;
      dirty = false;
      setConflictHash(null);
    } catch (e) {
      deps.reportError(errorMessage(e));
    }
  };

  const applyExternalChange = (
    changedPath: string,
    incomingHash: string | null | undefined,
  ) => {
    if (changedPath !== deps.path()) return;
    if (!incomingHash) return;
    if (incomingHash === lastWrittenHash) return;

    if (dirty || conflictHash() !== null) {
      setConflictHash(incomingHash);
      autosave.cancel();
      return;
    }

    const id = deps.vaultId();
    const path = deps.path();
    if (!id || !path) return;
    readFileText({ vault_id: id, path })
      .then((resp) => {
        deps.editor()?.replaceContent(resp.content);
        deps.onContentReplaced(resp.content);
        seenHash = incomingHash;
        dirty = false;
      })
      .catch((e) => {
        console.error("silent reload failed", e);
      });
  };

  return {
    conflictHash,
    isDirty: () => dirty,
    markDirty: () => {
      dirty = true;
    },
    scheduleWrite: () => {
      if (conflictHash() !== null) return;
      autosave.schedule();
    },
    cancelScheduledWrite: autosave.cancel,
    flush,
    reset: () => {
      generation += 1;
      autosave.cancel();
      setConflictHash(null);
      seenHash = null;
      lastWrittenHash = null;
      dirty = false;
    },
    adopt: (knownHash: string | null) => {
      seenHash = knownHash;
      lastWrittenHash = knownHash;
    },
    applyExternalChange,
    isOwnWriteEchoOf: (
      changedPath: string,
      incomingHash: string | null | undefined,
    ) =>
      isOwnWriteEcho({
        changedPath,
        selectedPath: deps.path(),
        incomingHash,
        lastWrittenHash,
      }),
    takeDisk,
    keepMine: () => {
      setConflictHash(null);
      autosave.schedule();
    },
    writeBeforeUnload: () => {
      autosave.cancel();
      if (conflictHash() !== null) return;
      if (dirty) void performWrite();
    },
  };
}
