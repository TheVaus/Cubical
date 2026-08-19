import { createSignal, onCleanup } from "solid-js";

import {
  graphLayout,
  graphLayoutCancel,
  graphSnapshot,
  type GraphSnapshot,
  type LayoutComplete,
  type LayoutFrame,
} from "../api/ipc";

export type GraphStatus =
  | "idle"
  | "loading"
  | "laying-out"
  | "ready"
  | "error";

export interface GraphStateDeps {
  vaultId: () => string | null;
  snapshot?: (vaultId: string) => Promise<GraphSnapshot>;
  layout?: (
    vaultId: string,
    snapshot: GraphSnapshot,
    onFrame: (frame: LayoutFrame) => void,
  ) => Promise<LayoutComplete>;
  cancel?: (vaultId: string) => Promise<void>;
}

export interface GraphState {
  status: () => GraphStatus;
  snapshot: () => GraphSnapshot | null;
  positions: () => Float32Array;
  iteration: () => number;
  error: () => string | null;
  start: () => void;
  stop: () => void;
}

const EMPTY = new Float32Array(0);

export function createGraphState(deps: GraphStateDeps): GraphState {
  const fetchSnapshot = deps.snapshot ?? ((id: string) => graphSnapshot(id));
  const runLayout = deps.layout ?? graphLayout;
  const cancelLayout = deps.cancel ?? graphLayoutCancel;

  const [status, setStatus] = createSignal<GraphStatus>("idle");
  const [snapshot, setSnapshot] = createSignal<GraphSnapshot | null>(null);
  const [positions, setPositions] = createSignal<Float32Array>(EMPTY);
  const [iteration, setIteration] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);

  let run = 0;
  let running: string | null = null;

  const reset = () => {
    setStatus("idle");
    setSnapshot(null);
    setPositions(EMPTY);
    setIteration(0);
    setError(null);
  };

  const stop = () => {
    run += 1;
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
      } catch (e) {
        if (!current()) return;
        running = null;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
  };

  onCleanup(stop);

  return {
    status,
    snapshot,
    positions,
    iteration,
    error,
    start,
    stop,
  };
}
