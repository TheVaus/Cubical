> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Typed Properties (Inline YAML Comments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each frontmatter property a persistent type/subtype, stored as a portable inline YAML comment (`price: 9.99 # type:number/currency`), with type-aware editor cells, configurable date formats, and a Settings ▸ Editor on/off toggle plus in-app docs.

**Architecture:** Per-note inline comments are the source of truth (no registry, no index, no Rust). A grammar module maps a property's resolved type — `PropertyType = { kind, format? }` — to/from a comment token. The Properties panel resolves a property's type from its comment (else falls back to inference), renders the matching cell, and writes the comment back via the `yaml` Document API. The `date` type carries a curated format whose vault-wide default lives in settings; a non-default format is written inline. A vault setting gates the typed UI; comment preservation is always on so toggling off is non-destructive.

**Tech Stack:** Solid + TypeScript, eemeli's `yaml` package (already a dependency), Vitest (node env, `*.test.ts` pure-function tests only — component tests are deferred per `ui/vite.config.ts`).

**Spec:** `docs/superpowers/specs/2026-06-17-typed-properties-inline-comments-design.md`

**Conventions:**
- Tests are pure-function `*.test.ts` in node env. Cell `.tsx` files contain no unit-testable logic — any real logic is extracted into pure helpers (`format.ts`, `dateFormats.ts`, `propertiesLogic.ts`) that ARE tested; `.tsx` wiring is verified via `npx tsc --noEmit`, `npm run build`, and the preview workflow.
- Inline styles via `var(--…)` tokens and the helpers in `ui/src/properties/styles.ts` (no hardcoded colors).
- Run all UI commands from the `ui/` directory.

**Deviations from spec §7.1:** `parseTypeComments` and `PropertyType` live in `ui/src/properties/typeComments.ts` (with the grammar maps), not `ui/src/ast/frontmatter.ts` — keeps all grammar in one module and avoids the `ast` layer depending on `properties`. Behavior is identical.

---

## File Structure

**New files:**
- `ui/src/properties/dateFormats.ts` — curated date-format table: validate, parse, format, cross-format `convertDate`, `effectiveDateFormat`, `DEFAULT_DATE_FORMAT`.
- `ui/src/properties/dateFormats.test.ts`
- `ui/src/properties/typeComments.ts` — `PropertyType`, grammar maps, `parseTypeToken`, `typeToToken`, `isTypeComment`, `parseTypeComments`.
- `ui/src/properties/typeComments.test.ts`
- `ui/src/properties/format.ts` — pure cell helpers: `formatCurrencyUSD`, `parseCurrencyInput`, `truncateInt`, `normalizeDateTime`.
- `ui/src/properties/format.test.ts`
- `ui/src/properties/propertiesLogic.ts` — pure `resolveType`, `effectiveFormat`, `buildAnnotations`.
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
- `ui/src/properties/DateCell.tsx` — format-aware (native / numeric / validated text).
- `ui/src/Properties.tsx` — `typedEnabled`/`dateDefault` props, comment-based resolution, nested submenu (date formats), new cells, annotate-on-commit.
- `ui/src/api/ipc.ts` — add `properties.typed_enabled` + `properties.date_format_default`.
- `ui/src/App.tsx` — toggle + default-format dropdown + docs, hydrate, pass props to `Properties`.

---

## Task 1: `dateFormats.ts` — curated date-format table

**Files:**
- Create: `ui/src/properties/dateFormats.ts`
- Test: `ui/src/properties/dateFormats.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/properties/dateFormats.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  convertDate,
  DATE_FORMAT_TOKENS,
  DEFAULT_DATE_FORMAT,
  effectiveDateFormat,
  getDateFormat,
  isKnownDateFormat,
  validateDate,
} from "./dateFormats";

describe("table", () => {
  it("default is ISO and all tokens are known", () => {
    expect(DEFAULT_DATE_FORMAT).toBe("YYYY-MM-DD");
    for (const t of DATE_FORMAT_TOKENS) expect(isKnownDateFormat(t)).toBe(true);
    expect(isKnownDateFormat("MMM D")).toBe(false);
  });
  it("marks YYYY-MM-DD native and YYYY numeric", () => {
    expect(getDateFormat("YYYY-MM-DD")!.native).toBe(true);
    expect(getDateFormat("YYYY")!.numeric).toBe(true);
    expect(getDateFormat("DD-MM-YY")!.native).toBe(false);
  });
});

describe("validateDate", () => {
  it("accepts well-formed, rejects malformed", () => {
    expect(validateDate("2026-06-17", "YYYY-MM-DD")).toBe(true);
    expect(validateDate("17-06-26", "DD-MM-YY")).toBe(true);
    expect(validateDate(2026, "YYYY")).toBe(true);
    expect(validateDate("2026/06", "YYYY-MM")).toBe(false);
    expect(validateDate("nope", "YYYY-MM-DD")).toBe(false);
  });
});

describe("convertDate", () => {
  it("reformats between formats that share parts", () => {
    expect(convertDate("2026-06-17", "DD-MM-YYYY")).toEqual({
      value: "17-06-2026",
      lossy: false,
    });
    expect(convertDate("17/06/2026", "YYYY-MM-DD")).toEqual({
      value: "2026-06-17",
      lossy: false,
    });
    expect(convertDate("2026-06-17", "YYYY")).toEqual({
      value: 2026,
      lossy: false,
    });
  });
  it("blanks + flags lossy when widening loses month/day", () => {
    expect(convertDate(2026, "YYYY-MM-DD")).toEqual({ value: "", lossy: true });
  });
  it("blanks + flags lossy for unparseable input", () => {
    expect(convertDate("garbage", "YYYY-MM-DD")).toEqual({
      value: "",
      lossy: true,
    });
  });
});

describe("effectiveDateFormat", () => {
  it("prefers inline, then vault default, then ISO", () => {
    expect(effectiveDateFormat("DD-MM-YY", "YYYY")).toBe("DD-MM-YY");
    expect(effectiveDateFormat(undefined, "YYYY")).toBe("YYYY");
    expect(effectiveDateFormat(undefined, undefined)).toBe("YYYY-MM-DD");
    // Unknown values fall back.
    expect(effectiveDateFormat("BOGUS", "ALSO-BAD")).toBe("YYYY-MM-DD");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/properties/dateFormats.test.ts`
Expected: FAIL — `Cannot find module './dateFormats'`.

- [ ] **Step 3: Implement**

Create `ui/src/properties/dateFormats.ts`:

```ts
/**
 * Curated date-format table (spec §4b). No date library: each format has
 * an explicit validation regex and parse/format rules. Pure + node-test
 * friendly. The grammar (typeComments) stores the token verbatim, so
 * adding a format is a one-row change here.
 */

export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";

interface DateParts {
  y: number;
  m?: number;
  d?: number;
}

export interface DateFormatDef {
  token: string;
  /** Placeholder/hint shown in the text input. */
  placeholder: string;
  /** Use the native `<input type=date>` (only YYYY-MM-DD). */
  native: boolean;
  /** Value is a YAML number, not a string (only YYYY). */
  numeric: boolean;
  regex: RegExp;
  /** Parse a string into parts, or null if it does not match. */
  toParts(s: string): DateParts | null;
  /** Render parts, or null if a required part is missing. */
  fromParts(p: DateParts): string | null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export const DATE_FORMATS: DateFormatDef[] = [
  {
    token: "YYYY-MM-DD",
    placeholder: "YYYY-MM-DD",
    native: true,
    numeric: false,
    regex: /^(\d{4})-(\d{2})-(\d{2})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { y: +m[1]!, m: +m[2]!, d: +m[3]! } : null;
    },
    fromParts(p) {
      return p.m && p.d ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : null;
    },
  },
  {
    token: "YYYY",
    placeholder: "YYYY",
    native: false,
    numeric: true,
    regex: /^(\d{4})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { y: +m[1]! } : null;
    },
    fromParts(p) {
      return `${p.y}`;
    },
  },
  {
    token: "YYYY-MM",
    placeholder: "YYYY-MM",
    native: false,
    numeric: false,
    regex: /^(\d{4})-(\d{2})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { y: +m[1]!, m: +m[2]! } : null;
    },
    fromParts(p) {
      return p.m ? `${p.y}-${pad(p.m)}` : null;
    },
  },
  {
    token: "DD-MM-YYYY",
    placeholder: "DD-MM-YYYY",
    native: false,
    numeric: false,
    regex: /^(\d{2})-(\d{2})-(\d{4})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { d: +m[1]!, m: +m[2]!, y: +m[3]! } : null;
    },
    fromParts(p) {
      return p.m && p.d ? `${pad(p.d)}-${pad(p.m)}-${p.y}` : null;
    },
  },
  {
    token: "DD-MM-YY",
    placeholder: "DD-MM-YY",
    native: false,
    numeric: false,
    regex: /^(\d{2})-(\d{2})-(\d{2})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { d: +m[1]!, m: +m[2]!, y: 2000 + +m[3]! } : null;
    },
    fromParts(p) {
      return p.m && p.d ? `${pad(p.d)}-${pad(p.m)}-${pad(p.y % 100)}` : null;
    },
  },
  {
    token: "MM/DD/YYYY",
    placeholder: "MM/DD/YYYY",
    native: false,
    numeric: false,
    regex: /^(\d{2})\/(\d{2})\/(\d{4})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { m: +m[1]!, d: +m[2]!, y: +m[3]! } : null;
    },
    fromParts(p) {
      return p.m && p.d ? `${pad(p.m)}/${pad(p.d)}/${p.y}` : null;
    },
  },
  {
    token: "DD/MM/YYYY",
    placeholder: "DD/MM/YYYY",
    native: false,
    numeric: false,
    regex: /^(\d{2})\/(\d{2})\/(\d{4})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { d: +m[1]!, m: +m[2]!, y: +m[3]! } : null;
    },
    fromParts(p) {
      return p.m && p.d ? `${pad(p.d)}/${pad(p.m)}/${p.y}` : null;
    },
  },
];

export const DATE_FORMAT_TOKENS: string[] = DATE_FORMATS.map((f) => f.token);

export function getDateFormat(token: string): DateFormatDef | undefined {
  return DATE_FORMATS.find((f) => f.token === token);
}

export function isKnownDateFormat(token: string | undefined): boolean {
  return token !== undefined && getDateFormat(token) !== undefined;
}

/** inline format → vault default → ISO, ignoring unknown tokens. */
export function effectiveDateFormat(
  inline: string | undefined,
  vaultDefault: string | undefined,
): string {
  if (isKnownDateFormat(inline)) return inline!;
  if (isKnownDateFormat(vaultDefault)) return vaultDefault!;
  return DEFAULT_DATE_FORMAT;
}

/** Whether `value` is a valid instance of `token`'s format. */
export function validateDate(value: unknown, token: string): boolean {
  const fmt = getDateFormat(token);
  if (!fmt) return false;
  return fmt.toParts(String(value)) !== null;
}

/**
 * Convert `value` to the `toToken` format, best-effort. Parses against
 * every known format to recover parts, then renders. Returns a blank +
 * `lossy` when no format parses the input, or when the target needs a
 * month/day the source lacks (no parts are invented).
 */
export function convertDate(
  value: unknown,
  toToken: string,
): { value: string | number; lossy: boolean } {
  const target = getDateFormat(toToken);
  if (!target) return { value: "", lossy: true };
  const s = String(value ?? "").trim();
  let parts: DateParts | null = null;
  for (const fmt of DATE_FORMATS) {
    const p = fmt.toParts(s);
    if (p) {
      parts = p;
      break;
    }
  }
  if (!parts) return { value: "", lossy: true };
  const rendered = target.fromParts(parts);
  if (rendered === null) return { value: "", lossy: true };
  return { value: target.numeric ? Number(rendered) : rendered, lossy: false };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/properties/dateFormats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/properties/dateFormats.ts ui/src/properties/dateFormats.test.ts
git commit -m "feat(properties): curated date-format table"
```

---

## Task 2: Grammar module (`typeComments.ts`) + `PropertyType` + extend `CellKind`

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

`inferType` itself is unchanged.

- [ ] **Step 2: Write the failing test**

Create `ui/src/properties/typeComments.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { CellKind } from "./inferType";
import {
  isTypeComment,
  parseTypeComments,
  parseTypeToken,
  type PropertyType,
  typeToToken,
} from "./typeComments";

describe("parseTypeToken", () => {
  it("maps canonical tokens to property types", () => {
    expect(parseTypeToken(" type:text")).toEqual({ kind: "string" });
    expect(parseTypeToken(" type:text/multiline")).toEqual({
      kind: "multiline",
    });
    expect(parseTypeToken(" type:number/int")).toEqual({ kind: "int" });
    expect(parseTypeToken(" type:number/currency")).toEqual({
      kind: "currency",
    });
    expect(parseTypeToken(" type:checkbox")).toEqual({ kind: "boolean" });
    expect(parseTypeToken(" type:datetime")).toEqual({ kind: "datetime" });
    expect(parseTypeToken(" type:list")).toEqual({ kind: "list-of-strings" });
    expect(parseTypeToken(" type:tags")).toEqual({ kind: "list-of-tags" });
  });

  it("parses bare and formatted dates", () => {
    expect(parseTypeToken(" type:date")).toEqual({ kind: "date" });
    expect(parseTypeToken(" type:date:DD-MM-YY")).toEqual({
      kind: "date",
      format: "DD-MM-YY",
    });
    // Unknown date format is still a date; format dropped (falls back later).
    expect(parseTypeToken(" type:date:WUT")).toEqual({ kind: "date" });
  });

  it("accepts aliases and future currency params", () => {
    expect(parseTypeToken("type:date/datetime")).toEqual({ kind: "datetime" });
    expect(parseTypeToken("type:list/tags")).toEqual({ kind: "list-of-tags" });
    expect(parseTypeToken("type:number/currency:EUR")).toEqual({
      kind: "currency",
    });
  });

  it("returns undefined for non-type or unknown kind", () => {
    expect(parseTypeToken("just a note")).toBeUndefined();
    expect(parseTypeToken("type:bogus")).toBeUndefined();
    expect(parseTypeToken(null)).toBeUndefined();
  });
});

describe("isTypeComment", () => {
  it("is true for any recognized type token incl. dates", () => {
    expect(isTypeComment(" type:number/currency")).toBe(true);
    expect(isTypeComment(" type:date:DD-MM-YY")).toBe(true);
    expect(isTypeComment(" type:date:WUT")).toBe(true); // still a date
    expect(isTypeComment(" a regular comment")).toBe(false);
    expect(isTypeComment(" type:nonsense")).toBe(false);
  });
});

describe("typeToToken", () => {
  it("emits canonical tokens; omits default date format", () => {
    expect(typeToToken({ kind: "currency" }, "YYYY-MM-DD")).toBe(
      "number/currency",
    );
    expect(typeToToken({ kind: "date" }, "YYYY-MM-DD")).toBe("date");
    expect(typeToToken({ kind: "date", format: "YYYY-MM-DD" }, "YYYY-MM-DD")).toBe(
      "date",
    );
    expect(typeToToken({ kind: "date", format: "DD-MM-YY" }, "YYYY-MM-DD")).toBe(
      "date:DD-MM-YY",
    );
    // Inferred-only/raw kinds are not emitted.
    expect(typeToToken({ kind: "number" }, "YYYY-MM-DD")).toBeNull();
    expect(typeToToken({ kind: "raw" }, "YYYY-MM-DD")).toBeNull();
  });

  it("round-trips through parseTypeToken", () => {
    const cases: PropertyType[] = [
      { kind: "string" },
      { kind: "multiline" },
      { kind: "int" },
      { kind: "float" },
      { kind: "currency" },
      { kind: "boolean" },
      { kind: "date" },
      { kind: "date", format: "DD-MM-YY" },
      { kind: "datetime" },
      { kind: "list-of-strings" },
      { kind: "list-of-tags" },
    ];
    for (const t of cases) {
      const token = typeToToken(t, "YYYY-MM-DD");
      expect(token).not.toBeNull();
      expect(parseTypeToken(` type:${token}`)).toEqual(t);
    }
  });
});

describe("parseTypeComments", () => {
  it("reads trailing type comments per top-level key", () => {
    const yaml =
      "price: 9.99 # type:number/currency\n" +
      "d: 17-06-26 # type:date:DD-MM-YY\n" +
      "people: # type:list\n  - Ann\n" +
      "plain: hi\n";
    const map = parseTypeComments(yaml);
    expect(map.get("price")).toEqual<PropertyType>({ kind: "currency" });
    expect(map.get("d")).toEqual<PropertyType>({
      kind: "date",
      format: "DD-MM-YY",
    });
    expect(map.get("people")).toEqual<PropertyType>({ kind: "list-of-strings" });
    expect(map.has("plain")).toBe(false);
  });

  it("ignores unknown comments and malformed yaml", () => {
    expect(parseTypeComments("a: 1 # whatever\n").size).toBe(0);
    expect(parseTypeComments("a: : :\n  - bad\n").size).toBe(0);
  });
});

declare module "vitest" {}

// Re-export for the round-trip case above.
export type { CellKind };
```

(The trailing `declare`/`export` lines just keep the test file self-typed; they can be dropped if your linter prefers.)

- [ ] **Step 3: Run to verify it fails**

Run: `cd ui && npx vitest run src/properties/typeComments.test.ts`
Expected: FAIL — `Cannot find module './typeComments'`.

- [ ] **Step 4: Implement `typeComments.ts`**

Create `ui/src/properties/typeComments.ts`:

```ts
/**
 * Inline type-comment grammar (spec §4, §4b, §7.1).
 *
 * Types are stored as a trailing YAML comment on a property's key line,
 * e.g. `price: 9.99 # type:number/currency` or `d: 17-06-26 #
 * type:date:DD-MM-YY`. This module is the single source of truth for the
 * `PropertyType ⇄ comment token` mapping and for reading those comments
 * out of a frontmatter YAML string.
 *
 * Marker is `type:`. Because `type:` is a common word, a comment counts
 * as a type hint ONLY when what follows resolves to a known kind.
 */

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { isKnownDateFormat } from "./dateFormats";
import type { CellKind } from "./inferType";

/** A resolved property type: a kind plus an optional date format. */
export interface PropertyType {
  kind: CellKind;
  /** Only meaningful when `kind === "date"`. */
  format?: string;
}

/** Emittable kinds → canonical token (date handled separately). */
const KIND_TO_TOKEN: Partial<Record<CellKind, string>> = {
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
  // `number` and `raw` are intentionally absent — never written.
};

/** Canonical + alias tokens → kind (date/currency handled in code). */
const TOKEN_TO_KIND: Record<string, CellKind> = {
  text: "string",
  "text/plain": "string",
  "text/multiline": "multiline",
  number: "number",
  "number/int": "int",
  "number/float": "float",
  checkbox: "boolean",
  datetime: "datetime",
  "date/datetime": "datetime",
  list: "list-of-strings",
  "list/list": "list-of-strings",
  tags: "list-of-tags",
  "list/tags": "list-of-tags",
};

/** A node comment like ` type:date:DD-MM-YY` (no leading `#`). */
const TYPE_RE = /^\s*type:(\S+)\s*$/;

/** Parse a node `comment` string into a PropertyType, or `undefined`. */
export function parseTypeToken(
  comment: string | null | undefined,
): PropertyType | undefined {
  if (!comment) return undefined;
  const m = TYPE_RE.exec(comment);
  if (!m) return undefined;
  const raw = m[1]!.trim();

  // Date with optional format param: `date` or `date:FORMAT`. (The
  // `date/datetime` alias falls through to TOKEN_TO_KIND → datetime.)
  if (raw === "date") return { kind: "date" };
  if (raw.startsWith("date:")) {
    const format = raw.slice("date:".length);
    return isKnownDateFormat(format) ? { kind: "date", format } : { kind: "date" };
  }
  // Currency tolerates a future per-currency param, e.g. number/currency:EUR.
  if (raw === "number/currency" || raw.startsWith("number/currency:")) {
    return { kind: "currency" };
  }
  const kind = TOKEN_TO_KIND[raw];
  return kind ? { kind } : undefined;
}

/** Whether a node comment is a recognized type hint. */
export function isTypeComment(comment: string | null | undefined): boolean {
  return parseTypeToken(comment) !== undefined;
}

/**
 * Build the comment token for a PropertyType, or `null` when the type is
 * not emittable (`number`, `raw`). The date format is appended only when
 * it differs from `defaultFormat`.
 */
export function typeToToken(
  type: PropertyType,
  defaultFormat: string,
): string | null {
  if (type.kind === "date") {
    if (type.format && type.format !== defaultFormat) {
      return `date:${type.format}`;
    }
    return "date";
  }
  return KIND_TO_TOKEN[type.kind] ?? null;
}

/**
 * Read per-key type comments from a frontmatter YAML body. Only
 * top-level keys; value-node comment wins over key-node comment.
 */
export function parseTypeComments(yaml: string): Map<string, PropertyType> {
  const out = new Map<string, PropertyType>();
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
    const type = parseTypeToken(valComment) ?? parseTypeToken(keyComment);
    if (type) out.set(key, type);
  }
  return out;
}

