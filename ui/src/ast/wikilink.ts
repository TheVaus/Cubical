import type { Anchor } from "./types";

export type TokenizedRun =
  | { kind: "text"; value: string }
  | {
      kind: "wiki_link";
      target: string;
      display: string | null;
      anchor: Anchor | null;
      embed: boolean;
    }
  | { kind: "property_ref"; note: string | null; property: string };

export function scanWikilinks(input: string): TokenizedRun[] {
  if (input.length === 0) return [];
  const out: TokenizedRun[] = [];
  let cursor = 0;
  let i = 0;
  while (i < input.length) {
    const open = findOpen(input, i);
    if (!open) break;
    const close = findClose(input, open.contentStart);
    if (close < 0) break;
    const body = input.slice(open.contentStart, close);
    const link = parseBody(body, open.embed);
    if (link) {
      if (open.openerPos > cursor) {
        out.push({ kind: "text", value: input.slice(cursor, open.openerPos) });
      }
      out.push(link);
      cursor = close + 2;
      i = cursor;
    } else {
      i = open.contentStart;
    }
  }
  if (cursor < input.length) {
    out.push({ kind: "text", value: input.slice(cursor) });
  }
  return out;
}

interface Opener {
  openerPos: number;
  contentStart: number;
  embed: boolean;
}

function findOpen(input: string, start: number): Opener | null {
  for (let i = start; i + 1 < input.length; i++) {
    if (input.charCodeAt(i) === 0x5b && input.charCodeAt(i + 1) === 0x5b) {
      if (i > 0 && input.charCodeAt(i - 1) === 0x21 ) {
        return { openerPos: i - 1, contentStart: i + 2, embed: true };
      }
      return { openerPos: i, contentStart: i + 2, embed: false };
    }
  }
  return null;
}

function findClose(input: string, start: number): number {
  for (let i = start; i + 1 < input.length; i++) {
    if (input.charCodeAt(i) === 0x5d && input.charCodeAt(i + 1) === 0x5d) {
      return i;
    }
  }
  return -1;
}

function parseBody(body: string, embed: boolean): TokenizedRun | null {
  const pipeIdx = body.indexOf("|");
  let head: string;
  let display: string | null = null;
  if (pipeIdx >= 0) {
    head = body.slice(0, pipeIdx);
    display = body.slice(pipeIdx + 1).trim();
  } else {
    head = body;
  }
  const hashIdx = head.indexOf("#");
  let targetRaw: string;
  let anchor: Anchor | null = null;
  if (hashIdx >= 0) {
    targetRaw = head.slice(0, hashIdx);
    const rest = head.slice(hashIdx + 1);
    if (rest.startsWith("^")) {
      const v = rest.slice(1).trim();
      if (v.length > 0) anchor = { kind: "block", value: v };
    } else {
      const v = rest.trim();
      if (v.length > 0) anchor = { kind: "heading", value: v };
    }
  } else {
    targetRaw = head;
  }
  const target = targetRaw.trim();
  if (target.length === 0) return null;
  if (anchor === null && !embed) {
    const dot = target.indexOf(".");
    if (dot >= 0) {
      const noteRaw = target.slice(0, dot).trim();
      const property = target.slice(dot + 1).trim();
      if (property.length === 0) return null;
      return {
        kind: "property_ref",
        note: noteRaw.length === 0 ? null : noteRaw,
        property,
      };
    }
  }
  return { kind: "wiki_link", target, display, anchor, embed };
}
