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
import { inferType, type CellKind } from "./properties/inferType";
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
import TagListCell from "./properties/TagListCell";
import RawCell from "./properties/RawCell";
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

/** The user-pickable cell kinds, in type-menu order. */
const TYPE_OPTIONS: { kind: CellKind; label: string }[] = [
  { kind: "string", label: "Text" },
  { kind: "number", label: "Number" },
  { kind: "boolean", label: "Boolean" },
  { kind: "date", label: "Date" },
  { kind: "list-of-strings", label: "List" },
  { kind: "list-of-tags", label: "Tags" },
];

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
}

interface RowProps {
  keyName: string;
  value: unknown;
  kind: CellKind;
  lossyOriginal: { value: unknown } | undefined;
  menuOpen: boolean;
  autoFocus: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onChangeType: (kind: CellKind) => void;
  onCommitValue: (value: unknown) => void;
  onRename: (next: string) => boolean;
  onRevertLossy: () => void;
  onOpenRaw: () => void;
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
        <Show when={props.kind === "string"}>
          <StringCell
            value={String(props.value ?? "")}
            onCommit={(v) => props.onCommitValue(v)}
          />
        </Show>
        <Show when={props.kind === "number"}>
          <NumberCell
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
          />
        </Show>
        <Show when={props.kind === "raw"}>
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

      <div
        style={{ position: "relative" }}
        onFocusOut={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            props.onCloseMenu();
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
              "min-width": "8rem",
              padding: "var(--space-1)",
              background: "var(--c-bg-primary)",
              border: "1px solid var(--c-border-subtle)",
              "border-radius": "var(--radius-md)",
              "box-shadow": "var(--shadow-md)",
            }}
          >
            <For each={TYPE_OPTIONS}>
              {(opt) => (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => props.onChangeType(opt.kind)}
                  style={{
                    "text-align": "left",
                    padding: "var(--space-1) var(--space-2)",
                    "font-family": "var(--font-body)",
                    "font-size": "var(--text-xs)",
                    color:
                      opt.kind === props.kind
                        ? "var(--c-accent)"
                        : "var(--c-fg-primary)",
                    background: "transparent",
                    border: "none",
                    "border-radius": "var(--radius-sm)",
                    cursor: "pointer",
                  }}
                >
                  {opt.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

const Properties: Component<PropertiesProps> = (props) => {
  // Per-doc transient state. `overrides` holds user-chosen cell kinds;
  // `lossy` holds the pre-coercion value for rows whose last type
  // change lost information. Both reset when the document changes.
  const [overrides, setOverrides] = createSignal<Map<string, CellKind>>(
    new Map(),
  );
  const [lossy, setLossy] = createSignal<Map<string, { value: unknown }>>(
    new Map(),
  );
  const [menuKey, setMenuKey] = createSignal<string | null>(null);
  const [pendingFocusKey, setPendingFocusKey] = createSignal<string | null>(
    null,
  );

  createEffect(
    on(
      () => props.path,
      () => {
        setOverrides(new Map());
        setLossy(new Map());
        setMenuKey(null);
        setPendingFocusKey(null);
      },
      { defer: true },
    ),
  );

  const entries = (): FrontmatterEntry[] => props.frontmatter?.entries ?? [];
  const keys = createMemo(() => entries().map(([k]) => k));
  const entryMap = createMemo(() => new Map(entries()));

  // Modelable when there is no frontmatter (we can add it) or the
  // existing block has no comments/anchors/aliases (spec §2.4 / (a)).
  const modelable = createMemo(() => {
    void props.frontmatter;
    const split = splitFrontmatter(props.getSource());
    return split.yaml === null || !hasUnmodelableYaml(split.yaml);
  });

  /** Reserialize `nextEntries` and splice the block into the buffer. */
  const commit = (nextEntries: FrontmatterEntry[]) => {
    const block = serializeFrontmatter(nextEntries);
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

  const changeType = (key: string, kind: CellKind) => {
    const current = entryMap().get(key);
    const { value, lossy: isLossy } = coerceValue(current, kind);
    updateMap(setOverrides, overrides(), key, kind);
    updateMap(setLossy, lossy(), key, isLossy ? { value: current } : undefined);
    setMenuKey(null);
    commit(
      entries().map(
        ([k, v]): FrontmatterEntry => (k === key ? [k, value] : [k, v]),
      ),
    );
  };

  const revertLossy = (key: string) => {
    const entry = lossy().get(key);
    if (!entry) return;
    updateMap(setOverrides, overrides(), key, undefined);
    updateMap(setLossy, lossy(), key, undefined);
    commit(
      entries().map(
        ([k, v]): FrontmatterEntry => (k === key ? [k, entry.value] : [k, v]),
      ),
    );
  };

  const addProperty = () => {
    let key = "property";
    let n = 2;
    while (keys().includes(key)) key = `property-${n++}`;
    setPendingFocusKey(key);
    commit([...entries(), [key, ""]]);
  };

  const resolvedKind = (key: string): CellKind =>
    overrides().get(key) ?? inferType(key, entryMap().get(key));

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
              kind={resolvedKind(key)}
              lossyOriginal={lossy().get(key)}
              menuOpen={menuKey() === key}
              autoFocus={pendingFocusKey() === key}
              onToggleMenu={() => setMenuKey(menuKey() === key ? null : key)}
              onCloseMenu={() => {
                if (menuKey() === key) setMenuKey(null);
              }}
              onChangeType={(kind) => changeType(key, kind)}
              onCommitValue={(v) => commitValue(key, v)}
              onRename={(next) => renameKey(key, next)}
              onRevertLossy={() => revertLossy(key)}
              onOpenRaw={() => props.onOpenRaw()}
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
