import { afterEach, describe, expect, it, vi } from "vitest";

import { createListenerGroup } from "./listenerGroup";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createListenerGroup", () => {
  it("carries on after one registration rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const group = createListenerGroup();
    const later = vi.fn();

    await group.attach("first", () => Promise.resolve(() => {}));
    await group.attach("second", () => Promise.reject(new Error("no event")));
    await group.attach("third", () => Promise.resolve(later));

    expect(group.attached()).toBe(2);
    group.detach();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("detaches everything it holds, once", () => {
    const group = createListenerGroup();
    const off = vi.fn();
    void group.attach("only", () => Promise.resolve(off));
    return Promise.resolve().then(() => {
      group.detach();
      group.detach();
      expect(off).toHaveBeenCalledTimes(1);
      expect(group.attached()).toBe(0);
    });
  });

  it("releases a registration that lands after detach", async () => {
    const group = createListenerGroup();
    const off = vi.fn();
    let settle: (fn: () => void) => void = () => {};
    const pending = group.attach(
      "late",
      () => new Promise<() => void>((r) => (settle = r)),
    );

    group.detach();
    settle(off);
    await pending;

    expect(off).toHaveBeenCalledTimes(1);
    expect(group.attached()).toBe(0);
  });

  it("keeps detaching after one unlisten throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const group = createListenerGroup();
    const off = vi.fn();
    return Promise.all([
      group.attach("bad", () =>
        Promise.resolve(() => {
          throw new Error("already gone");
        }),
      ),
      group.attach("good", () => Promise.resolve(off)),
    ]).then(() => {
      group.detach();
      expect(off).toHaveBeenCalledTimes(1);
    });
  });
});
