import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDebounced } from "./debounce";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createDebounced", () => {
  it("runs once, after the wait", () => {
    const run = vi.fn();
    const task = createDebounced(run, 200);

    task.schedule();
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(199);
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst into a single trailing run", () => {
    const run = vi.fn();
    const task = createDebounced(run, 200);

    task.schedule();
    vi.advanceTimersByTime(150);
    task.schedule();
    vi.advanceTimersByTime(150);
    task.schedule();
    vi.advanceTimersByTime(200);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancel stops a scheduled run", () => {
    const run = vi.fn();
    const task = createDebounced(run, 200);

    task.schedule();
    task.cancel();
    vi.advanceTimersByTime(1000);

    expect(run).not.toHaveBeenCalled();
  });

  it("cancel on an idle task is harmless", () => {
    const task = createDebounced(vi.fn(), 200);
    expect(() => task.cancel()).not.toThrow();
    expect(task.pending()).toBe(false);
  });

  it("reports pending only while a run is owed", () => {
    const task = createDebounced(vi.fn(), 200);
    expect(task.pending()).toBe(false);

    task.schedule();
    expect(task.pending()).toBe(true);

    vi.advanceTimersByTime(200);
    expect(task.pending()).toBe(false);
  });

  it("can be scheduled again after it has run", () => {
    const run = vi.fn();
    const task = createDebounced(run, 200);

    task.schedule();
    vi.advanceTimersByTime(200);
    task.schedule();
    vi.advanceTimersByTime(200);

    expect(run).toHaveBeenCalledTimes(2);
  });
});
