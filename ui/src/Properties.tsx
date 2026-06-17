import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onMount,
  Show,
  type Component,
} from "solid-js";

import type { Frontmatter, FrontmatterEntry } from "./ast/types";
import { splitFrontmatter } from "./ast/frontmatter";
import { coerceValue } from "./properties/coerce";
import {
  hasUnmodelableYaml,
  serializeFrontmatter,
} from "./properties/serializeFrontmatter";
import StringCell from "./properties/StringCell";
import NumberCell from "./properties/NumberCell";
import BooleanCell from "./properties/BooleanCell";
import DateCell from "./properties/DateCell";
import StringListCell from "./properties/StringListCell";
import RawCell from "./properties/RawCell";
import CurrencyCell from "./properties/CurrencyCell";
import EnumCell from "./properties/EnumCell";
import { DATE_FORMAT_TOKENS, convertDate } from "./properties/dateFormats";
import {
  parseTypeComments,
  type PropertyType,
} from "./properties/typeComments";
import {
  buildAnnotations,
  effectiveFormat,
  resolveType,
} from "./properties/propertiesLogic";
import { miniButtonStyle } from "./properties/styles";

/**
 * L2 Session F — inline Properties UI (spec §2.4).
 *
 * Renders one editable row per top-level frontmatter key above the
 * editor. It is *not* a separate write path (spec §5 #1): every commit
 * reserializes the whole frontmatter block and splices it into the
 * source via `applyEdit` (a surgical `EditorView` range replace), which
 * the editor reports as an ordinary `docChanged` — Session A's autosave
 * then persists it.
 *
 * Rows rebuild from `frontmatter` on each debounced `onAstChange` tick,
 * so raw-mode frontmatter edits flow back in. Individual cells hold a
 * focus-guarded draft so a refresh never clobbers an in-progress edit.
 *
 * Round-trip safety: when the frontmatter uses YAML the entries-based
 * serializer cannot reproduce (comments, anchors, aliases), the panel
 * degrades to read-only rather than risk destroying content.
 */

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
  { label: "Text", leaves: [{ type: { kind: "string" }, label: "Text" }] },
  { label: "Integer", leaves: [{ type: { kind: "int" }, label: "Integer" }] },
  {
    label: "Float",
    leaves: [
      { type: { kind: "float" }, label: "Decimal" },
      { type: { kind: "currency", currency: "usd" }, label: "Currency (USD)" },
      { type: { kind: "currency", currency: "nis" }, label: "Currency (NIS)" },
      { type: { kind: "currency", currency: "eur" }, label: "Currency (EUR)" },
    ],
  },
  { label: "Boolean", leaves: [{ type: { kind: "boolean" }, label: "Boolean" }] },
  {
    label: "Enum",
    leaves: [{ type: { kind: "enum", values: [] }, label: "Enum (set of values)" }],
  },
  {
    label: "Date",
    leaves: DATE_FORMAT_TOKENS.map(
      (format): TypeLeaf => ({
        type: { kind: "date", format },
        label: `Date · ${format}`,
      }),
    ),
  },
  { label: "List", leaves: [{ type: { kind: "list-of-strings" }, label: "List" }] },
];

/**
 * Whether a menu leaf matches the active type, for highlighting. Compares
 * kind, date format, and currency code; enum values are ignored (the menu
 * leaf is always the empty `enum()`).
 */
function sameType(a: PropertyType, b: PropertyType): boolean {
  return (
    a.kind === b.kind &&
    (a.format ?? null) === (b.format ?? null) &&
    (a.currency ?? null) === (b.currency ?? null)
  );
}

export interface PropertiesProps {
  /** Parsed frontmatter from the latest `onAstChange` tick. */
  frontmatter: Frontmatter | null;
  /** Identifies the open document; resets transient per-doc state. */
  path: string;
  /** Accessor for the live editor buffer (commit splices into it). */
  getSource: () => string;
  /** Apply a surgical range replacement to the editor buffer. */
  applyEdit: (from: number, to: number, text: string) => void;
  /** Flip the editor into raw mode (the RawCell "Open as raw" link). */
  onOpenRaw: () => void;
  /**
   * Optional — when set, clicking a tag chip opens that tag's virtual
   * page (L3 Session E). Forwarded to `TagListCell`.
   */
  onNavigateTag?: (tagPath: string) => void;
  /** Whether typed properties are enabled (Settings ▸ Editor). */
  typedEnabled: boolean;
  /** Vault default date format (`properties.date_format_default`). */
  dateDefault: string;
}

