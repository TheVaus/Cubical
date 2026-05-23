/**
 * Pure TS wiki-link tokenizer — behavioural mirror of
 * `crates/cubical-ast/src/wikilink.rs::scan_wikilinks`.
 *
 * Scans an `Inline::Text` value for `[[…]]` / `![[…]]` runs and yields a
 * sequence of `TokenizedRun`s. Grammar is locked by the L1 parity
 * harness fixtures; both languages must produce identical output for
 * every fixture string.
 */

import type { Anchor } from "./types";

/** One run produced by {@link scanWikilinks}. */
export type TokenizedRun =
  | { kind: "text"; value: string }
  | {
      kind: "wiki_link";
      target: string;
      display: string | null;
      anchor: Anchor | null;
      embed: boolean;
    };

/**
 * Scan a text run for `[[…]]` and `![[…]]`. Returns an empty array for
 * an empty input; otherwise always at least one element.
 */
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
      // Unparseable body (empty target); skip the `[[` and keep going.
      i = open.contentStart;
    }
  }
  if (cursor < input.length) {
    out.push({ kind: "text", value: input.slice(cursor) });
  }
  return out;
}

interface Opener {
  /** Byte index of the `!` (embed) or first `[` (plain). */
  openerPos: number;
  /** Byte index where the body starts (after `[[` or `![[`). */
  contentStart: number;
  /** Whether the link was prefixed with `!`. */
  embed: boolean;
}

function findOpen(input: string, start: number): Opener | null {
  for (let i = start; i + 1 < input.length; i++) {
    if (input.charCodeAt(i) === 0x5b && input.charCodeAt(i + 1) === 0x5b) {
      if (i > 0 && input.charCodeAt(i - 1) === 0x21 /* ! */) {
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
  return { kind: "wiki_link", target, display, anchor, embed };
}
