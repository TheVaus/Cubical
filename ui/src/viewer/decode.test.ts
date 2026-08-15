import { describe, expect, it } from "vitest";
import { base64ToBytes, base64ToText, bytesToText, dataUrl } from "./decode";

function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("base64ToBytes", () => {
  it("round-trips binary bytes that are not valid text", () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(Array.from(base64ToBytes(toBase64(png)))).toEqual(png);
  });

  it("decodes empty input to an empty array", () => {
    expect(base64ToBytes("").length).toBe(0);
  });
});

describe("bytesToText", () => {
  it("decodes UTF-8 multi-byte characters", () => {
    const bytes = new TextEncoder().encode("héllo — 日本語");
    expect(bytesToText(bytes)).toBe("héllo — 日本語");
  });

  it("strips a UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62]);
    expect(bytesToText(bytes)).toBe("a,b");
  });

  it("leaves text without a BOM untouched", () => {
    expect(bytesToText(new TextEncoder().encode("a,b"))).toBe("a,b");
  });
});

describe("base64ToText", () => {
  it("decodes base64 straight to text", () => {
    expect(base64ToText(btoa("hello"))).toBe("hello");
  });
});

describe("dataUrl", () => {
  it("builds a base64 data URL", () => {
    expect(dataUrl("image/png", "AAAA")).toBe("data:image/png;base64,AAAA");
  });
});
