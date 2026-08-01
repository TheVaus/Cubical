import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";

vi.mock("../api/ipc", () => ({
  agentInstructionsStatus: vi.fn(async () => ({
    offered: false,
    canonical_path: "/vault/.cubical/agent-instructions.md",
    existing_pointers: [],
  })),
  agentInstructionsAccept: vi.fn(async () => ({ created: [], skipped: [] })),
  agentInstructionsDecline: vi.fn(async () => undefined),
  terminalBusy: vi.fn(async () => false),
  terminalReapAll: vi.fn(async () => undefined),
}));

import {
  agentInstructionsAccept,
  agentInstructionsDecline,
  agentInstructionsStatus,
  terminalBusy,
  terminalReapAll,
} from "../api/ipc";
import { closeTab, emptyTabs, type TabSet } from "../tabs/tabModel";
import { createTerminalWiring, type TerminalWiring } from "./wiring";

const flush = () => new Promise((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

interface Harness {
  wiring: TerminalWiring;
  tabs: () => TabSet;
  setEnabled: (on: boolean) => void;
  setVaultId: (id: string | null) => void;
  closed: string[];
}

function harness(opts?: { enabled?: boolean; vaultId?: string | null }): Harness {
  let h!: Harness;
  dispose = createRoot((d) => {
    const [enabled, setEnabled] = createSignal(opts?.enabled ?? true);
    const [vaultId, setVaultId] = createSignal<string | null>(
      opts?.vaultId === undefined ? "v1" : opts.vaultId,
    );
    const [tabs, setTabs] = createSignal<TabSet>(emptyTabs);
    const closed: string[] = [];
    const wiring = createTerminalWiring({
      vaultId,
      corePlugins: () => ({ terminal: enabled() }),
      tabs,
      setTabs: (updater) => setTabs((s) => updater(s)),
      closeTab: async (id) => {
        closed.push(id);
        setTabs((s) => closeTab(s, id));
      },
      flushAutosave: async () => {},
    });
    h = {
      wiring,
      tabs,
      setEnabled: (on) => setEnabled(on),
      setVaultId: (id) => setVaultId(id),
      closed,
    };
    return d;
  });
  return h;
}

beforeEach(() => {
  vi.mocked(agentInstructionsStatus).mockClear();
  vi.mocked(agentInstructionsAccept).mockClear();
  vi.mocked(agentInstructionsDecline).mockClear();
  vi.mocked(terminalBusy).mockClear();
  vi.mocked(terminalBusy).mockResolvedValue(false);
  vi.mocked(terminalReapAll).mockClear();
});

describe("availability", () => {
  it("is unavailable while the plugin is off — it ships default-off", () => {
    const h = harness({ enabled: false });

    expect(h.wiring.available()).toBe(false);
  });

  it("is unavailable with no vault open", () => {
    const h = harness({ vaultId: null });

    expect(h.wiring.available()).toBe(false);
  });

  it("is available with a vault and the plugin on", () => {
    expect(harness().wiring.available()).toBe(true);
  });
});

describe("opening", () => {
  it("opens a distinct tab per terminal", async () => {
    const h = harness();

    h.wiring.open();
    await flush();
    h.wiring.open();
    await flush();

    expect(h.tabs().tabs.map((t) => t.id)).toEqual(["terminal:1", "terminal:2"]);
  });

  it("opens nothing while the plugin is off", async () => {
    const h = harness({ enabled: false });

    h.wiring.open();
    await flush();

    expect(h.tabs().tabs).toEqual([]);
  });
});

describe("the plugin gate", () => {
  it("closes every terminal tab and reaps the children when disabled", async () => {
    const h = harness();
    h.wiring.open();
    await flush();
    h.wiring.open();
    await flush();

    h.setEnabled(false);
    await flush();

    expect(h.closed).toEqual(["terminal:1", "terminal:2"]);
    expect(h.tabs().tabs).toEqual([]);
    expect(terminalReapAll).toHaveBeenCalledTimes(1);
  });

  it("does not reap when there was no terminal open", async () => {
    const h = harness();

    h.setEnabled(false);
    await flush();

    expect(terminalReapAll).not.toHaveBeenCalled();
  });
});

describe("closing a busy terminal", () => {
  it("closes straight away when the tab owns no pty", async () => {
    const h = harness();

    await expect(h.wiring.confirmClose("terminal:1")).resolves.toBe(true);
    expect(terminalBusy).not.toHaveBeenCalled();
  });

  it("closes straight away when nothing is running", async () => {
    const h = harness();
    h.wiring.register("terminal:1", "term-9-1");

    await expect(h.wiring.confirmClose("terminal:1")).resolves.toBe(true);
    expect(terminalBusy).toHaveBeenCalledWith("term-9-1");
  });

  it("waits for an answer when a foreground child is running", async () => {
    const h = harness();
    h.wiring.register("terminal:1", "term-9-1");
    vi.mocked(terminalBusy).mockResolvedValue(true);

    const pending = h.wiring.confirmClose("terminal:1");
    await flush();
    expect(h.wiring.busyTabId()).toBe("terminal:1");

    h.wiring.answerBusyClose(false);
    await expect(pending).resolves.toBe(false);
    expect(h.wiring.busyTabId()).toBeNull();
  });

  it("proceeds when the answer is yes", async () => {
    const h = harness();
    h.wiring.register("terminal:1", "term-9-1");
    vi.mocked(terminalBusy).mockResolvedValue(true);

    const pending = h.wiring.confirmClose("terminal:1");
    await flush();
    h.wiring.answerBusyClose(true);

    await expect(pending).resolves.toBe(true);
  });

  it("stops asking once the pty is forgotten", async () => {
    const h = harness();
    h.wiring.register("terminal:1", "term-9-1");
    h.wiring.forget("terminal:1");
    vi.mocked(terminalBusy).mockResolvedValue(true);

    await expect(h.wiring.confirmClose("terminal:1")).resolves.toBe(true);
  });
});

describe("agent-instructions consent", () => {
  it("asks on the first terminal and never again in the session", async () => {
    const h = harness();

    h.wiring.open();
    await flush();
    expect(h.wiring.consentPrompt()?.vaultId).toBe("v1");

    h.wiring.declineConsent();
    h.wiring.open();
    await flush();

    expect(h.wiring.consentPrompt()).toBeNull();
    expect(agentInstructionsStatus).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when the vault was already asked", async () => {
    vi.mocked(agentInstructionsStatus).mockResolvedValueOnce({
      offered: true,
      canonical_path: "/vault/.cubical/agent-instructions.md",
      existing_pointers: ["AGENTS.md"],
    });
    const h = harness();

    h.wiring.open();
    await flush();

    expect(h.wiring.consentPrompt()).toBeNull();
  });

  it("declining writes nothing to the vault root", async () => {
    const h = harness();
    h.wiring.open();
    await flush();

    h.wiring.declineConsent();

    expect(agentInstructionsDecline).toHaveBeenCalledWith("v1");
    expect(agentInstructionsAccept).not.toHaveBeenCalled();
    expect(h.wiring.consentPrompt()).toBeNull();
  });

  it("accepting writes the pointer files for that vault", async () => {
    const h = harness();
    h.wiring.open();
    await flush();

    h.wiring.acceptConsent();

    expect(agentInstructionsAccept).toHaveBeenCalledWith("v1");
    expect(h.wiring.consentPrompt()).toBeNull();
  });

  it("opens the terminal even when the status call fails", async () => {
    vi.mocked(agentInstructionsStatus).mockRejectedValueOnce(new Error("nope"));
    const h = harness();

    h.wiring.open();
    await flush();

    expect(h.tabs().tabs.map((t) => t.id)).toEqual(["terminal:1"]);
    expect(h.wiring.consentPrompt()).toBeNull();
  });
});