interface RowProps {
  keyName: string;
  value: unknown;
  type: PropertyType;
  format: string;
  lossyOriginal: { value: unknown } | undefined;
  menuOpen: boolean;
  autoFocus: boolean;
  typedEnabled: boolean;
  openFamily: string | null;
  onOpenFamily: (label: string | null) => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onChangeType: (type: PropertyType) => void;
  onCommitValue: (value: unknown) => void;
  onSetEnumValues: (values: string[]) => void;
  onRename: (next: string) => boolean;
  onRevertLossy: () => void;
  onOpenRaw: () => void;
  onNavigateTag?: (tagPath: string) => void;
}

/** A single key/value frontmatter row. */
const PropertyRow: Component<RowProps> = (props) => {
  const [keyDraft, setKeyDraft] = createSignal(props.keyName);
  const [keyFocused, setKeyFocused] = createSignal(false);

  // Adopt external key changes only — must NOT re-run when keyFocused
  // alone flips, or blurring after a rename would revert the draft to
  // props.keyName before the row unmounts (150ms AST-tick window).
  createEffect(
    on(
      () => props.keyName,
      (k) => {
        if (!keyFocused()) setKeyDraft(k);
      },
    ),
  );

  let keyInput!: HTMLInputElement;
  onMount(() => {
    if (props.autoFocus) {
      keyInput.focus();
      keyInput.select();
    }
  });

  const commitRename = () => {
    if (keyDraft() === props.keyName) return;
    const ok = props.onRename(keyDraft());
    if (!ok) setKeyDraft(props.keyName);
  };

  return (
    <div
      style={{
        display: "grid",
        "grid-template-columns": "minmax(6rem, 10rem) 1fr auto",
        "align-items": "center",
        gap: "var(--space-3)",
        padding: "var(--space-1) 0",
        "border-bottom": "1px solid var(--c-border-subtle)",
      }}
    >
      <input
        ref={keyInput}
        type="text"
        value={keyDraft()}
        onInput={(e) => setKeyDraft(e.currentTarget.value)}
        onFocus={() => setKeyFocused(true)}
        onBlur={() => {
          setKeyFocused(false);
          commitRename();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        aria-label={`Property name: ${props.keyName}`}
        style={{
          width: "100%",
          "box-sizing": "border-box",
          padding: "var(--space-1) var(--space-2)",
          "font-family": "var(--font-mono)",
          "font-size": "var(--text-xs)",
          color: "var(--c-fg-secondary)",
          background: "transparent",
          border: `1px solid ${keyFocused() ? "var(--c-accent)" : "transparent"}`,
          "border-radius": "var(--radius-sm)",
          outline: "none",
          transition: "border-color var(--transition-fast)",
        }}
      />

      <div style={{ "min-width": 0 }}>
        <Show when={props.type.kind === "string"}>
          <StringCell
            value={String(props.value ?? "")}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "float"}>
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
            currency={props.type.currency ?? "usd"}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "boolean"}>
          <BooleanCell
            value={props.value === true}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.type.kind === "enum"}>
          <EnumCell
            value={props.value}
            values={props.type.values ?? []}
            onCommit={(v) => props.onCommitValue(v)}
            onSetValues={(vals) => props.onSetEnumValues(vals)}
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
        <Show when={props.type.kind === "list-of-strings"}>
          <StringListCell
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

        <Show when={props.lossyOriginal !== undefined}>
          <button
            type="button"
            onClick={() => props.onRevertLossy()}
            title="Revert to the value before the type change"
            style={{
              "margin-top": "var(--space-1)",
              padding: "0 var(--space-2)",
              "font-family": "var(--font-body)",
              "font-size": "var(--text-xs)",
              color: "var(--c-warning)",
              background: "transparent",
              border: "1px solid var(--c-warning)",
              "border-radius": "var(--radius-full)",
              cursor: "pointer",
            }}
          >
            ⚠ was {JSON.stringify(props.lossyOriginal?.value)} — revert
          </button>
        </Show>
      </div>

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
    </div>
  );
};

