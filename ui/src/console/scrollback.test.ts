import { describe, expect, it } from "vitest";
import { append, MAX_ENTRIES, type Entry } from "./scrollback";

const e = (text: string): Entry => ({ kind: "stdout", text });

describe("scrollback", () => {
  it("appends in order", () => {
    expect(append([e("a")], [e("b"), e("c")]).map((x) => x.text)).toEqual(["a", "b", "c"]);
  });

  it("caps to the last MAX_ENTRIES", () => {
    const many: Entry[] = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => e(String(i)));
    const out = append([], many);
    expect(out.length).toBe(MAX_ENTRIES);
    expect(out[0]!.text).toBe("10");
    expect(out[out.length - 1]!.text).toBe(String(MAX_ENTRIES + 9));
  });
});
