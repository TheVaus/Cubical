# Typed Properties (Inline YAML Comments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each frontmatter property a persistent type/subtype, stored as a portable inline YAML comment (`price: 9.99 # type:number/currency`), with type-aware editor cells and a Settings ▸ Editor on/off toggle plus in-app docs.

**Architecture:** Per-note inline comments are the source of truth (no registry, no index, no Rust). A grammar module maps `CellKind ⇄ comment token`; the Properties panel resolves a property's kind from its comment (else falls back to inference), renders the matching cell, and writes the comment back via the `yaml` Document API. A vault setting gates the typed UI; comment preservation is always on so toggling off is non-destructive.

**Tech Stack:** Solid + TypeScript, eemeli's `yaml` package (already a dependency), Vitest (node env, `*.test.ts` pure-function tests only — component tests are deferred per `ui/vite.config.ts`).

**Spec:** `docs/superpowers/specs/2026-06-17-typed-properties-inline-comments-design.md`

**Conventions:**
- Tests are pure-function `*.test.ts` in node env. Cell `.tsx` files contain no unit-testable logic — any real logic is extracted into pure helpers (`format.ts`, `propertiesLogic.ts`) that ARE tested; the `.tsx` wiring is verified via `npx tsc --noEmit`, `npm run build`, and the preview workflow.
- Inline styles via `var(--…)` tokens and the helpers in `ui/src/properties/styles.ts` (no hardcoded colors).
- Run all UI commands from the `ui/` directory.

**Deviation from spec §7.1:** `parseTypeComments` lives in the new `ui/src/properties/typeComments.ts` (with the grammar maps), not `ui/src/ast/frontmatter.ts`. This keeps all grammar in one module and avoids the `ast` layer depending on `properties/CellKind`. Behavior is identical.

---

## File Structure

**New files:**
- `ui/src/properties/typeComments.ts` — grammar maps (`KIND_TO_TOKEN`, token→kind), `parseTypeToken`, `isTypeComment`, `parseTypeComments(yaml)`.
- `ui/src/properties/typeComments.test.ts`
- `ui/src/properties/format.ts` — pure cell helpers: `formatCurrencyUSD`, `parseCurrencyInput`, `truncateInt`, `normalizeDateTime`.
- `ui/src/properties/format.test.ts`
- `ui/src/properties/propertiesLogic.ts` — pure `resolveKind`, `buildAnnotations`.
- `ui/src/properties/propertiesLogic.test.ts`
- `ui/src/properties/coerce.test.ts`
- `ui/src/properties/CurrencyCell.tsx`
- `ui/src/properties/DateTimeCell.tsx`
- `ui/src/properties/MultilineCell.tsx`

**Modified files:**
- `ui/src/properties/inferType.ts` — extend `CellKind` union.
- `ui/src/properties/serializeFrontmatter.ts` — Document-API serialize with comments; relax `hasUnmodelableYaml`.
- `ui/src/properties/coerce.ts` — handle new kinds.
- `ui/src/properties/NumberCell.tsx` — integer mode.
- `ui/src/Properties.tsx` — `typedEnabled` prop, comment-based resolution, nested submenu, new cells, annotate-on-commit.
- `ui/src/api/ipc.ts` — add `properties.typed_enabled` to `Setting`.
- `ui/src/App.tsx` — toggle state, hydrate, Editor-tab UI + docs, pass `typedEnabled` to `Properties`.

---

## Task 1: Grammar module (`typeComments.ts`) + extend `CellKind`

**Files:**
- Modify: `ui/src/properties/inferType.ts`
- Create: `ui/src/properties/typeComments.ts`
- Test: `ui/src/properties/typeComments.test.ts`

- [ ] **Step 1: Extend the `CellKind` union**

In `ui/src/properties/inferType.ts`, replace the `CellKind` type with:

```ts
/** Discriminant for which Properties cell component renders a value. */
export type CellKind =
  | "string" // text (inferred, or text/plain)
  | "multiline" // text/multiline (explicit only)
  | "number" // generic number (inferred only)
  | "int" // number/int (explicit only)
  | "float" // number/float (explicit only)
  | "currency" // number/currency, USD (explicit only)
  | "boolean" // checkbox
  | "date" // date
  | "datetime" // date/datetime (explicit only)
  | "list-of-strings" // list
  | "list-of-tags" // tags
  | "raw";
```

`inferType` itself is unchanged — it still returns only the inferred kinds.

- [ ] **Step 2: Write the failing test**

Create `ui/src/properties/typeComments.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  isTypeComment,
  KIND_TO_TOKEN,
  parseTypeComments,
  parseTypeToken,
} from "./typeComments";
import type { CellKind } from "./inferType";

describe("parseTypeToken", () => {
  it("maps canonical tokens to kinds", () => {
    expect(parseTypeToken(" type:text")).toBe<CellKind>("string");
    expect(parseTypeToken(" type:text/multiline")).toBe<CellKind>("multiline");
    expect(parseTypeToken(" type:number/int")).toBe<CellKind>("int");
    expect(parseTypeToken(" type:number/float")).toBe<CellKind>("float");
    expect(parseTypeToken(" type:number/currency")).toBe<CellKind>("currency");
    expect(parseTypeToken(" type:checkbox")).toBe<CellKind>("boolean");
    expect(parseTypeToken(" type:date")).toBe<CellKind>("date");
    expect(parseTypeToken(" type:datetime")).toBe<CellKind>("datetime");
    expect(parseTypeToken(" type:list")).toBe<CellKind>("list-of-strings");
    expect(parseTypeToken(" type:tags")).toBe<CellKind>("list-of-tags");
  });

  it("accepts nested aliases and future currency params", () => {
    expect(parseTypeToken("type:date/datetime")).toBe<CellKind>("datetime");
    expect(parseTypeToken("type:list/tags")).toBe<CellKind>("list-of-tags");
    expect(parseTypeToken("type:number/currency:EUR")).toBe<CellKind>(
      "currency",
    );
  });

  it("returns undefined for non-type or unknown comments", () => {
    expect(parseTypeToken("just a note")).toBeUndefined();
    expect(parseTypeToken("type:bogus")).toBeUndefined();
    expect(parseTypeToken(null)).toBeUndefined();
    expect(parseTypeToken(undefined)).toBeUndefined();
  });
});

describe("isTypeComment", () => {
  it("is true only for known type tokens", () => {
    expect(isTypeComment(" type:number/currency")).toBe(true);
    expect(isTypeComment(" a regular comment")).toBe(false);
    expect(isTypeComment(" type:nonsense")).toBe(false);
  });
});

describe("KIND_TO_TOKEN", () => {
  it("round-trips every emittable kind through parseTypeToken", () => {
    for (const [kind, token] of Object.entries(KIND_TO_TOKEN)) {
      expect(parseTypeToken(` type:${token}`)).toBe(kind);
    }
  });
});

describe("parseTypeComments", () => {
  it("reads trailing type comments per top-level key", () => {
    const yaml =
      "price: 9.99 # type:number/currency\n" +
      "due: 2026-06-17 # type:date\n" +
      "people: # type:list\n  - Ann\n" +
      "plain: hi\n";
    const map = parseTypeComments(yaml);
    expect(map.get("price")).toBe<CellKind>("currency");
    expect(map.get("due")).toBe<CellKind>("date");
    expect(map.get("people")).toBe<CellKind>("list-of-strings");
    expect(map.has("plain")).toBe(false);
  });

  it("ignores unknown comments and malformed yaml", () => {
    expect(parseTypeComments("a: 1 # whatever\n").size).toBe(0);
    expect(parseTypeComments("a: : :\n  - bad\n").size).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ui && npx vitest run src/properties/typeComments.test.ts`
