import { createEffect, createSignal, on, untrack } from "solid-js";

import {
  agentInstructionsAccept,
  agentInstructionsDecline,
  agentInstructionsStatus,
  terminalBusy,
  terminalReapAll,
  type AgentInstructionsStatus,
} from "../api/ipc";
import type { Command } from "../core/commands";
import { corePluginEnabled } from "../settings/corePlugins";
import { canOpenTab, openTab, type TabSet } from "../tabs/tabModel";
import { createConsentGate } from "./consent";
import {
  TERMINAL_COMMAND_ID,
  TERMINAL_COMMAND_TITLE,
  TERMINAL_PLUGIN,
} from "./registration";
import { createTerminalSessions } from "./sessions";
import { terminalTabIds, terminalView } from "./tabView";

export interface TerminalWiringDeps {
  vaultId: () => string | null;
  corePlugins: () => Record<string, boolean>;
  tabs: () => TabSet;
  setTabs: (updater: (s: TabSet) => TabSet) => void;
  closeTab: (id: string) => Promise<void>;
  flushAutosave: () => Promise<void>;
}

export interface ConsentPrompt {
  vaultId: string;
  status: AgentInstructionsStatus;
}

export interface TerminalWiring {
  available: () => boolean;
  open: () => void;
  command: Command;
  register: (tabId: string, terminalId: string) => void;
  forget: (tabId: string) => void;
  confirmClose: (tabId: string) => Promise<boolean>;
  busyTabId: () => string | null;
  answerBusyClose: (proceed: boolean) => void;
  consentPrompt: () => ConsentPrompt | null;
  acceptConsent: () => void;
  declineConsent: () => void;
}

export function createTerminalWiring(deps: TerminalWiringDeps): TerminalWiring {
  const sessions = createTerminalSessions();
  const gate = createConsentGate();
  const [prompt, setPrompt] = createSignal<ConsentPrompt | null>(null);
  const [busy, setBusy] = createSignal<{
    tabId: string;
    answer: (proceed: boolean) => void;
  } | null>(null);
  let nextKey = 0;

  const enabled = () => corePluginEnabled(deps.corePlugins(), TERMINAL_PLUGIN);

  createEffect(
    on(enabled, (on) => {
      if (on) return;
      const ids = terminalTabIds(untrack(() => deps.tabs().tabs));
      if (ids.length === 0) return;
      void (async () => {
        for (const id of ids) await deps.closeTab(id);
        await terminalReapAll().catch(() => {});
      })();
    }),
  );

  const offerConsent = async (vaultId: string): Promise<void> => {
    const status = await agentInstructionsStatus(vaultId).catch(() => null);
    if (status === null || !gate.claim(vaultId, status)) return;
    setPrompt({ vaultId, status });
  };

  const available = () => deps.vaultId() !== null && enabled();

  const open = () => {
    const vaultId = deps.vaultId();
    if (vaultId === null || !enabled()) return;
    const view = terminalView(String(nextKey + 1));
    if (!canOpenTab(deps.tabs(), view)) return;
    void (async () => {
      await deps.flushAutosave();
      nextKey += 1;
      deps.setTabs((s) => openTab(s, view));
      await offerConsent(vaultId);
    })();
  };

  const confirmClose = async (tabId: string): Promise<boolean> => {
    const terminalId = sessions.idFor(tabId);
    if (terminalId === null) return true;
    const running = await terminalBusy(terminalId).catch(() => false);
    if (!running) return true;
    return new Promise<boolean>((resolve) => {
      setBusy({ tabId, answer: resolve });
    });
  };

  const answerBusyClose = (proceed: boolean) => {
    const pending = busy();
    setBusy(null);
    pending?.answer(proceed);
  };

  const closeConsent = (): ConsentPrompt | null => {
    const pending = prompt();
    setPrompt(null);
    return pending;
  };

  return {
    available,
    open,
    command: {
      id: TERMINAL_COMMAND_ID,
      title: TERMINAL_COMMAND_TITLE,
      when: available,
      run: open,
    },
    register: sessions.register,
    forget: sessions.forget,
    confirmClose,
    busyTabId: () => busy()?.tabId ?? null,
    answerBusyClose,
    consentPrompt: prompt,
    acceptConsent: () => {
      const pending = closeConsent();
      if (pending !== null) void agentInstructionsAccept(pending.vaultId);
    },
    declineConsent: () => {
      const pending = closeConsent();
      if (pending !== null) void agentInstructionsDecline(pending.vaultId);
    },
  };
}
