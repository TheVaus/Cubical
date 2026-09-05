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

import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";
import Link from "@ds/components/forms/Link/Link";
import TextInput from "@ds/components/forms/TextInput/TextInput";
import Icon from "@ds/components/graphics/Icon/Icon";

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
  effectiveCurrency,
  effectiveFormat,
  resolveType,
} from "./properties/propertiesLogic";

interface TypeLeaf {
  type: PropertyType;
  label: string;
}
interface TypeFamily {
  label: string;
  leaves: TypeLeaf[];
}

function buildTypeMenu(dateDefault: string): TypeFamily[] {
  return [
    { label: "Text", leaves: [{ type: { kind: "string" }, label: "Text" }] },
    { label: "Integer", leaves: [{ type: { kind: "int" }, label: "Integer" }] },
    {
      label: "Float",
      leaves: [
        { type: { kind: "float" }, label: "Decimal" },
        {
          type: { kind: "currency", currency: "usd" },
          label: "Currency (USD)",
        },
        {
          type: { kind: "currency", currency: "nis" },
          label: "Currency (NIS)",
        },
        {
          type: { kind: "currency", currency: "eur" },
          label: "Currency (EUR)",
        },
      ],
    },
    {
      label: "Boolean",
      leaves: [{ type: { kind: "boolean" }, label: "Boolean" }],
    },
    {
      label: "Enum",
      leaves: [
        { type: { kind: "enum", values: [] }, label: "Enum (set of values)" },
      ],
    },
    {
      label: "Date",
      leaves: [
        {
          type: { kind: "date", format: dateDefault },
          label: `Default (${dateDefault})`,
        },
        ...DATE_FORMAT_TOKENS.map((format): TypeLeaf => ({
          type: { kind: "date", format },
          label: `Date · ${format}`,
        })),
      ],
    },
    {
      label: "List",
      leaves: [{ type: { kind: "list-of-strings" }, label: "List" }],
    },
  ];
}

function sameType(a: PropertyType, b: PropertyType): boolean {
  return (
    a.kind === b.kind &&
    (a.format ?? null) === (b.format ?? null) &&
    (a.currency ?? null) === (b.currency ?? null)
  );
}

export interface PropertiesProps {
  frontmatter: Frontmatter | null;
  path: string;
  getSource: () => string;
  applyEdit: (from: number, to: number, text: string) => void;
  onOpenRaw: () => void;
  onNavigateTag?: (tagPath: string) => void;
  typedEnabled: boolean;
  dateDefault: string;
  currencyDefault: string;
  tagsKeyAsTags: boolean;
}