Expected: FAIL — `Cannot find module './typeComments'`.

- [ ] **Step 4: Implement `typeComments.ts`**

Create `ui/src/properties/typeComments.ts`:

```ts
/**
 * Inline type-comment grammar (spec §4, §7.1).
 *
 * Types are stored as a trailing YAML comment on a property's key line,
 * e.g. `price: 9.99 # type:number/currency`. This module is the single
 * source of truth for the `CellKind ⇄ comment token` mapping and for
 * reading those comments out of a frontmatter YAML string.
 *
 * The marker is `type:` (short, readable). Because `type:` is a common
 * word, a comment counts as a type hint ONLY when what follows resolves
 * to a known token — otherwise it is an ordinary comment.
 */

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import type { CellKind } from "./inferType";

/**
 * Emittable kinds → canonical token. Inferred-only kinds (`number`) and
 * `raw` are intentionally absent: they are never written as comments.
 */
export const KIND_TO_TOKEN: Record<
  Exclude<CellKind, "raw" | "number">,
  string
> = {
  string: "text",
  multiline: "text/multiline",
  int: "number/int",
  float: "number/float",
  currency: "number/currency",
  boolean: "checkbox",
  date: "date",
  datetime: "datetime",
  "list-of-strings": "list",
  "list-of-tags": "tags",
};

/** Canonical + alias tokens → kind (the parse direction). */
const TOKEN_TO_KIND: Record<string, CellKind> = {
  text: "string",
  "text/plain": "string",
  "text/multiline": "multiline",
  number: "number",
  "number/int": "int",
  "number/float": "float",
  "number/currency": "currency",
  checkbox: "boolean",
  date: "date",
  datetime: "datetime",
  "date/datetime": "datetime",
  list: "list-of-strings",
  "list/list": "list-of-strings",
  tags: "list-of-tags",
  "list/tags": "list-of-tags",
};

/** A node comment like ` type:number/currency` (no leading `#`). */
const TYPE_RE = /^\s*type:(\S+)\s*$/;

/** Resolve a raw token (already stripped of `type:`) to a kind. */
function tokenToKind(raw: string): CellKind | undefined {
  const t = raw.trim();
  // Tolerate a future per-currency param, e.g. `number/currency:EUR`.
  if (t === "number/currency" || t.startsWith("number/currency:")) {
    return "currency";
  }
  return TOKEN_TO_KIND[t];
}

/** Parse a node `comment` string into a kind, or `undefined`. */
export function parseTypeToken(
  comment: string | null | undefined,
): CellKind | undefined {
  if (!comment) return undefined;
  const m = TYPE_RE.exec(comment);
  if (!m) return undefined;
  return tokenToKind(m[1]);
}

/** Whether a node comment is a recognized type hint. */
export function isTypeComment(comment: string | null | undefined): boolean {
  return parseTypeToken(comment) !== undefined;
}

/**
 * Read the per-key type comments from a frontmatter YAML body. Only
 * top-level keys are considered; the value-node comment wins over the
 * key-node comment (scalar values carry the comment after the value;
 * block-list values carry it on the key line).
 */
export function parseTypeComments(yaml: string): Map<string, CellKind> {
  const out = new Map<string, CellKind>();
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yaml);
  } catch {
    return out;
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return out;
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key)) continue;
    const key = String(pair.key.value);
    const valComment = (pair.value as { comment?: string | null } | null)
      ?.comment;
    const keyComment = (pair.key as { comment?: string | null }).comment;
    const kind = parseTypeToken(valComment) ?? parseTypeToken(keyComment);
    if (kind) out.set(key, kind);
  }
  return out;
}

// `isSeq` is re-exported here so serializeFrontmatter can share the
// same `yaml` import surface without re-importing in two places.
export { isMap, isScalar, isSeq };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ui && npx vitest run src/properties/typeComments.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/properties/inferType.ts ui/src/properties/typeComments.ts ui/src/properties/typeComments.test.ts
git commit -m "feat(properties): inline type-comment grammar + parser"
```

---

## Task 2: Serialize with comments + relax `hasUnmodelableYaml`

**Files:**
- Modify: `ui/src/properties/serializeFrontmatter.ts`
- Test: `ui/src/properties/serializeFrontmatter.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/properties/serializeFrontmatter.test.ts` (add imports for `CellKind` if missing; `serializeFrontmatter`/`hasUnmodelableYaml` are already imported there):

```ts
import type { CellKind } from "./inferType";

describe("serializeFrontmatter with type comments", () => {
  it("writes a trailing type comment for a scalar value", () => {
    const out = serializeFrontmatter(
      [["price", 9.99]],
      new Map<string, CellKind>([["price", "currency"]]),
    );
    expect(out).toContain("# type:number/currency");
    expect(out).toContain("price: 9.99");
  });

  it("writes the comment on the key line for a block-list value", () => {
    const out = serializeFrontmatter(
      [["people", ["Ann"]]],
      new Map<string, CellKind>([["people", "list-of-strings"]]),
    );
    // Comment sits on the `people:` line, before the list items.
    const firstLine = out.split("\n").find((l) => l.startsWith("people:"))!;
    expect(firstLine).toContain("# type:list");
  });

  it("does not annotate inferred-only or raw kinds", () => {
    const out = serializeFrontmatter(
      [["n", 3]],
      new Map<string, CellKind>([["n", "number"]]),
    );
    expect(out).not.toContain("# type:");
  });

  it("round-trips: serialize then parseTypeComments recovers the kinds", () => {
    const types = new Map<string, CellKind>([
      ["price", "currency"],
      ["when", "datetime"],
      ["tags", "list-of-tags"],
    ]);
    const out = serializeFrontmatter(
      [
        ["price", 9.99],
        ["when", "2026-06-17T14:30"],
        ["tags", ["draft"]],
      ],
      types,
    );
    const body = out.replace(/^---\n/, "").replace(/---\n$/, "");
    expect(parseTypeComments(body)).toEqual(types);
  });
});

