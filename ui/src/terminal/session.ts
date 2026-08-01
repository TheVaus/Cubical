import {
  terminalClose,
  terminalOpen,
  terminalResize,
  terminalWrite,
  type TerminalExit,
} from "../api/ipc";
import { decodeChunk } from "./chunk";
import { sizeChanged, type TerminalSize } from "./resize";

export interface SessionHandlers {
  onBytes: (bytes: Uint8Array) => void;
  onExit: (exit: TerminalExit | null) => void;
}

export interface TerminalSession {
  id: string;
  write: (data: string) => void;
  resize: (size: TerminalSize) => void;
  close: () => Promise<void>;
}

export async function openSession(
  vaultId: string,
  size: TerminalSize,
  handlers: SessionHandlers,
): Promise<TerminalSession> {
  let ended = false;
  let sent: TerminalSize | null = size;

  const end = (exit: TerminalExit | null): void => {
    if (ended) return;
    ended = true;
    handlers.onExit(exit);
  };

  const { terminal_id: id } = await terminalOpen(
    vaultId,
    size.cols,
    size.rows,
    (chunk) => {
      if (chunk.base64 !== "") handlers.onBytes(decodeChunk(chunk.base64));
      if (chunk.exit !== undefined && chunk.exit !== null) end(chunk.exit);
    },
  );

  return {
    id,
    write: (data) => {
      if (ended) return;
      void terminalWrite(id, data).catch(() => end(null));
    },
    resize: (next) => {
      if (ended || !sizeChanged(sent, next)) return;
      sent = next;
      void terminalResize(id, next.cols, next.rows).catch(() => end(null));
    },
    close: async () => {
      ended = true;
      await terminalClose(id).catch(() => {});
    },
  };
}