interface RowProps {
  keyName: string;
  value: unknown;
  type: PropertyType;
  format: string;
  currency: string;
  menu: TypeFamily[];
  tagsKey: boolean;
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

const PropertyRow: Component<RowProps> = (props) => {
  const [keyDraft, setKeyDraft] = createSignal(props.keyName);
  const [keyFocused, setKeyFocused] = createSignal(false);

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

  const leafActive = (leafType: PropertyType): boolean => {
    if (leafType.kind === "currency" && props.type.kind === "currency") {
      return leafType.currency === props.currency;
    }
    return sameType(leafType, props.type);
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
      <TextInput
        ref={(el) => (keyInput = el)}
        size="sm"
        value={keyDraft()}
        onInput={setKeyDraft}
        onFocus={() => setKeyFocused(true)}
        onBlur={() => {
          setKeyFocused(false);
          commitRename();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") keyInput.blur();
        }}
        ariaLabel={`Property name: ${props.keyName}`}
        style={{
          "font-family": "var(--font-mono)",
          "font-size": "var(--text-xs)",
          color: "var(--c-fg-secondary)",
          background: "transparent",
          border: `1px solid ${keyFocused() ? "var(--c-accent)" : "transparent"}`,
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
            currency={props.currency}
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
            allTags={props.tagsKey}
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => props.onRevertLossy()}
            title="Revert to the value before the type change"
            style={{
              "margin-top": "var(--space-1)",
              padding: "0 var(--space-2)",
              color: "var(--c-warning)",
              "border-color": "var(--c-warning)",
              "border-radius": "var(--radius-full)",
            }}
          >
            <Icon name="warning" size={14} /> was{" "}
            {JSON.stringify(props.lossyOriginal?.value)} — revert
          </Button>
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
          <IconButton
            label={`Change type of ${props.keyName}`}
            size="sm"
            ariaHaspopup="menu"
            ariaExpanded={props.menuOpen}
            style={{ "font-size": "var(--text-sm)" }}
            onClick={() => props.onToggleMenu()}
          >
            <Icon name="chevron-down" size={14} />
          </IconButton>
          <Show when={props.menuOpen}>
            <div
              role="menu"
              data-overlay="menu"
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
              <For each={props.menu}>
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
                        color: family.leaves.some((l) => leafActive(l.type))
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
                          <Icon
                            name={
                              props.openFamily === family.label
                                ? "chevron-down"
                                : "chevron-right"
                            }
                            size={14}
                          />
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
                                color: leafActive(leaf.type)
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

  const typeMap = createMemo(() => {
    void props.frontmatter;
    return parseTypeComments(splitFrontmatter(props.getSource()).yaml ?? "");
  });

  const menu = createMemo(() => buildTypeMenu(props.dateDefault));

  const modelable = createMemo(() => {
    void props.frontmatter;
    const split = splitFrontmatter(props.getSource());
    return split.yaml === null || !hasUnmodelableYaml(split.yaml);
  });

  const commit = (
    nextEntries: FrontmatterEntry[],
    types: Map<string, PropertyType> = typeMap(),
  ) => {
    const source = props.getSource();
    const split = splitFrontmatter(source);
    const block = serializeFrontmatter(
      nextEntries,
      types,
      props.currencyDefault,
      split.yaml ?? undefined,
    );
    const span = split.span;
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
      entries().map(([k, v]): FrontmatterEntry =>
        k === key ? [k, value] : [k, v],
      ),
    );
  };

  const renameKey = (oldKey: string, newKey: string): boolean => {
    const trimmed = newKey.trim();
    if (trimmed === "" || trimmed === oldKey) return false;
    if (keys().includes(trimmed)) return false;
    commit(
      entries().map(([k, v]): FrontmatterEntry =>
        k === oldKey ? [trimmed, v] : [k, v],
      ),
    );
    return true;
  };

  const changeType = (key: string, type: PropertyType) => {
    const current = entryMap().get(key);
    const result =
      type.kind === "date"
        ? convertDate(current, effectiveFormat(type))
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
      entries().map(([k, v]): FrontmatterEntry =>
        k === key ? [k, result.value] : [k, v],
      ),
      buildAnnotations(typeMap(), key, type),
    );
  };

  const setEnumValues = (key: string, values: string[]) => {
    const current = entryMap().get(key);
    const inSet = values.includes(String(current));
    const nextValue = inSet
      ? current
      : values.length > 0
        ? Number.isFinite(Number(values[0]))
          ? Number(values[0])
          : values[0]
        : current;
    commit(
      entries().map(([k, v]): FrontmatterEntry =>
        k === key ? [k, nextValue] : [k, v],
      ),
      buildAnnotations(typeMap(), key, { kind: "enum", values }),
    );
  };

  const revertLossy = (key: string) => {
    const entry = lossy().get(key);
    if (!entry) return;
    updateMap(setLossy, lossy(), key, undefined);
    commit(
      entries().map(([k, v]): FrontmatterEntry =>
        k === key ? [k, entry.value] : [k, v],
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

  const hasContent = createMemo(() => !modelable() || keys().length > 0);

  return (
    <Show when={hasContent()}>
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
                Cubical can't safely edit this frontmatter (it uses anchors or
                aliases).
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
              <Link
                size="xs"
                onClick={() => props.onOpenRaw()}
                style={{ "align-self": "flex-start" }}
              >
                Open as raw
              </Link>
            </div>
          }
        >
          <For each={keys()}>
            {(key) => (
              <PropertyRow
                keyName={key}
                value={entryMap().get(key)}
                type={resolvedType(key)}
                format={effectiveFormat(resolvedType(key))}
                currency={effectiveCurrency(
                  resolvedType(key),
                  props.currencyDefault,
                )}
                menu={menu()}
                tagsKey={props.tagsKeyAsTags && key === "tags"}
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
          <Button
            variant="secondary"
            size="sm"
            onClick={addProperty}
            style={{
              "align-self": "flex-start",
              "margin-top": "var(--space-2)",
              color: "var(--c-fg-muted)",
              "border-style": "dashed",
              "border-color": "var(--c-border-subtle)",
            }}
          >
            + Add property
          </Button>
        </Show>
      </section>
    </Show>
  );
};

export default Properties;