describe("hasUnmodelableYaml with type comments", () => {
  it("allows recognized type comments", () => {
    expect(hasUnmodelableYaml("price: 9.99 # type:number/currency\n")).toBe(
      false,
    );
  });

  it("still flags foreign comments and anchors", () => {
    expect(hasUnmodelableYaml("a: 1 # just a note\n")).toBe(true);
    expect(hasUnmodelableYaml("a: &x 1\nb: *x\n")).toBe(true);
    expect(hasUnmodelableYaml("a: 1 # type:bogus\n")).toBe(true);
  });
});
```

Add `parseTypeComments` to the test's imports from `./typeComments`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/properties/serializeFrontmatter.test.ts`
Expected: FAIL — `serializeFrontmatter` takes one arg; the comment is not emitted.

- [ ] **Step 3: Implement**

Replace `ui/src/properties/serializeFrontmatter.ts` with:

```ts
/**
 * Frontmatter serializer (spec §7.2). Counterpart to
 * `ui/src/ast/frontmatter.ts`'s splitter/parser.
 *
 * Reproduces scalars, string lists, and nested mappings, plus this
 * app's own `# type:` comments (the type registry, spec §4). It does
 * NOT reproduce foreign comments, anchors, or aliases — `hasUnmodelableYaml`
 * is the guard: the Properties UI renders read-only whenever it returns
 * `true`, so the serializer never runs on frontmatter it cannot
 * faithfully reproduce. Recognized `# type:` comments are exempted from
 * that guard so typed notes stay editable.
 */

import { Document, isAlias, parseDocument, visit } from "yaml";

import { splitFrontmatter } from "../ast/frontmatter";
import type { FrontmatterEntry } from "../ast/types";
import type { CellKind } from "./inferType";
import { isMap, isScalar, isSeq, isTypeComment, KIND_TO_TOKEN } from "./typeComments";

/**
 * Serialize `entries` into a complete `---\n…\n---\n` block. When
 * `types` is supplied, each key present in it (and emittable — not
 * `raw`/`number`) gets a trailing `# type:<token>` comment.
 */
export function serializeFrontmatter(
  entries: FrontmatterEntry[],
  types?: Map<string, CellKind>,
): string {
  if (entries.length === 0) return "---\n---\n";
  const obj: Record<string, unknown> = {};
  for (const [key, value] of entries) obj[key] = value;
  const doc = new Document(obj);

  if (types && isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      if (!isScalar(pair.key)) continue;
      const kind = types.get(String(pair.key.value));
      if (!kind || kind === "raw" || kind === "number") continue;
      const token = KIND_TO_TOKEN[kind];
      if (!token) continue;
      const comment = ` type:${token}`;
      // Scalar value → comment after the value; block list → on the key.
      if (pair.value && !isSeq(pair.value)) {
        (pair.value as { comment?: string | null }).comment = comment;
      } else {
        (pair.key as { comment?: string | null }).comment = comment;
      }
    }
  }

  return `---\n${String(doc)}---\n`;
}

/**
 * Splice a fresh frontmatter `block` into `source`, replacing any
 * existing block. When `source` has no frontmatter the block is
 * inserted at offset 0.
 */
export function spliceFrontmatter(source: string, block: string): string {
  const split = splitFrontmatter(source);
  if (split.span === null) {
    return block + source;
  }
  return block + source.slice(split.span.end);
}

/**
 * Report whether `yamlText` contains YAML the serializer cannot
 * losslessly reproduce — foreign comments, anchors, aliases, or syntax
 * the parser rejects. Recognized `# type:` comments do NOT count.
 */
export function hasUnmodelableYaml(yamlText: string): boolean {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yamlText);
  } catch {
    return true;
  }
  if (doc.errors.length > 0) return true;
  if (doc.commentBefore || doc.comment) return true;

  let flagged = false;
  visit(doc, (_key, node) => {
    if (node == null || typeof node !== "object") return undefined;
    if (isAlias(node)) {
      flagged = true;
      return visit.BREAK;
    }
    const n = node as {
      comment?: string | null;
      commentBefore?: string | null;
      anchor?: string;
    };
    if (n.anchor || n.commentBefore) {
      flagged = true;
      return visit.BREAK;
    }
    if (n.comment && !isTypeComment(n.comment)) {
      flagged = true;
      return visit.BREAK;
    }
    return undefined;
  });
  return flagged;
}
```

- [ ] **Step 4: Run all properties tests**

Run: `cd ui && npx vitest run src/properties/`
Expected: PASS (existing serializer tests still green + new ones).

- [ ] **Step 5: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/properties/serializeFrontmatter.ts ui/src/properties/serializeFrontmatter.test.ts
git commit -m "feat(properties): round-trip type comments through the serializer"
```

---

## Task 3: Pure cell helpers (`format.ts`)

**Files:**
- Create: `ui/src/properties/format.ts`
- Test: `ui/src/properties/format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/properties/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  formatCurrencyUSD,
  normalizeDateTime,
  parseCurrencyInput,
  truncateInt,
} from "./format";

describe("formatCurrencyUSD", () => {
  it("formats as USD with two decimals and separators", () => {
    expect(formatCurrencyUSD(1234.5)).toBe("$1,234.50");
    expect(formatCurrencyUSD(0)).toBe("$0.00");
  });
});

describe("parseCurrencyInput", () => {
  it("strips $ and commas and parses a number", () => {
    expect(parseCurrencyInput("$1,234.50")).toBe(1234.5);
    expect(parseCurrencyInput("9.99")).toBe(9.99);
  });
  it("returns null for non-numeric input", () => {
    expect(parseCurrencyInput("")).toBeNull();
    expect(parseCurrencyInput("abc")).toBeNull();
  });
});

describe("truncateInt", () => {
  it("truncates toward zero", () => {
    expect(truncateInt(3.7)).toBe(3);
    expect(truncateInt(-3.7)).toBe(-3);
    expect(truncateInt(5)).toBe(5);
  });
});

describe("normalizeDateTime", () => {
  it("passes through an ISO datetime", () => {
    expect(normalizeDateTime("2026-06-17T14:30")).toBe("2026-06-17T14:30");
  });
  it("promotes a bare date to midnight", () => {
    expect(normalizeDateTime("2026-06-17")).toBe("2026-06-17T00:00");
  });
  it("returns empty for unparseable input", () => {
    expect(normalizeDateTime("nope")).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/properties/format.test.ts`
