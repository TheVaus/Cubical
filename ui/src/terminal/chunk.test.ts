import { describe, expect, it } from "vitest";

import { decodeChunk } from "./chunk";

const encode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

describe("decodeChunk", () => {
  it("returns raw bytes, not a decoded string", () => {
    const bytes = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a]);

    expect(Array.from(decodeChunk(encode(bytes)))).toEqual([0x1b, 0x5b, 0x32, 0x4a]);
  });

  it("keeps a multi-byte character intact when it splits across chunks", () => {
    const snowman = new TextEncoder().encode("☃");
    const head = decodeChunk(encode(snowman.slice(0, 1)));
    const tail = decodeChunk(encode(snowman.slice(1)));

    const rejoined = new Uint8Array([...head, ...tail]);
    expect(new TextDecoder().decode(rejoined)).toBe("☃");
  });

  it("preserves bytes that are not valid UTF-8 on their own", () => {
    const lone = new Uint8Array([0xe2, 0x98]);

    expect(Array.from(decodeChunk(encode(lone)))).toEqual([0xe2, 0x98]);
  });

  it("treats an empty payload as no bytes", () => {
    expect(decodeChunk("")).toHaveLength(0);
  });
});
