export interface PerfSample {
  name: string;
  durationMs: number;
  at: number;
}

export interface PerfConsole {
  samples: () => PerfSample[];
  clear: () => void;
  enable: (on: boolean) => void;
  enabled: () => boolean;
}

declare global {
  interface Window {
    __CUBICAL_PERF__?: PerfConsole;
  }
}

export const PERF_SAMPLE_LIMIT = 200;
export const PERF_FRAME_BUDGET_MS = 16;
export const PERF_STORAGE_KEY = "cubical:perf";

export function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}

export function pushSample(
  samples: readonly PerfSample[],
  sample: PerfSample,
  limit: number = PERF_SAMPLE_LIMIT,
): PerfSample[] {
  const next = [...samples, sample];
  return next.slice(Math.max(0, next.length - limit));
}

export function perfEnabledFor(dev: boolean, storedFlag: string | null): boolean {
  return dev || storedFlag === "1";
}

export function isOverFrameBudget(durationMs: number): boolean {
  return durationMs >= PERF_FRAME_BUDGET_MS;
}

function readStoredFlag(): string | null {
  try {
    return globalThis.localStorage?.getItem(PERF_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

let enabled = perfEnabledFor(import.meta.env.DEV, readStoredFlag());
let samples: readonly PerfSample[] = [];

export function perfEnabled(): boolean {
  return enabled;
}

export function setPerfEnabled(on: boolean): void {
  enabled = on;
  if (!on) samples = [];
}

export function perfSamples(): PerfSample[] {
  return [...samples];
}

export function clearPerfSamples(): void {
  samples = [];
}

export function recordPerf(name: string, durationMs: number): void {
  if (!enabled) return;
  const sample: PerfSample = {
    name,
    durationMs: roundMs(durationMs),
    at: roundMs(performance.now()),
  };
  samples = pushSample(samples, sample);
  if (isOverFrameBudget(sample.durationMs)) {
    console.debug(`[cubical:perf] ${name} ${sample.durationMs}ms`);
  }
}

export function measurePerf<T>(name: string, run: () => T): T {
  if (!enabled) return run();
  const started = performance.now();
  try {
    return run();
  } finally {
    recordPerf(name, performance.now() - started);
  }
}

export function measurePerfAsync<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!enabled) return run();
  const started = performance.now();
  return run().finally(() => recordPerf(name, performance.now() - started));
}

export function installPerfConsole(target: Window): void {
  target.__CUBICAL_PERF__ = {
    samples: perfSamples,
    clear: clearPerfSamples,
    enable: setPerfEnabled,
    enabled: perfEnabled,
  };
}