Expected: FAIL — `Cannot find module './format'`.

- [ ] **Step 3: Implement**

Create `ui/src/properties/format.ts`:

```ts
/**
 * Pure formatting/parsing helpers for the typed Properties cells. Kept
 * separate from the `.tsx` cells so the logic is unit-testable in the
 * node test environment (component tests are deferred — see
 * `ui/vite.config.ts`).
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Render a number as USD, e.g. `1234.5` → `"$1,234.50"`. */
export function formatCurrencyUSD(value: number): string {
  return USD.format(value);
}

/** Parse a currency input (tolerating `$` and `,`) to a number, or null. */
export function parseCurrencyInput(text: string): number | null {
  const cleaned = text.trim().replace(/[$,]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Truncate a number toward zero to an integer. */
export function truncateInt(value: number): number {
  return Math.trunc(value);
}

/**
 * Normalize a string to an HTML `datetime-local` value (`YYYY-MM-DDThh:mm`).
 * A bare ISO date is promoted to midnight; unparseable input → `""`.
 */
export function normalizeDateTime(value: string): string {
  if (ISO_DATETIME.test(value)) return value.slice(0, 16);
  if (ISO_DATE.test(value)) return `${value}T00:00`;
  return "";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/properties/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/properties/format.ts ui/src/properties/format.test.ts
git commit -m "feat(properties): pure formatting helpers for typed cells"
```

---

## Task 4: Extend `coerce.ts` for new kinds

**Files:**
- Modify: `ui/src/properties/coerce.ts`
- Test: `ui/src/properties/coerce.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/properties/coerce.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { coerceValue } from "./coerce";

describe("coerceValue — new kinds", () => {
  it("multiline behaves like string", () => {
    expect(coerceValue(42, "multiline")).toEqual({ value: "42", lossy: false });
  });

  it("int truncates and flags fractional loss", () => {
    expect(coerceValue(3.7, "int")).toEqual({ value: 3, lossy: true });
    expect(coerceValue(5, "int")).toEqual({ value: 5, lossy: false });
    expect(coerceValue("8", "int")).toEqual({ value: 8, lossy: false });
  });

  it("float behaves like number", () => {
    expect(coerceValue("1.5", "float")).toEqual({ value: 1.5, lossy: false });
  });

  it("currency coerces to a number", () => {
    expect(coerceValue("9.99", "currency")).toEqual({
      value: 9.99,
      lossy: false,
    });
    expect(coerceValue("x", "currency")).toEqual({ value: 0, lossy: true });
  });

  it("datetime keeps ISO datetime, promotes date, else empty", () => {
    expect(coerceValue("2026-06-17T14:30", "datetime")).toEqual({
      value: "2026-06-17T14:30",
      lossy: false,
    });
    expect(coerceValue("2026-06-17", "datetime")).toEqual({
      value: "2026-06-17T00:00",
      lossy: false,
    });
    expect(coerceValue(123, "datetime")).toEqual({ value: "", lossy: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/properties/coerce.test.ts`
Expected: FAIL — new kinds hit no `case` (TS will also error on missing branches once the union grows; the runtime test fails first).

- [ ] **Step 3: Implement**

In `ui/src/properties/coerce.ts`, replace the `switch` in `coerceValue` with:

```ts
export function coerceValue(value: unknown, kind: CellKind): Coercion {
  switch (kind) {
    case "string":
    case "multiline":
      return toStringValue(value);
    case "number":
    case "float":
    case "currency":
      return toNumberValue(value);
    case "int":
      return toIntValue(value);
    case "boolean":
      return toBooleanValue(value);
    case "date":
      return toDateValue(value);
    case "datetime":
      return toDateTimeValue(value);
    case "list-of-strings":
    case "list-of-tags":
      return toListValue(value);
    case "raw":
      // `raw` is not a user-pickable override; leave the value untouched.
      return { value, lossy: false };
  }
}
```

Add these helpers near the other `to*Value` functions (and the regex constant near the top):

```ts
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function toIntValue(value: unknown): Coercion {
  const num = toNumberValue(value);
  const n = num.value as number;
  const i = Math.trunc(n);
  return { value: i, lossy: num.lossy || i !== n };
}

function toDateTimeValue(value: unknown): Coercion {
  if (typeof value === "string") {
    if (ISO_DATETIME.test(value)) return { value, lossy: false };
    if (ISO_DATE.test(value)) return { value: `${value}T00:00`, lossy: false };
  }
  return { value: "", lossy: true };
}
```