// Shared `yaml` predicates for serializeFrontmatter.
export { isMap, isScalar, isSeq };
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ui && npx vitest run src/properties/typeComments.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/properties/inferType.ts ui/src/properties/typeComments.ts ui/src/properties/typeComments.test.ts
git commit -m "feat(properties): inline type-comment grammar (PropertyType, date formats)"
```

---

## Task 3: Serialize with comments + relax `hasUnmodelableYaml`

**Files:**
- Modify: `ui/src/properties/serializeFrontmatter.ts`
- Test: `ui/src/properties/serializeFrontmatter.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/properties/serializeFrontmatter.test.ts` (add the imports):

```ts
import type { PropertyType } from "./typeComments";
import { parseTypeComments } from "./typeComments";

const ISO = "YYYY-MM-DD";

describe("serializeFrontmatter with type comments", () => {
  it("writes a trailing type comment for a scalar value", () => {
    const out = serializeFrontmatter(
      [["price", 9.99]],
      new Map<string, PropertyType>([["price", { kind: "currency" }]]),
      ISO,
    );
    expect(out).toContain("# type:number/currency");
    expect(out).toContain("price: 9.99");
  });

  it("omits the param for a default-format date, writes it otherwise", () => {
    const def = serializeFrontmatter(
      [["a", "2026-06-17"]],
      new Map<string, PropertyType>([["a", { kind: "date", format: ISO }]]),
      ISO,
    );
    expect(def).toContain("# type:date");
    expect(def).not.toContain("# type:date:");

    const custom = serializeFrontmatter(
      [["a", "17-06-26"]],
      new Map<string, PropertyType>([
        ["a", { kind: "date", format: "DD-MM-YY" }],
      ]),
      ISO,
    );
    expect(custom).toContain("# type:date:DD-MM-YY");
  });

  it("writes the comment on the key line for a block-list value", () => {
    const out = serializeFrontmatter(
      [["people", ["Ann"]]],
      new Map<string, PropertyType>([["people", { kind: "list-of-strings" }]]),
      ISO,
    );
    const firstLine = out.split("\n").find((l) => l.startsWith("people:"))!;
    expect(firstLine).toContain("# type:list");
  });

  it("does not annotate inferred-only or raw kinds", () => {
    const out = serializeFrontmatter(
      [["n", 3]],
      new Map<string, PropertyType>([["n", { kind: "number" }]]),
      ISO,
    );
    expect(out).not.toContain("# type:");
  });

  it("round-trips: serialize then parseTypeComments recovers the types", () => {
    const types = new Map<string, PropertyType>([
      ["price", { kind: "currency" }],
      ["d", { kind: "date", format: "DD-MM-YY" }],
      ["tags", { kind: "list-of-tags" }],
    ]);
    const out = serializeFrontmatter(
      [
        ["price", 9.99],
        ["d", "17-06-26"],
        ["tags", ["draft"]],
      ],
      types,
      ISO,
    );
    const body = out.replace(/^---\n/, "").replace(/---\n$/, "");
    expect(parseTypeComments(body)).toEqual(types);
  });
});

