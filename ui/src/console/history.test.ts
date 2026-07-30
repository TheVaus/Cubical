import { describe, expect, it } from "vitest";
import { emptyHistory, push, up, down } from "./history";

describe("history", () => {
  it("push ignores blanks and consecutive duplicates", () => {
    let h = push(emptyHistory, "list");
    h = push(h, "");
    h = push(h, "list");
    expect(h.entries).toEqual(["list"]);
  });

  it("up walks backwards, down walks forwards to the draft", () => {
    let h = push(push(emptyHistory, "a"), "b");
    const u1 = up(h); expect(u1.value).toBe("b"); h = u1.history;
    const u2 = up(h); expect(u2.value).toBe("a"); h = u2.history;
    const u3 = up(h); expect(u3.value).toBe("a"); h = u3.history; // clamps
    const d1 = down(h); expect(d1.value).toBe("b"); h = d1.history;
    const d2 = down(h); expect(d2.value).toBe(null); h = d2.history; // back to draft
  });

  it("up on empty history yields null", () => {
    expect(up(emptyHistory).value).toBe(null);
  });
});