(`ISO_DATE` already exists in the file.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/properties/coerce.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors (the `switch` is exhaustive over the extended union).

- [ ] **Step 6: Commit**

```bash
git add ui/src/properties/coerce.ts ui/src/properties/coerce.test.ts
git commit -m "feat(properties): coerce new typed kinds (int, float, currency, datetime, multiline)"
```

---

## Task 5: `NumberCell` integer mode

**Files:**
- Modify: `ui/src/properties/NumberCell.tsx`

- [ ] **Step 1: Add an `integer` prop and truncate on commit**

In `ui/src/properties/NumberCell.tsx`, add the import and extend props + `commit`:

```tsx
import { truncateInt } from "./format";

export interface NumberCellProps {
  value: number;
  onCommit: (next: number) => void;
  /** When true, the committed value is truncated to an integer. */
  integer?: boolean;
}
```

Replace the `commit` function with:

```tsx
  const commit = () => {
    const text = draft().trim();
    const parsed = Number(text);
    if (text === "" || !Number.isFinite(parsed)) {
      setDraft(String(props.value));
      return;
    }
    const final = props.integer ? truncateInt(parsed) : parsed;
    if (final !== props.value) props.onCommit(final);
    setDraft(String(final));
  };
```

- [ ] **Step 2: Type-check + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add ui/src/properties/NumberCell.tsx
git commit -m "feat(properties): NumberCell integer mode"
```

---

## Task 6: `CurrencyCell`

**Files:**
- Create: `ui/src/properties/CurrencyCell.tsx`

- [ ] **Step 1: Implement**

Create `ui/src/properties/CurrencyCell.tsx`:

```tsx
import { createEffect, createSignal, on, type Component } from "solid-js";

import { formatCurrencyUSD, parseCurrencyInput } from "./format";
import { inputStyle } from "./styles";

/**
 * Currency-valued frontmatter cell (spec §8). Stores a BARE number in
 * the YAML (`price: 9.99`); the `$` and formatting are display-only.
 * USD only for now. While focused the raw number is shown for editing;
 * blurred, it renders formatted.
 */
export interface CurrencyCellProps {
  value: number;
  onCommit: (next: number) => void;
}

const CurrencyCell: Component<CurrencyCellProps> = (props) => {
  const [draft, setDraft] = createSignal(String(props.value));
  const [focused, setFocused] = createSignal(false);

  createEffect(
    on(
      () => props.value,
      (v) => {
        if (!focused()) setDraft(String(v));
      },
    ),
  );

  const commit = () => {
    const parsed = parseCurrencyInput(draft());
    if (parsed === null) {
      setDraft(String(props.value));
      return;
    }
    if (parsed !== props.value) props.onCommit(parsed);
    setDraft(String(parsed));
  };

  const display = () => (focused() ? draft() : formatCurrencyUSD(props.value));

  return (
    <input
      type="text"
      inputmode="decimal"
      value={display()}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      style={inputStyle(focused())}
    />
  );
};

export default CurrencyCell;
```

- [ ] **Step 2: Type-check + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add ui/src/properties/CurrencyCell.tsx
git commit -m "feat(properties): CurrencyCell (USD, bare-number storage)"
```

---

## Task 7: `DateTimeCell`

**Files:**
- Create: `ui/src/properties/DateTimeCell.tsx`

- [ ] **Step 1: Implement**

Create `ui/src/properties/DateTimeCell.tsx`:

```tsx
import { createEffect, createSignal, on, type Component } from "solid-js";

import { normalizeDateTime } from "./format";
import { inputStyle } from "./styles";

/**
 * Datetime-valued frontmatter cell (spec §8). A native
 * `<input type="datetime-local">` whose value format is
 * `YYYY-MM-DDThh:mm` — stored verbatim as a YAML plain scalar (the
 * default `yaml` schema does not auto-parse timestamps, so it stays a
 * string, matching DateCell's date handling).
 */
export interface DateTimeCellProps {
  value: string;
  onCommit: (next: string) => void;
}

const DateTimeCell: Component<DateTimeCellProps> = (props) => {
  const [draft, setDraft] = createSignal(normalizeDateTime(props.value));
  const [focused, setFocused] = createSignal(false);

  createEffect(
    on(
      () => props.value,
      (v) => {
        if (!focused()) setDraft(normalizeDateTime(v));
      },
    ),
  );

  const commit = () => {
    if (draft() !== props.value) props.onCommit(draft());
  };

  return (
    <input
      type="datetime-local"
      value={draft()}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onChange={commit}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      style={inputStyle(focused())}
    />
  );
};

export default DateTimeCell;
```

- [ ] **Step 2: Type-check + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add ui/src/properties/DateTimeCell.tsx
git commit -m "feat(properties): DateTimeCell"
```

---

## Task 8: `MultilineCell`

**Files:**
- Create: `ui/src/properties/MultilineCell.tsx`

- [ ] **Step 1: Implement**

Create `ui/src/properties/MultilineCell.tsx`:

```tsx
import { createEffect, createSignal, on, type Component } from "solid-js";

import { inputStyle } from "./styles";

/**
 * Multiline-text frontmatter cell (spec §8). A `<textarea>` that commits
 * on blur (Enter inserts a newline rather than committing). Stores a
 * plain string; the serializer renders multi-line strings as YAML block
 * scalars.
 */
export interface MultilineCellProps {
  value: string;
  onCommit: (next: string) => void;
}

const MultilineCell: Component<MultilineCellProps> = (props) => {
  const [draft, setDraft] = createSignal(props.value);
  const [focused, setFocused] = createSignal(false);

  createEffect(
    on(
      () => props.value,
      (v) => {
        if (!focused()) setDraft(v);
      },
    ),
  );

  const commit = () => {
    if (draft() !== props.value) props.onCommit(draft());
  };

  return (
    <textarea
      rows={3}
      value={draft()}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      style={{ ...inputStyle(focused()), resize: "vertical" }}
    />
  );
};

export default MultilineCell;
```

- [ ] **Step 2: Type-check + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add ui/src/properties/MultilineCell.tsx
git commit -m "feat(properties): MultilineCell"
```

---

## Task 9: Pure Properties logic (`propertiesLogic.ts`)

**Files:**
- Create: `ui/src/properties/propertiesLogic.ts`
- Test: `ui/src/properties/propertiesLogic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/properties/propertiesLogic.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { CellKind } from "./inferType";
import { buildAnnotations, resolveKind } from "./propertiesLogic";

describe("resolveKind", () => {
  const typeMap = new Map<string, CellKind>([["price", "currency"]]);

  it("uses the comment kind when typed is enabled", () => {
    expect(resolveKind(true, typeMap, "price", 9.99)).toBe<CellKind>(
      "currency",
    );
  });

  it("falls back to inference when no comment", () => {
    expect(resolveKind(true, typeMap, "count", 3)).toBe<CellKind>("number");
  });

  it("ignores comments and infers when typed is disabled", () => {
    expect(resolveKind(false, typeMap, "price", 9.99)).toBe<CellKind>("number");
  });
});

describe("buildAnnotations", () => {
  const base = new Map<string, CellKind>([
    ["a", "currency"],
    ["b", "date"],
  ]);

  it("returns a copy unchanged when no override is given", () => {
    const out = buildAnnotations(base);
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });

  it("sets an overridden key", () => {
    const out = buildAnnotations(base, "a", "int");
    expect(out.get("a")).toBe<CellKind>("int");
    expect(out.get("b")).toBe<CellKind>("date");
  });

  it("removes a key when the override kind is null", () => {
    const out = buildAnnotations(base, "a", null);
    expect(out.has("a")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/properties/propertiesLogic.test.ts`
Expected: FAIL — `Cannot find module './propertiesLogic'`.

- [ ] **Step 3: Implement**

Create `ui/src/properties/propertiesLogic.ts`:

```ts
/**
 * Pure resolution + annotation logic for the Properties panel, factored
 * out of `Properties.tsx` so it is unit-testable (component tests are
 * deferred — see `ui/vite.config.ts`).
 */

import { inferType, type CellKind } from "./inferType";

/**
 * Resolve the cell kind for a property: the inline type comment wins
 * when typed properties are enabled, otherwise fall back to inference.
 */
export function resolveKind(
  typedEnabled: boolean,
  typeMap: Map<string, CellKind>,
  key: string,
  value: unknown,
): CellKind {
  const explicit = typedEnabled ? typeMap.get(key) : undefined;
  return explicit ?? inferType(key, value);
}

/**
 * Produce the annotation map to serialize: a copy of `current` with an
 * optional single-key override. Passing `null` for `kind` removes the
 * key's annotation (used by lossy-revert). Passing no override returns a
 * plain copy (used to preserve existing comments on value/rename edits).
 */
export function buildAnnotations(
  current: Map<string, CellKind>,
  key?: string,
  kind?: CellKind | null,
): Map<string, CellKind> {
  const next = new Map(current);
  if (key !== undefined) {
    if (kind == null) next.delete(key);
    else next.set(key, kind);
  }
  return next;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/properties/propertiesLogic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/properties/propertiesLogic.ts ui/src/properties/propertiesLogic.test.ts
git commit -m "feat(properties): pure resolve/annotate logic"
```

---

## Task 10: Wire `Properties.tsx` (nested menu, comment resolution, new cells)

**Files:**
- Modify: `ui/src/Properties.tsx`

This task has no unit test (Solid component, node-only test env). Its logic lives in the helpers tested in Tasks 1–9; correctness is verified by `tsc`, `build`, and the preview workflow in Task 13.

- [ ] **Step 1: Update imports**

In `ui/src/Properties.tsx`, after the existing cell imports, add:

```tsx
import CurrencyCell from "./properties/CurrencyCell";
import DateTimeCell from "./properties/DateTimeCell";
import MultilineCell from "./properties/MultilineCell";
import { parseTypeComments } from "./properties/typeComments";
import { buildAnnotations, resolveKind } from "./properties/propertiesLogic";
```

Remove the now-unused `inferType` import line if present (resolution moves to `resolveKind`); keep `type CellKind` imported from `./properties/inferType`.

- [ ] **Step 2: Replace the flat `TYPE_OPTIONS` with a nested menu model**

Replace the `TYPE_OPTIONS` constant with:

```tsx
/** A leaf type the user can pick. */
interface TypeLeaf {
  kind: CellKind;
  label: string;
}
/** A family in the type menu; single-leaf families commit immediately. */
interface TypeFamily {
  label: string;
  leaves: TypeLeaf[];
}

const TYPE_MENU: TypeFamily[] = [
  {
    label: "Text",
    leaves: [
      { kind: "string", label: "Plain" },
      { kind: "multiline", label: "Multiline" },
    ],
  },
  {
    label: "Number",
    leaves: [
      { kind: "int", label: "Integer" },
      { kind: "float", label: "Decimal" },
      { kind: "currency", label: "Currency (USD)" },
    ],
  },
  { label: "Checkbox", leaves: [{ kind: "boolean", label: "Checkbox" }] },
  {
    label: "Date",
    leaves: [
      { kind: "date", label: "Date" },
      { kind: "datetime", label: "Date & time" },
    ],
  },
  {
    label: "List",
    leaves: [
      { kind: "list-of-strings", label: "List" },
      { kind: "list-of-tags", label: "Tags" },
    ],
  },
];
```

- [ ] **Step 3: Add `typedEnabled` to props**

In `PropertiesProps`, add:

```tsx
  /** Whether typed properties are enabled (Settings ▸ Editor). */
  typedEnabled: boolean;
```

- [ ] **Step 4: Update `RowProps` and the row's cell rendering**

In `RowProps`, add `typedEnabled: boolean;` and a submenu-tracking field:

```tsx
  typedEnabled: boolean;
  openFamily: string | null;
  onOpenFamily: (label: string | null) => void;
```

Replace the cell `<Show>` blocks (the `string`/`number`/… group) with:

```tsx
        <Show when={props.kind === "string"}>
          <StringCell
            value={String(props.value ?? "")}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.kind === "multiline"}>
          <MultilineCell
            value={String(props.value ?? "")}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.kind === "number" || props.kind === "float"}>
          <NumberCell
            value={typeof props.value === "number" ? props.value : 0}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.kind === "int"}>
          <NumberCell
            value={typeof props.value === "number" ? props.value : 0}
            integer
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.kind === "currency"}>
          <CurrencyCell
            value={typeof props.value === "number" ? props.value : 0}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.kind === "boolean"}>
          <BooleanCell
            value={props.value === true}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.kind === "date"}>
          <DateCell
            value={String(props.value ?? "")}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.kind === "datetime"}>
          <DateTimeCell
            value={String(props.value ?? "")}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.kind === "list-of-strings"}>
          <StringListCell
            value={Array.isArray(props.value) ? (props.value as string[]) : []}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.kind === "list-of-tags"}>
          <TagListCell
            value={Array.isArray(props.value) ? (props.value as string[]) : []}
            onCommit={(v) => props.onCommitValue(v)}
            {...(props.onNavigateTag
              ? { onNavigateTag: props.onNavigateTag }
              : {})}
          />
        </Show>
        <Show when={props.kind === "raw"}>
          <RawCell value={props.value} onOpenRaw={props.onOpenRaw} />
        </Show>
```

- [ ] **Step 5: Replace the type-menu chevron + dropdown with the gated nested menu**

Replace the entire third grid cell (the `<div style={{ position: "relative" }}>…</div>` containing the `▾` button and the `role="menu"` block) with:

```tsx
      <Show when={props.typedEnabled} fallback={<div />}>
        <div
          style={{ position: "relative" }}
          onFocusOut={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              props.onCloseMenu();
              props.onOpenFamily(null);
            }
          }}
        >
          <button
            type="button"
            onClick={() => props.onToggleMenu()}
            aria-label={`Change type of ${props.keyName}`}
            aria-haspopup="menu"
            aria-expanded={props.menuOpen}
            style={{ ...miniButtonStyle(), "font-size": "var(--text-sm)" }}
          >
            ▾
          </button>
          <Show when={props.menuOpen}>
            <div
              role="menu"
              style={{
                position: "absolute",
                top: "100%",
                right: "0",
                "z-index": "10",
                display: "flex",
                "flex-direction": "column",
                "min-width": "9rem",
                padding: "var(--space-1)",
                background: "var(--c-bg-primary)",
                border: "1px solid var(--c-border-subtle)",
                "border-radius": "var(--radius-md)",
                "box-shadow": "var(--shadow-md)",
              }}
            >
              <For each={TYPE_MENU}>
                {(family) => (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        if (family.leaves.length === 1) {
                          props.onChangeType(family.leaves[0]!.kind);
                        } else {
                          props.onOpenFamily(
                            props.openFamily === family.label
                              ? null
                              : family.label,
                          );
                        }
                      }}
                      style={{
                        "text-align": "left",
                        display: "flex",
                        "justify-content": "space-between",
                        gap: "var(--space-2)",
                        padding: "var(--space-1) var(--space-2)",
                        "font-family": "var(--font-body)",
                        "font-size": "var(--text-xs)",
                        color: family.leaves.some((l) => l.kind === props.kind)
                          ? "var(--c-accent)"
                          : "var(--c-fg-primary)",
                        background: "transparent",
                        border: "none",
                        "border-radius": "var(--radius-sm)",
                        cursor: "pointer",
                      }}
                    >
                      <span>{family.label}</span>
                      <Show when={family.leaves.length > 1}>
                        <span aria-hidden="true">
                          {props.openFamily === family.label ? "▾" : "▸"}
                        </span>
                      </Show>
                    </button>
                    <Show
                      when={
                        family.leaves.length > 1 &&
                        props.openFamily === family.label
                      }
                    >
                      <div
                        style={{
                          display: "flex",
                          "flex-direction": "column",
                          "padding-left": "var(--space-3)",
                        }}
                      >
                        <For each={family.leaves}>
                          {(leaf) => (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => props.onChangeType(leaf.kind)}
                              style={{
                                "text-align": "left",
                                padding: "var(--space-1) var(--space-2)",
                                "font-family": "var(--font-body)",
                                "font-size": "var(--text-xs)",
                                color:
                                  leaf.kind === props.kind
                                    ? "var(--c-accent)"
                                    : "var(--c-fg-secondary)",
                                background: "transparent",
                                border: "none",
                                "border-radius": "var(--radius-sm)",
                                cursor: "pointer",
                              }}
                            >
                              {leaf.label}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
```

- [ ] **Step 6: Replace the component's state + handlers**

In the `Properties` component body, remove the `overrides` signal and its reset, and replace the resolution/commit/changeType/revertLossy logic. Specifically:

Delete:
```tsx
  const [overrides, setOverrides] = createSignal<Map<string, CellKind>>(
    new Map(),
  );
```
and the `setOverrides(new Map());` line in the `props.path` reset effect.

Add an `openFamily` signal near the other transient signals:
```tsx
  const [openFamily, setOpenFamily] = createSignal<string | null>(null);
```
and reset it in the `props.path` effect (alongside `setMenuKey(null)`):
```tsx
        setOpenFamily(null);
```

Add the type map (recomputed each AST tick, like `modelable`):
```tsx
  // Inline type comments parsed from the live buffer. Recomputed on each
  // AST tick so raw-mode edits flow back in. Always parsed (even when the
  // feature is off) so commits preserve existing comments.
  const typeMap = createMemo(() => {
    void props.frontmatter;
    return parseTypeComments(splitFrontmatter(props.getSource()).yaml ?? "");
  });
```

Replace `commit` to accept an annotation map and default to preserving existing comments:
```tsx
  /** Reserialize `nextEntries` (+ type annotations) and splice in. */
  const commit = (
    nextEntries: FrontmatterEntry[],
    types: Map<string, CellKind> = typeMap(),
  ) => {
    const block = serializeFrontmatter(nextEntries, types);
    const source = props.getSource();
    const span = splitFrontmatter(source).span;
    if (span) {
      props.applyEdit(span.start, span.end, block);
    } else {
      props.applyEdit(0, 0, block);
    }
  };
```

Replace `changeType` and `revertLossy` and `resolvedKind`:
```tsx
  const changeType = (key: string, kind: CellKind) => {
    const current = entryMap().get(key);
    const { value, lossy: isLossy } = coerceValue(current, kind);
    updateMap(setLossy, lossy(), key, isLossy ? { value: current } : undefined);
    setMenuKey(null);
    setOpenFamily(null);
    commit(
      entries().map(
        ([k, v]): FrontmatterEntry => (k === key ? [k, value] : [k, v]),
      ),
      buildAnnotations(typeMap(), key, kind),
    );
  };

  const revertLossy = (key: string) => {
    const entry = lossy().get(key);
    if (!entry) return;
    updateMap(setLossy, lossy(), key, undefined);
    commit(
      entries().map(
        ([k, v]): FrontmatterEntry => (k === key ? [k, entry.value] : [k, v]),
      ),
      buildAnnotations(typeMap(), key, null),
    );
  };

  const resolvedKind = (key: string): CellKind =>
    resolveKind(props.typedEnabled, typeMap(), key, entryMap().get(key));
```

(`commitValue`, `renameKey`, and `addProperty` keep calling `commit(...)` with one argument — they now implicitly preserve `typeMap()`.)

- [ ] **Step 7: Pass the new props into `PropertyRow`**

In the `<For each={keys()}>` body, add to the `<PropertyRow … />`:
```tsx
              typedEnabled={props.typedEnabled}
              openFamily={openFamily()}
              onOpenFamily={(label) => setOpenFamily(label)}
```

- [ ] **Step 8: Type-check + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: success. (If `inferType` is reported unused, remove its import; if `CellKind` is reported unused anywhere, leave it — it is used in `resolvedKind`.)

- [ ] **Step 9: Run the full UI test suite (no regressions)**

Run: `cd ui && npx vitest run`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add ui/src/Properties.tsx
git commit -m "feat(properties): nested type submenu, comment-based resolution, typed cells"
```

---

## Task 11: Add the `properties.typed_enabled` setting

**Files:**
- Modify: `ui/src/api/ipc.ts`

- [ ] **Step 1: Extend the `Setting` union**

In `ui/src/api/ipc.ts`, add a member to the `Setting` union (after `plugins.dataview_enabled`):

```ts
  | { key: "plugins.dataview_enabled"; value: boolean }
  | { key: "properties.typed_enabled"; value: boolean };
```

- [ ] **Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/ipc.ts
git commit -m "feat(settings): add properties.typed_enabled key"
```

---

## Task 12: Settings ▸ Editor toggle + in-app docs + wire into `Properties`

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Add the toggle signal + setter (mirror `rawDefault`)**

In `App.tsx`, near the `rawDefault` signal (~line 195) add:

```tsx
  // Typed-properties feature flag (`properties.typed_enabled`), seeded on
  // vault open. Absent key → enabled (the feature is on by default; nothing
  // is written to a file until the user explicitly picks a type).
  const [typedProps, setTypedProps] = createSignal(true);
```

Near `setRawDefaultValue` (~line 694) add:

```tsx
  /** Set the typed-properties flag (from Settings ▸ Editor). */
  const setTypedPropsValue = (val: boolean) => {
    setTypedProps(val);
    const id = vaultId();
    if (id) {
      setSetting(id, "properties.typed_enabled", val).catch((e) => {
        console.error("persisting properties.typed_enabled failed", e);
      });
    }
  };
```

(Use whatever accessor the surrounding code uses for the current vault id — match the `setRawDefaultValue` implementation exactly; it reads `vaultId()` / `id`.)

- [ ] **Step 2: Hydrate on vault open**

In the vault-open seeding block, right after the `editor.raw_source_default` seed (~line 1168), add:

```tsx
      // Seed the typed-properties flag. Absent key → enabled (default on).
      try {
        const stored = await getSetting(resp.vault_id, "properties.typed_enabled");
        setTypedProps(stored ?? true);
      } catch (e) {
        console.error("loading properties.typed_enabled failed", e);
      }
```

- [ ] **Step 3: Add the Editor-tab toggle row + docs block**

In the `<Show when={settingsTab() === "editor"}>` block, after the existing "Open notes in raw source by default" `set-row` div (after line ~1828, before `</Show>`), add:

```tsx
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Typed properties</div>
                    <div class="set-row__desc">
                      Give frontmatter properties a type (number, currency,
                      date &amp; time, list, …) for type-aware editors.
                    </div>
                  </div>
                  <div class="seg-control">
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{ "seg-control__btn--active": !typedProps() }}
                      onClick={() => setTypedPropsValue(false)}
                    >
                      Off
                    </button>
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{ "seg-control__btn--active": typedProps() }}
                      onClick={() => setTypedPropsValue(true)}
                    >
                      On
                    </button>
                  </div>
                </div>
                <div class="set-row__desc" style={{ "margin-top": "var(--space-2)" }}>
                  <p style={{ margin: "0 0 var(--space-1) 0" }}>
                    <strong>How it works.</strong> Pick a type from the{" "}
                    <code>▾</code> menu on any property row. The Properties
                    panel then shows the right editor — a <code>$</code> field
                    for currency, a date-and-time picker, and so on.
                  </p>
                  <p style={{ margin: "0 0 var(--space-1) 0" }}>
                    The type is saved as a plain comment <em>inside the note</em>,
                    so it travels with the file and any tool can read it:
                  </p>
                  <pre
                    style={{
                      margin: "0 0 var(--space-1) 0",
                      padding: "var(--space-2)",
                      "font-family": "var(--font-mono)",
                      "font-size": "var(--text-xs)",
                      background: "var(--c-bg-primary)",
                      border: "1px solid var(--c-border-subtle)",
                      "border-radius": "var(--radius-sm)",
                      "white-space": "pre-wrap",
                    }}
                  >{`---
price: 9.99    # type:number/currency
due: 2026-06-17    # type:date
---`}</pre>
                  <p style={{ margin: 0 }}>
                    Nothing is stored outside the vault. Turning this off leaves
                    any existing <code># type:</code> comments untouched.
                  </p>
                </div>
```

- [ ] **Step 4: Pass `typedEnabled` to `Properties`**

At the `<Properties … />` usage (~line 1603), add the prop:

```tsx
                    typedEnabled={typedProps()}
```

- [ ] **Step 5: Type-check + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(settings): Editor-tab typed-properties toggle + in-app docs"
```

---

## Task 13: Full verification (gates + preview smoke)

**Files:** none (verification only).

- [ ] **Step 1: Run every UI gate**

Run:
```bash
cd ui && npx tsc --noEmit && npx vitest run && npm run build
```
Expected: tsc clean; all vitest pass; build succeeds. Note the new vitest count (Task 1/2/3/4/9 added test files).

- [ ] **Step 2: Confirm Rust gates still green (untouched, sanity)**

Run (from repo root):
```bash
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check
```
Expected: green (no Rust files changed).

- [ ] **Step 3: Preview smoke (per the verification workflow)**

Start the dev server (`preview_start`), open a note, and verify in the browser preview:
1. Properties panel shows the `▾` menu; opening Number reveals Integer / Decimal / Currency (USD) as a submenu.
2. Choosing **Currency (USD)** on a numeric property renders a `$`-formatted field; the underlying source (toggle to raw) shows `price: 9.99   # type:number/currency` and the value stays a bare number.
3. Choosing **Date & time** renders a datetime picker; source carries `# type:datetime`.
4. Switch documents and back — the type **persists** (read from the comment), unlike the old transient behavior.
5. Settings ▸ Editor shows the **Typed properties** toggle + docs. Turn it **off**: the `▾` menu disappears, the currency field renders as a plain number, but the `# type:` comment remains in the source and the panel is NOT read-only.

Capture a screenshot of the Properties panel with a currency + datetime field as proof.

- [ ] **Step 4: Final commit (if any preview-driven fixes were made)**

```bash
git add -A && git commit -m "fix(properties): preview-smoke adjustments"
```
(Skip if nothing changed.)

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** §4 grammar → Task 1; §5 union → Task 1; §6 resolution → Task 9/10; §7.1 parse → Task 1; §7.2 serialize → Task 2; §7.3 guard relaxation → Task 2; §8 cells/menu → Tasks 5–8, 10; §8b settings+docs → Tasks 11–12; §10 tests → Tasks 1–4, 9; §11 gates → Task 13.
- **Off-behavior (§8b.4):** `typeMap` is parsed unconditionally and always passed to `serializeFrontmatter`, so comments are preserved when off; the menu (Task 10 Step 5) is gated behind `props.typedEnabled`; resolution gating lives in `resolveKind` (Task 9).
- **No comment spray:** `changeType` only annotates the key the user picked (via `buildAnnotations`); value/rename/add commits pass `typeMap()` unchanged, so untyped keys never gain a comment.