describe("hasUnmodelableYaml with type comments", () => {
  it("allows recognized type comments incl. dated", () => {
    expect(hasUnmodelableYaml("price: 9.99 # type:number/currency\n")).toBe(
      false,
    );
    expect(hasUnmodelableYaml("d: 17-06-26 # type:date:DD-MM-YY\n")).toBe(false);
  });

  it("still flags foreign comments and anchors", () => {
    expect(hasUnmodelableYaml("a: 1 # just a note\n")).toBe(true);
    expect(hasUnmodelableYaml("a: &x 1\nb: *x\n")).toBe(true);
    expect(hasUnmodelableYaml("a: 1 # type:bogus\n")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/properties/serializeFrontmatter.test.ts`
Expected: FAIL — `serializeFrontmatter` takes one arg; comment not emitted.

- [ ] **Step 3: Implement**

Replace `ui/src/properties/serializeFrontmatter.ts` with:

```ts
/**
 * Frontmatter serializer (spec §7.2). Reproduces scalars, string lists,
 * nested mappings, plus this app's own `# type:` comments (the type
 * registry). Foreign comments/anchors/aliases are NOT reproduced —
 * `hasUnmodelableYaml` guards: the Properties UI renders read-only
 * whenever it returns `true`. Recognized `# type:` comments are exempted.
 */

import { Document, isAlias, parseDocument, visit } from "yaml";

import { splitFrontmatter } from "../ast/frontmatter";
import type { FrontmatterEntry } from "../ast/types";
import {
  isMap,
  isScalar,
  isSeq,
  isTypeComment,
  type PropertyType,
  typeToToken,
} from "./typeComments";

/**
 * Serialize `entries` into a `---\n…\n---\n` block. When `types` is
 * supplied, each emittable key gets a trailing `# type:<token>` comment;
 * `dateDefault` decides whether a date's format param is written.
 */
export function serializeFrontmatter(
  entries: FrontmatterEntry[],
  types?: Map<string, PropertyType>,
  dateDefault = "YYYY-MM-DD",
): string {
  if (entries.length === 0) return "---\n---\n";
  const obj: Record<string, unknown> = {};
  for (const [key, value] of entries) obj[key] = value;
  const doc = new Document(obj);

  if (types && isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      if (!isScalar(pair.key)) continue;
      const type = types.get(String(pair.key.value));
      if (!type) continue;
      const token = typeToToken(type, dateDefault);
      if (!token) continue;
      const comment = ` type:${token}`;
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
 * Splice a fresh `block` into `source`, replacing any existing block.
 */
export function spliceFrontmatter(source: string, block: string): string {
  const split = splitFrontmatter(source);
  if (split.span === null) return block + source;
  return block + source.slice(split.span.end);
}

/**
 * Whether `yamlText` contains YAML the serializer cannot losslessly
 * reproduce — foreign comments, anchors, aliases, or rejected syntax.
 * Recognized `# type:` comments do NOT count.
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
git commit -m "feat(properties): round-trip type comments (incl. date format) through serializer"
```

---

## Task 4: Pure cell helpers (`format.ts`)

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

## Task 5: Extend `coerce.ts` for new kinds

**Files:**
- Modify: `ui/src/properties/coerce.ts`
- Test: `ui/src/properties/coerce.test.ts`

Note: `date` coercion stays kind-level (best-effort ISO). Cross-*format* date conversion is handled by `dateFormats.convertDate`, invoked from `Properties.changeType` (Task 12), not here.

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
Expected: FAIL — new kinds hit no `case`.

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
      return { value, lossy: false };
  }
}
```

Add near the other helpers (and the regex by the top with `ISO_DATE`):

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

## Task 6: `NumberCell` integer mode

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

## Task 7: `CurrencyCell`

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
 * the YAML; the `$` and formatting are display-only. USD only. While
 * focused the raw number is shown for editing; blurred, it renders
 * formatted.
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

## Task 8: Format-aware `DateCell`

**Files:**
- Modify: `ui/src/properties/DateCell.tsx`

- [ ] **Step 1: Reimplement DateCell to honor a `format` prop**

Replace `ui/src/properties/DateCell.tsx` with:

```tsx
import { createEffect, createSignal, on, Show, type Component } from "solid-js";

import { getDateFormat, validateDate } from "./dateFormats";
import { inputStyle } from "./styles";

/**
 * Date-valued frontmatter cell (spec §4b). Renders per the resolved
 * `format`:
 *  - `YYYY-MM-DD` → native `<input type=date>`.
 *  - `YYYY`       → numeric year input (commits a number).
 *  - others       → text input validated against the format on commit
 *                   (invalid → reverts to the last committed value).
 * The committed value is written verbatim in the chosen format.
 */
export interface DateCellProps {
  value: string | number;
  format: string;
  onCommit: (next: string | number) => void;
}

const DateCell: Component<DateCellProps> = (props) => {
  const [draft, setDraft] = createSignal(String(props.value ?? ""));
  const [focused, setFocused] = createSignal(false);

  createEffect(
    on(
      () => [props.value, props.format] as const,
      ([v]) => {
        if (!focused()) setDraft(String(v ?? ""));
      },
    ),
  );

  const def = () => getDateFormat(props.format);

  const commit = () => {
    const text = draft().trim();
    const numeric = def()?.numeric ?? false;
    // Empty is allowed (clears the value).
    if (text !== "" && !validateDate(text, props.format)) {
      setDraft(String(props.value ?? ""));
      return;
    }
    const next: string | number = numeric && text !== "" ? Number(text) : text;
    if (next !== props.value) props.onCommit(next);
  };

  return (
    <Show
      when={def()?.native}
      fallback={
        <input
          type="text"
          inputmode={def()?.numeric ? "numeric" : "text"}
          placeholder={def()?.placeholder ?? props.format}
          value={draft()}
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
      }
    >
      <input
        type="date"
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
    </Show>
  );
};

export default DateCell;
```

- [ ] **Step 2: Type-check + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: success (callers updated in Task 12; if `tsc` flags the old `DateCell` usage in `Properties.tsx` before Task 12 runs, that is expected — proceed; it is fixed in Task 12. To keep this task green in isolation, Task 12 may be done immediately after).

- [ ] **Step 3: Commit**

```bash
git add ui/src/properties/DateCell.tsx
git commit -m "feat(properties): format-aware DateCell"
```

---

## Task 9: `DateTimeCell`

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
 * `<input type="datetime-local">`; value format `YYYY-MM-DDThh:mm` is
 * stored verbatim as a YAML plain scalar.
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

## Task 10: `MultilineCell`

**Files:**
- Create: `ui/src/properties/MultilineCell.tsx`

- [ ] **Step 1: Implement**

Create `ui/src/properties/MultilineCell.tsx`:

```tsx
import { createEffect, createSignal, on, type Component } from "solid-js";

import { inputStyle } from "./styles";

/**
 * Multiline-text frontmatter cell (spec §8). A `<textarea>` that commits
 * on blur (Enter inserts a newline). Stores a plain string; the
 * serializer renders multi-line strings as YAML block scalars.
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

## Task 11: Pure Properties logic (`propertiesLogic.ts`)

**Files:**
- Create: `ui/src/properties/propertiesLogic.ts`
- Test: `ui/src/properties/propertiesLogic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/properties/propertiesLogic.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { PropertyType } from "./typeComments";
import { buildAnnotations, effectiveFormat, resolveType } from "./propertiesLogic";

describe("resolveType", () => {
  const map = new Map<string, PropertyType>([["price", { kind: "currency" }]]);

  it("uses the comment type when typed is enabled", () => {
    expect(resolveType(true, map, "price", 9.99)).toEqual({ kind: "currency" });
  });
  it("falls back to inference when no comment", () => {
    expect(resolveType(true, map, "count", 3)).toEqual({ kind: "number" });
  });
  it("ignores comments and infers when typed is disabled", () => {
    expect(resolveType(false, map, "price", 9.99)).toEqual({ kind: "number" });
  });
});

describe("effectiveFormat", () => {
  it("prefers the type's inline format, then the vault default", () => {
    expect(effectiveFormat({ kind: "date", format: "DD-MM-YY" }, "YYYY")).toBe(
      "DD-MM-YY",
    );
    expect(effectiveFormat({ kind: "date" }, "YYYY")).toBe("YYYY");
    expect(effectiveFormat({ kind: "date" }, undefined)).toBe("YYYY-MM-DD");
  });
});

describe("buildAnnotations", () => {
  const base = new Map<string, PropertyType>([
    ["a", { kind: "currency" }],
    ["b", { kind: "date" }],
  ]);

  it("copies unchanged when no override is given", () => {
    const out = buildAnnotations(base);
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });
  it("sets an overridden key", () => {
    const out = buildAnnotations(base, "a", { kind: "int" });
    expect(out.get("a")).toEqual({ kind: "int" });
    expect(out.get("b")).toEqual({ kind: "date" });
  });
  it("removes a key when override is null", () => {
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

import { effectiveDateFormat } from "./dateFormats";
import { inferType } from "./inferType";
import type { PropertyType } from "./typeComments";

/**
 * Resolve a property's type: the inline type comment wins when typed
 * properties are enabled, otherwise fall back to inference.
 */
export function resolveType(
  typedEnabled: boolean,
  typeMap: Map<string, PropertyType>,
  key: string,
  value: unknown,
): PropertyType {
  const explicit = typedEnabled ? typeMap.get(key) : undefined;
  return explicit ?? { kind: inferType(key, value) };
}

/** The effective date format for a resolved type given the vault default. */
export function effectiveFormat(
  type: PropertyType,
  vaultDefault: string | undefined,
): string {
  return effectiveDateFormat(type.format, vaultDefault);
}

/**
 * Produce the annotation map to serialize: a copy of `current` with an
 * optional single-key override. `null` removes the key (lossy-revert);
 * no override returns a plain copy (preserve comments on value edits).
 */
export function buildAnnotations(
  current: Map<string, PropertyType>,
  key?: string,
  type?: PropertyType | null,
): Map<string, PropertyType> {
  const next = new Map(current);
  if (key !== undefined) {
    if (type == null) next.delete(key);
    else next.set(key, type);
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
git commit -m "feat(properties): pure resolve/effective-format/annotate logic"
```

---

## Task 12: Wire `Properties.tsx` (nested menu incl. date formats, resolution, cells)

**Files:**
- Modify: `ui/src/Properties.tsx`

No unit test (Solid component, node-only test env). Logic lives in the tested helpers (Tasks 1–11); correctness is verified by `tsc`, `build`, and the preview workflow in Task 15.

- [ ] **Step 1: Update imports**

Add after the existing cell imports:

```tsx
import CurrencyCell from "./properties/CurrencyCell";
import DateTimeCell from "./properties/DateTimeCell";
import MultilineCell from "./properties/MultilineCell";
import { DATE_FORMAT_TOKENS, convertDate } from "./properties/dateFormats";
import { parseTypeComments, type PropertyType } from "./properties/typeComments";
import {
  buildAnnotations,
  effectiveFormat,
  resolveType,
} from "./properties/propertiesLogic";
import { coerceValue } from "./properties/coerce";
```

Remove the old `inferType` import line (resolution moves to `resolveType`); keep `type CellKind` imported from `./properties/inferType`. Keep the existing `coerceValue` import if already present (do not duplicate).

- [ ] **Step 2: Replace the flat `TYPE_OPTIONS` with a nested menu model**

Replace the `TYPE_OPTIONS` constant with:

```tsx
/** A leaf type the user can pick (kind + optional date format). */
interface TypeLeaf {
  type: PropertyType;
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
      { type: { kind: "string" }, label: "Plain" },
      { type: { kind: "multiline" }, label: "Multiline" },
    ],
  },
  {
    label: "Number",
    leaves: [
      { type: { kind: "int" }, label: "Integer" },
      { type: { kind: "float" }, label: "Decimal" },
      { type: { kind: "currency" }, label: "Currency (USD)" },
    ],
  },
  { label: "Checkbox", leaves: [{ type: { kind: "boolean" }, label: "Checkbox" }] },
  {
    label: "Date",
    leaves: [
      { type: { kind: "datetime" }, label: "Date & time" },
      ...DATE_FORMAT_TOKENS.map(
        (format): TypeLeaf => ({
          type: { kind: "date", format },
          label: `Date · ${format}`,
        }),
      ),
    ],
  },
  {
    label: "List",
    leaves: [
      { type: { kind: "list-of-strings" }, label: "List" },
      { type: { kind: "list-of-tags" }, label: "Tags" },
    ],
  },
];

/** Whether two property types are the same selection (kind + date format). */
function sameType(a: PropertyType, b: PropertyType): boolean {
  return a.kind === b.kind && (a.format ?? null) === (b.format ?? null);
}
```

- [ ] **Step 3: Extend props**

In `PropertiesProps`, add:

```tsx
  /** Whether typed properties are enabled (Settings ▸ Editor). */
  typedEnabled: boolean;
  /** Vault default date format (`properties.date_format_default`). */
  dateDefault: string;
```

In `RowProps`, replace `kind: CellKind;` with the resolved type + format and add the menu/submenu fields:

```tsx
  type: PropertyType;
  format: string;
  typedEnabled: boolean;
  openFamily: string | null;
  onOpenFamily: (label: string | null) => void;
```

And change `onChangeType` in `RowProps`:

```tsx
  onChangeType: (type: PropertyType) => void;
```

- [ ] **Step 4: Replace the row's cell rendering**

Replace the cell `<Show>` group with (note `props.kind` → `props.type.kind`):

```tsx
        <Show when={props.type.kind === "string"}>
          <StringCell
            value={String(props.value ?? "")}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "multiline"}>
          <MultilineCell
            value={String(props.value ?? "")}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "number" || props.type.kind === "float"}>
          <NumberCell
            value={typeof props.value === "number" ? props.value : 0}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "int"}>
          <NumberCell
            value={typeof props.value === "number" ? props.value : 0}
            integer
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "currency"}>
          <CurrencyCell
            value={typeof props.value === "number" ? props.value : 0}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "boolean"}>
          <BooleanCell
            value={props.value === true}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "date"}>
          <DateCell
            value={
              typeof props.value === "number"
                ? props.value
                : String(props.value ?? "")
            }
            format={props.format}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "datetime"}>
          <DateTimeCell
            value={String(props.value ?? "")}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "list-of-strings"}>
          <StringListCell
            value={Array.isArray(props.value) ? (props.value as string[]) : []}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "list-of-tags"}>
          <TagListCell
            value={Array.isArray(props.value) ? (props.value as string[]) : []}
            onCommit={(v) => props.onCommitValue(v)}
            {...(props.onNavigateTag
              ? { onNavigateTag: props.onNavigateTag }
              : {})}
          />
        </Show>
        <Show when={props.type.kind === "raw"}>
          <RawCell value={props.value} onOpenRaw={props.onOpenRaw} />
        </Show>
