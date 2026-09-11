import { Channel } from "@tauri-apps/api/core";

import { invoke } from "./transport";

export interface TerminalExit {
  code: number | null;
  signal: string | null;
}

export interface TerminalChunk {
  base64: string;
  exit?: TerminalExit | null;
}

export interface TerminalOpenResponse {
  terminal_id: string;
}

export function terminalOpen(
  vaultId: string,
  cols: number,
  rows: number,
  onOutput: (chunk: TerminalChunk) => void,
): Promise<TerminalOpenResponse> {
  const channel = new Channel<TerminalChunk>();
  channel.onmessage = onOutput;
  return invoke<TerminalOpenResponse>("terminal_open", {
    vaultId,
    cols,
    rows,
    onOutput: channel,
  });
}

export function terminalWrite(terminalId: string, data: string): Promise<void> {
  return invoke("terminal_write", { terminalId, data });
}

export function terminalResize(
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("terminal_resize", { terminalId, cols, rows });
}

export function terminalBusy(terminalId: string): Promise<boolean> {
  return invoke<boolean>("terminal_busy", { terminalId });
}

export function terminalClose(terminalId: string): Promise<void> {
  return invoke("terminal_close", { terminalId });
}

export function terminalReapAll(): Promise<void> {
  return invoke("terminal_reap_all", {});
}

export interface AgentInstructionsStatus {
  offered: boolean;
  canonical_path: string;
  existing_pointers: string[];
}

export interface AgentInstructionsAccepted {
  created: string[];
  skipped: string[];
}

export function agentInstructionsStatus(
  vaultId: string,
): Promise<AgentInstructionsStatus> {
  return invoke<AgentInstructionsStatus>("agent_instructions_status", {
    req: { vault_id: vaultId },
  });
}

export function agentInstructionsAccept(
  vaultId: string,
): Promise<AgentInstructionsAccepted> {
  return invoke<AgentInstructionsAccepted>("agent_instructions_accept", {
    req: { vault_id: vaultId },
  });
}

export function agentInstructionsDecline(vaultId: string): Promise<void> {
  return invoke("agent_instructions_decline", { req: { vault_id: vaultId } });
}
