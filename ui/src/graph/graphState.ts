import { createSignal, onCleanup } from "solid-js";

import {
  graphLayout,
  graphLayoutCancel,
  graphSnapshot,
  onVaultFileChanged,
  type GraphSnapshot,
  type LayoutComplete,
  type LayoutFrame,
} from "../api/ipc";
import { positionsByKey, reconcilePositions } from "./reconcile";

export type GraphStatus =
  | "idle"
  | "loading"
  | "laying-out"
  | "ready"
  | "error";

export const REFRESH_DEBOUNCE_MS = 400;

export interface GraphStateDeps {
  vaultId: () => string | null;
  snapshot?: (vaultId: string) => Promise<GraphSnapshot>;
  layout?: (
    vaultId: string,
    snapshot: GraphSnapshot,
    onFrame: (frame: LayoutFrame) => void,
  ) => Promise<LayoutComplete>;
  cancel?: (vaultId: string) => Promise<void>;
  subscribe?: (
    handler: (payload: { vault_id: string }) => void,
  ) => Promise<() => void>;
  debounceMs?: number;
}

export interface GraphState {
  status: () => GraphStatus;
  snapshot: () => GraphSnapshot | null;
  positions: () => Float32Array;
  iteration: () => number;
  error: () => string | null;
  start: () => void;
  stop: () => void;
  refresh: () => void;
}

const EMPTY = new Float32Array(0);

export function createGraphState(deps: GraphStateDeps): GraphState {
  const fetchSnapshot = deps.snapshot ?? ((id: string) => graphSnapshot(id));
  const runLayout = deps.layout ?? graphLayout;
  const cancelLayout = deps.cancel ?? graphLayoutCancel;
  const subscribe = deps.subscribe ?? onVaultFileChanged;
  const debounceMs = deps.debounceMs ?? REFRESH_DEBOUNCE_MS;

  const [status, setStatus] = createSignal<GraphStatus>("idle");
  const [snapshot, setSnapshot] = createSignal<GraphSnapshot | null>(null);
  const [positions, setPositions] = createSignal<Float32Array>(EMPTY);
  const [iteration, setIteration] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);

  let run = 0;
  let running: string | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshGeneration = 0;
  let unlisten: (() => void) | null = null;
  let subscribing = false;
  let disposed = false;

  const reset = () => {
    setStatus("idle");
    setSnapshot(null);
    setPositions(EMPTY);
    setIteration(0);
    setError(null);
  };

  const refresh = () => {
    const vaultId = deps.vaultId();
    const previous = snapshot();
    if (vaultId === null || previous === null) return;
    const frozen = positionsByKey(previous, positions());
    const token = run;
    const generation = ++refreshGeneration;
    void (async () => {
      const next = await fetchSnapshot(vaultId).catch(() => null);
      if (next === null) return;
      if (token !== run || generation !== refreshGeneration) return;
      if (vaultId !== deps.vaultId()) return;
      setSnapshot(next);
      setPositions(reconcilePositions(next, frozen));
    })();
  };

  const scheduleRefresh = () => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, debounceMs);
  };

  const stop = () => {
    run += 1;
    refreshGeneration += 1;
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    const vaultId = running;
    running = null;
    reset();
    if (vaultId !== null) void cancelLayout(vaultId).catch(() => {});
  };

  const start = () => {
    stop();
    const vaultId = deps.vaultId();
    if (vaultId === null) return;
    const token = run;
    const current = () => token === run;

    running = vaultId;
    setStatus("loading");

    void (async () => {
      try {
        const snap = await fetchSnapshot(vaultId);
        if (!current()) return;
        setSnapshot(snap);
        setStatus("laying-out");

        const done = await runLayout(vaultId, snap, (frame) => {
          if (!current()) return;
          setPositions(Float32Array.from(frame.positions));
          setIteration(frame.iteration);
        });
        if (!current()) return;
        setPositions(Float32Array.from(done.positions));
        setIteration(done.iterations);
        setStatus("ready");
        running = null;
        if (unlisten === null && !subscribing) {
          subscribing = true;
          const off = await subscribe((payload) => {
            if (payload.vault_id === deps.vaultId()) scheduleRefresh();
          }).catch(() => null);
          subscribing = false;
          if (disposed) {
            off?.();
          } else {
            unlisten = off;
          }
        }
      } catch (e) {
        if (!current()) return;
        running = null;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
  };

  onCleanup(() => {
    disposed = true;
    stop();
    unlisten?.();
    unlisten = null;
  });

  return {
    status,
    snapshot,
    positions,
    iteration,
    error,
    start,
    stop,
    refresh: scheduleRefresh,
  };
}