```

- [ ] **Step 5: Replace the type-menu chevron + dropdown with the gated nested menu**

Replace the entire third grid cell (the `<div style={{ position: "relative" }}>…</div>` with the `▾` button and `role="menu"` block) with:

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
                "min-width": "10rem",
                "max-height": "60vh",
                "overflow-y": "auto",
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
                          props.onChangeType(family.leaves[0]!.type);
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
                        color: family.leaves.some((l) =>
                          sameType(l.type, props.type),
                        )
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
                              onClick={() => props.onChangeType(leaf.type)}
                              style={{
                                "text-align": "left",
                                padding: "var(--space-1) var(--space-2)",
                                "font-family": "var(--font-body)",
                                "font-size": "var(--text-xs)",
                                color: sameType(leaf.type, props.type)
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

Remove the `overrides` signal and its reset line. Add an `openFamily` signal near the other transient signals and reset it in the `props.path` effect (alongside `setMenuKey(null)`):

```tsx
  const [openFamily, setOpenFamily] = createSignal<string | null>(null);
```
```tsx
        setOpenFamily(null);
```

Add the type map (recomputed each AST tick, like `modelable`):

```tsx
  // Inline type comments parsed from the live buffer. Recomputed each AST
  // tick so raw edits flow back in. Parsed even when the feature is off so
  // commits preserve existing comments.
  const typeMap = createMemo(() => {
    void props.frontmatter;
    return parseTypeComments(splitFrontmatter(props.getSource()).yaml ?? "");
  });
