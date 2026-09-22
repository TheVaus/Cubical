import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";

import { createAutocompleteProvider } from "./autocompleteProvider";
import { createAutocompleteWiring } from "./autocompleteWiring";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function harness(opts?: { enabled?: boolean; vaultId?: string | null }) {
  const linkIpc = vi.fn(async () => ({ candidates: [] }));
  const made: string[] = [];
  let out!: {
    provider: ReturnType<typeof createAutocompleteWiring>;
    setEnabled: (on: boolean) => void;
    setVaultId: (id: string | null) => void;
  };
  dispose = createRoot((d) => {
    const [enabled, setEnabled] = createSignal(opts?.enabled ?? true);
    const [vaultId, setVaultId] = createSignal<string | null>(
      opts?.vaultId === undefined ? "v1" : opts.vaultId,
    );
    const provider = createAutocompleteWiring({
      vaultId,
      corePlugins: () => ({ autocomplete: enabled() }),
      create: (id) => {
        made.push(id);
        return createAutocompleteProvider(id, linkIpc);
      },
    });
    out = { provider, setEnabled, setVaultId };
    return d;
  });
  return { ...out, made, linkIpc };
}

describe("autocomplete wiring", () => {
  it("has no provider without a vault", () => {
    expect(harness({ vaultId: null }).provider()).toBeNull();
  });

  it("has no provider while the plugin is off, so no trigger reaches the engine", () => {
    const h = harness({ enabled: false });
    expect(h.provider()).toBeNull();
    expect(h.made).toEqual([]);
  });

  it("drops the provider when switched off and builds a fresh one when switched back on", async () => {
    const h = harness();
    const first = h.provider();
    await first?.links("al");
    expect(h.linkIpc).toHaveBeenCalledTimes(1);

    h.setEnabled(false);
    expect(h.provider()).toBeNull();

    h.setEnabled(true);
    expect(h.provider()).not.toBeNull();
    expect(h.provider()).not.toBe(first);
  });

  it("builds a provider for the vault that is open now", () => {
    const h = harness();
    h.setVaultId("v2");
    expect(h.made).toEqual(["v1", "v2"]);
  });
});