const Properties: Component<PropertiesProps> = (props) => {
  // Per-doc transient state. The persisted type registry lives in the
  // inline comments (`typeMap`); `lossy` holds the pre-coercion value for
  // rows whose last type change lost information. Reset when the doc
  // changes. `openFamily` tracks the expanded type-menu submenu.
  const [lossy, setLossy] = createSignal<Map<string, { value: unknown }>>(
    new Map(),
  );
  const [menuKey, setMenuKey] = createSignal<string | null>(null);
  const [openFamily, setOpenFamily] = createSignal<string | null>(null);
  const [pendingFocusKey, setPendingFocusKey] = createSignal<string | null>(
    null,
  );

  createEffect(
    on(
      () => props.path,
      () => {
        setLossy(new Map());
        setMenuKey(null);
        setOpenFamily(null);
        setPendingFocusKey(null);
      },
      { defer: true },
    ),
  );

  const entries = (): FrontmatterEntry[] => props.frontmatter?.entries ?? [];
  const keys = createMemo(() => entries().map(([k]) => k));
  const entryMap = createMemo(() => new Map(entries()));

  // Inline type comments parsed from the live buffer. Recomputed each AST
  // tick so raw edits flow back in. Parsed even when the feature is off so
  // commits preserve existing comments.
  const typeMap = createMemo(() => {
    void props.frontmatter;
    return parseTypeComments(splitFrontmatter(props.getSource()).yaml ?? "");
  });

  // Modelable when there is no frontmatter (we can add it) or the
  // existing block has no comments/anchors/aliases (spec §2.4 / (a)).
  const modelable = createMemo(() => {
    void props.frontmatter;
    const split = splitFrontmatter(props.getSource());
    return split.yaml === null || !hasUnmodelableYaml(split.yaml);
  });

  /** Reserialize `nextEntries` (+ type annotations) and splice in. */
  const commit = (
    nextEntries: FrontmatterEntry[],
    types: Map<string, PropertyType> = typeMap(),
  ) => {
    const block = serializeFrontmatter(nextEntries, types, props.dateDefault);
    const source = props.getSource();
    const span = splitFrontmatter(source).span;
    if (span) {
      props.applyEdit(span.start, span.end, block);
    } else {
      props.applyEdit(0, 0, block);
    }
  };

  const updateMap = <V,>(
    setter: (m: Map<string, V>) => void,
    current: Map<string, V>,
    key: string,
    value: V | undefined,
  ) => {
    const next = new Map(current);
    if (value === undefined) next.delete(key);
    else next.set(key, value);
    setter(next);
  };

  const commitValue = (key: string, value: unknown) => {
    updateMap(setLossy, lossy(), key, undefined);
    commit(
      entries().map(
        ([k, v]): FrontmatterEntry => (k === key ? [k, value] : [k, v]),
      ),
    );
  };

  const renameKey = (oldKey: string, newKey: string): boolean => {
    const trimmed = newKey.trim();
    if (trimmed === "" || trimmed === oldKey) return false;
    if (keys().includes(trimmed)) return false;
    commit(
      entries().map(
        ([k, v]): FrontmatterEntry => (k === oldKey ? [trimmed, v] : [k, v]),
      ),
    );
    return true;
  };

  const changeType = (key: string, type: PropertyType) => {
    const current = entryMap().get(key);
    // Dates reformat the value; enum keeps the value (the set is defined
    // next, via the cell); everything else uses coerceValue.
    const result =
      type.kind === "date"
        ? convertDate(current, effectiveFormat(type, props.dateDefault))
        : type.kind === "enum"
          ? { value: current, lossy: false }
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

  /**
   * Redefine an enum property's allowed values (from the cell's values
   * editor). Rewrites the type comment; if the current value is no longer
   * in the set, it's snapped to the first value (or cleared when empty).
   */
  const setEnumValues = (key: string, values: string[]) => {
    const current = entryMap().get(key);
    const inSet = values.includes(String(current));
    const nextValue = inSet
      ? current
      : values.length > 0
        ? (Number.isFinite(Number(values[0])) ? Number(values[0]) : values[0])
        : current;
    commit(
      entries().map(
        ([k, v]): FrontmatterEntry => (k === key ? [k, nextValue] : [k, v]),
      ),
      buildAnnotations(typeMap(), key, { kind: "enum", values }),
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

  const addProperty = () => {
    let key = "property";
    let n = 2;
    while (keys().includes(key)) key = `property-${n++}`;
    setPendingFocusKey(key);
    commit([...entries(), [key, ""]]);
  };

  const resolvedType = (key: string): PropertyType =>
    resolveType(props.typedEnabled, typeMap(), key, entryMap().get(key));

  return (
    <section
      aria-label="Frontmatter properties"
      style={{
        display: "flex",
        "flex-direction": "column",
        padding: "var(--space-3)",
        background: "var(--c-bg-secondary)",
        border: "1px solid var(--c-border-subtle)",
        "border-radius": "var(--radius-md)",
      }}
    >
      <Show
        when={modelable()}
        fallback={
          <div
            style={{
              display: "flex",
              "flex-direction": "column",
              gap: "var(--space-2)",
            }}
          >
            <p
              role="alert"
              style={{
                margin: 0,
                "font-size": "var(--text-xs)",
                color: "var(--c-warning)",
              }}
            >
              Cubical can't safely edit this frontmatter (it uses comments,
              anchors, or aliases).
            </p>
            <pre
              style={{
                margin: 0,
                padding: "var(--space-2)",
                "font-family": "var(--font-mono)",
                "font-size": "var(--text-xs)",
                color: "var(--c-fg-secondary)",
                background: "var(--c-bg-primary)",
                border: "1px solid var(--c-border-subtle)",
                "border-radius": "var(--radius-sm)",
                "white-space": "pre-wrap",
                "overflow-x": "auto",
              }}
            >
              {splitFrontmatter(props.getSource()).yaml ?? ""}
            </pre>
            <button
              type="button"
              onClick={() => props.onOpenRaw()}
              style={{
                "align-self": "flex-start",
                padding: "0",
                "font-family": "var(--font-body)",
                "font-size": "var(--text-xs)",
                color: "var(--c-accent)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                "text-decoration": "underline",
              }}
            >
              Open as raw
            </button>
          </div>
        }
      >
        <For each={keys()}>
          {(key) => (
            <PropertyRow
              keyName={key}
              value={entryMap().get(key)}
              type={resolvedType(key)}
              format={effectiveFormat(resolvedType(key), props.dateDefault)}
              lossyOriginal={lossy().get(key)}
              menuOpen={menuKey() === key}
              autoFocus={pendingFocusKey() === key}
              typedEnabled={props.typedEnabled}
              openFamily={openFamily()}
              onOpenFamily={(label) => setOpenFamily(label)}
              onToggleMenu={() => setMenuKey(menuKey() === key ? null : key)}
              onCloseMenu={() => {
                if (menuKey() === key) setMenuKey(null);
              }}
              onChangeType={(type) => changeType(key, type)}
              onCommitValue={(v) => commitValue(key, v)}
              onSetEnumValues={(vals) => setEnumValues(key, vals)}
              onRename={(next) => renameKey(key, next)}
              onRevertLossy={() => revertLossy(key)}
              onOpenRaw={() => props.onOpenRaw()}
              {...(props.onNavigateTag
                ? { onNavigateTag: props.onNavigateTag }
                : {})}
            />
          )}
        </For>
        <button
          type="button"
          onClick={addProperty}
          style={{
            "align-self": "flex-start",
            "margin-top": "var(--space-2)",
            padding: "var(--space-1) var(--space-2)",
            "font-family": "var(--font-body)",
            "font-size": "var(--text-xs)",
            color: "var(--c-fg-muted)",
            background: "transparent",
            border: "1px dashed var(--c-border-subtle)",
            "border-radius": "var(--radius-sm)",
            cursor: "pointer",
          }}
        >
          + Add property
        </button>
      </Show>
    </section>
  );
};

export default Properties;