```

Replace `commit` to accept an annotation map (default preserves existing comments) and pass the vault date default:

```tsx
  const commit = (
    nextEntries: FrontmatterEntry[],
    types: Map<string, PropertyType> = typeMap(),
  ) => {
    const block = serializeFrontmatter(nextEntries, types, props.dateDefault);
    const source = props.getSource();
    const span = splitFrontmatter(source).span;
    if (span) props.applyEdit(span.start, span.end, block);
    else props.applyEdit(0, 0, block);
  };
```

Replace `changeType`, `revertLossy`, and `resolvedKind`:

```tsx
  const changeType = (key: string, type: PropertyType) => {
    const current = entryMap().get(key);
    // Date formats reformat the value; everything else uses coerceValue.
    const result =
      type.kind === "date"
        ? convertDate(current, effectiveFormat(type, props.dateDefault))
        : coerceValue(current, type.kind);
    updateMap(
      setLossy,
      lossy(),
      key,
      result.lossy ? { value: current } : undefined,
    );
    setMenuKey(null);
    setOpenFamily(null);
    commit(
      entries().map(
        ([k, v]): FrontmatterEntry => (k === key ? [k, result.value] : [k, v]),
      ),
      buildAnnotations(typeMap(), key, type),
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

  const resolvedType = (key: string): PropertyType =>
    resolveType(props.typedEnabled, typeMap(), key, entryMap().get(key));
```

(`commitValue`, `renameKey`, `addProperty` keep calling `commit(...)` with one argument — they implicitly preserve `typeMap()`.)

- [ ] **Step 7: Pass the new props into `PropertyRow`**

In the `<For each={keys()}>` body, replace `kind={resolvedKind(key)}` and add the new props:

```tsx
              type={resolvedType(key)}
              format={effectiveFormat(resolvedType(key), props.dateDefault)}
              typedEnabled={props.typedEnabled}
              openFamily={openFamily()}
              onOpenFamily={(label) => setOpenFamily(label)}
              onChangeType={(type) => changeType(key, type)}
```

(Remove the old `onChangeType={(kind) => changeType(key, kind)}` line.)

- [ ] **Step 8: Type-check + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: success. (If `inferType`/`CellKind` are reported unused, remove the unused import; `CellKind` may still be referenced in `RowProps` — leave it if so.)

- [ ] **Step 9: Run the full UI test suite (no regressions)**

Run: `cd ui && npx vitest run`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add ui/src/Properties.tsx
git commit -m "feat(properties): nested type submenu (date formats), comment resolution, typed cells"
```

---

## Task 13: Add the settings keys

**Files:**
- Modify: `ui/src/api/ipc.ts`

- [ ] **Step 1: Extend the `Setting` union**

In `ui/src/api/ipc.ts`, add two members after `plugins.dataview_enabled`:

```ts
  | { key: "plugins.dataview_enabled"; value: boolean }
  | { key: "properties.typed_enabled"; value: boolean }
  | { key: "properties.date_format_default"; value: string };
```

- [ ] **Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/ipc.ts
git commit -m "feat(settings): add properties.typed_enabled + date_format_default keys"
```

---

## Task 14: Settings ▸ Editor UI (toggle + default-format dropdown + docs) + wire `Properties`

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Add signals + setters (mirror `rawDefault`)**

Near the `rawDefault` signal (~line 195) add:

```tsx
  // Typed-properties feature flag + default date format, seeded on vault
  // open. Absent → enabled / "YYYY-MM-DD".
  const [typedProps, setTypedProps] = createSignal(true);
  const [dateDefault, setDateDefault] = createSignal("YYYY-MM-DD");
```

Add a `DEFAULT_DATE_FORMAT`/tokens import at the top of `App.tsx`:

```tsx
import { DATE_FORMAT_TOKENS } from "./properties/dateFormats";
```

Near `setRawDefaultValue` (~line 694) add:

```tsx
  /** Set the typed-properties flag (Settings ▸ Editor). */
  const setTypedPropsValue = (val: boolean) => {
    setTypedProps(val);
    const id = vaultId();
    if (id) {
      setSetting(id, "properties.typed_enabled", val).catch((e) => {
        console.error("persisting properties.typed_enabled failed", e);
      });
    }
  };

  /** Set the default date format (Settings ▸ Editor). */
  const setDateDefaultValue = (val: string) => {
    setDateDefault(val);
    const id = vaultId();
    if (id) {
      setSetting(id, "properties.date_format_default", val).catch((e) => {
        console.error("persisting properties.date_format_default failed", e);
      });
    }
  };
```

(Match whatever current-vault-id accessor `setRawDefaultValue` uses.)

- [ ] **Step 2: Hydrate on vault open**

After the `editor.raw_source_default` seed (~line 1168) add:

```tsx
      // Seed typed-properties flag + default date format (absent → on / ISO).
      try {
        const stored = await getSetting(resp.vault_id, "properties.typed_enabled");
        setTypedProps(stored ?? true);
      } catch (e) {
        console.error("loading properties.typed_enabled failed", e);
      }
      try {
        const stored = await getSetting(
          resp.vault_id,
          "properties.date_format_default",
        );
        setDateDefault(stored ?? "YYYY-MM-DD");
      } catch (e) {
        console.error("loading properties.date_format_default failed", e);
      }
```

- [ ] **Step 3: Add the Editor-tab rows + docs block**

In the `<Show when={settingsTab() === "editor"}>` block, after the existing raw-source `set-row` (before `</Show>`), add:

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
                <Show when={typedProps()}>
                  <div class="set-row">
                    <div>
                      <div class="set-row__lab">Default date format</div>
                      <div class="set-row__desc">
                        Applied to every date property; override per-property
                        from the type menu.
                      </div>
                    </div>
                    <select
                      value={dateDefault()}
                      onChange={(e) => setDateDefaultValue(e.currentTarget.value)}
                    >
                      <For each={DATE_FORMAT_TOKENS}>
                        {(token) => <option value={token}>{token}</option>}
                      </For>
                    </select>
                  </div>
                </Show>
                <div class="set-row__desc" style={{ "margin-top": "var(--space-2)" }}>
                  <p style={{ margin: "0 0 var(--space-1) 0" }}>
                    <strong>How it works.</strong> Pick a type from the{" "}
                    <code>▾</code> menu on any property row. The Properties
                    panel then shows the right editor — a <code>$</code> field
                    for currency, a date picker, and so on.
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
due: 17-06-26  # type:date:DD-MM-YY
---`}</pre>
                  <p style={{ margin: 0 }}>
                    A date using the default format needs no inline note; only a
                    different format is written. Turning this off leaves any
                    existing <code># type:</code> comments untouched.
                  </p>
                </div>
```

- [ ] **Step 4: Pass props to `Properties`**

At the `<Properties … />` usage (~line 1603), add:

```tsx
                    typedEnabled={typedProps()}
                    dateDefault={dateDefault()}
```

- [ ] **Step 5: Type-check + build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(settings): Editor-tab typed-properties toggle, default date format, docs"
```

---

## Task 15: Full verification (gates + preview smoke)

**Files:** none (verification only).

- [ ] **Step 1: Run every UI gate**

Run:
```bash
cd ui && npx tsc --noEmit && npx vitest run && npm run build
```
Expected: tsc clean; all vitest pass; build succeeds.

- [ ] **Step 2: Confirm Rust gates still green (untouched, sanity)**

Run (from repo root):
```bash
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check
```
Expected: green (no Rust files changed).

- [ ] **Step 3: Preview smoke (verification workflow)**

Start the dev server (`preview_start`), open a note, verify in the preview:
1. `▾` menu opens; Number → Integer / Decimal / Currency (USD); Date → Date & time + one entry per format.
2. **Currency (USD)** on a numeric property renders a `$`-formatted field; raw source shows `price: 9.99   # type:number/currency` (bare number kept).
3. **Date · DD-MM-YY** renders a validated text input; raw source shows `# type:date:DD-MM-YY` and the value in that format. Choosing **Date · YYYY-MM-DD** (the default) drops the inline param to bare `# type:date`.
4. **Date · YYYY** renders a year input and stores a bare number.
5. Switch documents and back — types + formats **persist**.
6. Settings ▸ Editor shows the **Typed properties** toggle, the **Default date format** dropdown, and the docs. Change the default and confirm default-format dates re-skin. Turn the feature **off**: the `▾` menu disappears, dates render via inference, but `# type:` comments remain and the panel is NOT read-only.

Capture a screenshot of the Properties panel showing a currency + a custom-format date as proof.

- [ ] **Step 4: Final commit (if preview-driven fixes were made)**

```bash
git add -A && git commit -m "fix(properties): preview-smoke adjustments"
```
(Skip if nothing changed.)

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** §4 grammar → Task 2; §4b date formats → Tasks 1, 2, 8, 12, 14; §5/§5.1 union + PropertyType → Task 2; §6 resolution → Tasks 11–12; §7.1 parse → Task 2; §7.2 serialize → Task 3; §7.3 guard → Task 3; §8 cells/menu → Tasks 6–10, 12; §8b settings+docs → Tasks 13–14; §10 tests → Tasks 1–5, 11; §11 gates → Task 15.
- **Off-behavior (§8b.4):** `typeMap` is parsed unconditionally and always passed to `serializeFrontmatter`, so comments are preserved when off; the menu (Task 12 Step 5) is gated behind `props.typedEnabled`; resolution gating is in `resolveType` (Task 11).
- **No comment spray:** `changeType` only annotates the picked key (`buildAnnotations`); value/rename/add commits pass `typeMap()` unchanged.
- **Default-format omission:** `typeToToken` (Task 2) drops the date param when it equals `dateDefault`, so default-format dates write bare `# type:date`.
- **Type consistency:** `PropertyType` is used uniformly by `parseTypeComments`, `typeToToken`, `serializeFrontmatter`, `resolveType`, `buildAnnotations`, and `Properties`' `typeMap`/`changeType`. `DateCell` takes `value: string | number` + `format`. `sameType` compares kind + format for menu highlighting.
- **Task 8 ↔ 12 ordering:** `DateCell`'s new signature is consumed in Task 12; run Task 12 right after Task 8 so `tsc` is green end-to-end.
```
