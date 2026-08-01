import type { AgentInstructionsStatus } from "../api/ipc";

export interface ConsentGate {
  claim: (vaultId: string, status: AgentInstructionsStatus) => boolean;
}

export function createConsentGate(): ConsentGate {
  const asked = new Set<string>();
  return {
    claim: (vaultId, status) => {
      if (status.offered || asked.has(vaultId)) return false;
      asked.add(vaultId);
      return true;
    },
  };
}
