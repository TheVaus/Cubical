import { createEffect, on, onCleanup, onMount, type Component } from "solid-js";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";

import { normalize } from "./ast/normalize";
import { scanWikilinks } from "./ast/wikilink";
import type { CanonicalDocument } from "./ast/types";
import {
  livePreviewDecorations,
  wikilinkResolverFacet,
  wikilinkResolverUpdated,
  type WikiLinkResolverFacetValue,
} from "./editor/decorations";
import { wikilinkExtension } from "./editor/wikilink";
import { handleWikiLinkClick } from "./editor/wikilinkClick";
import type { WikiLinkResolver } from "./editor/wikilinkResolver";
import { buildCmTheme } from "./editor/cm-theme";
import type { ResolvedAnchor } from "./api/ipc";
import type { ResolvedTheme } from "./styles/theme";

/**
 * Holds the Live Preview decoration extension. L2 Session E (raw-source
 * toggle) reconfigures this compartment to a no-op extension (`[]`) to
 * reveal the raw markdown; Lezer parsing keeps running either way. This
 * is the seam — Session B only installs the compartment, it does not
 * build the toggle.
 */
const decorationCompartment = new Compartment();

/**
 * Holds the editor-chrome CM6 theme (L2 Session D). Rebuilt from the
 * design tokens and reconfigured whenever the resolved theme flips, so
 * the editor switches light/dark in lockstep with the surrounding UI.
 * Coexists with `decorationCompartment` — the two are independent.
 */
const themeCompartment = new Compartment();

/**
 * Holds the per-editor wiki-link resolver supplied to extensions via
 * {@link wikilinkResolverFacet}. Reconfigured whenever the parent's
 * `wikilinkResolver` prop changes (i.e. a different vault is open).
 */
const wikilinkResolverCompartment = new Compartment();

/** Translate the `WikiLinkResolver` object into the slimmer facet shape. */
const facetValueFor = (
  resolver: WikiLinkResolver | null | undefined,
): WikiLinkResolverFacetValue | null =>
  resolver
    ? {
        get: (t) => resolver.get(t),
        fetch: (t) => resolver.fetch(t),
      }
    : null;

/**
 * CodeMirror 6 markdown editor surface.
 *
 * Owns its own DOM and `EditorView` — Solid stays out of it so the
 * webview's main-thread Lane 1 contract holds. The component exposes:
 *
 * - `onAstChange` — the freshly-normalized canonical AST, debounced
 *   150ms (downstream consumers like the L1 footer / the future L2
 *   Properties UI).
 * - `onContentChange` — raw doc text on every `docChanged` update. The
 *   autosave timer (300ms) lives in the parent so blur / file-change
 *   flushes can coordinate with the buffer the user is *about to*
 *   leave. The Editor is too local to know when those things happen.
 * - `onBlur` — fires when the CM6 view loses focus, so the parent can
 *   force-flush a pending autosave (L2 spec §2.1).
 *
 * `ref(api)` exposes imperative handles the parent needs:
 * - `getContent()` — current doc text, useful when flushing on
 *   file-change before reading the new file.
 * - `replaceContent(next)` — drop in new bytes (used by the conflict
 *   banner's "Reload from disk" action).
 * - `replaceRange(from, to, text)` — surgical range replace (used by
 *   the L2 Session F Properties UI to splice a reserialized frontmatter
 *   block in without moving the body cursor). The dispatch surfaces as
 *   an ordinary `docChanged`, so Session A's autosave persists it.
 */
export interface EditorApi {
  getContent: () => string;
  replaceContent: (next: string) => void;
  replaceRange: (from: number, to: number, text: string) => void;
  /**
   * Scroll the viewport to the first heading whose plain-text content
   * matches `value` (trimmed). No-op when not found. Used by the
   * wiki-link click handler after navigating with a `Heading{value}`
   * anchor (L3 Session B, spec §2.2).
   */
  scrollToHeading: (value: string) => void;
}

export interface EditorProps {
  /** Initial document content; replacing it via prop swaps the doc. */
  value: string;
  /**
   * The resolved theme (`light` / `dark`). Changing it rebuilds the
   * CM6 chrome theme from the now-current design tokens. The parent
   * must write `<html data-theme>` *before* updating this prop so the
   * rebuilt theme reads the correct token values.
   */
  resolvedTheme: ResolvedTheme;
  /**
   * When `true`, the Live Preview decoration plugin is swapped for a
   * no-op so the raw markdown shows through (L2 Session E, spec §2.3).
   * Lezer parsing keeps running either way, so `onAstChange` is
   * unaffected.
   */
  rawSource: boolean;
  /**
   * Per-vault resolver for wiki-link targets (L3 Session B). `null`
   * when no vault is open — every wiki-link renders as resolved-style
   * pending future targets, and clicks no-op.
   */
  wikilinkResolver?: WikiLinkResolver | null;
  /** Called when a click lands on a resolved wiki-link. */
  onNavigateWikilink?: (path: string, anchor: ResolvedAnchor | null) => void;
  /** Called when a click lands on an unresolved wiki-link. */
  onOfferCreateWikilink?: (path: string) => void;
  onAstChange?: (doc: CanonicalDocument) => void;
  onContentChange?: (content: string) => void;
  onBlur?: () => void;
  /**
   * Fired by the `Cmd/Ctrl+E` keybind so the parent can flip the
   * per-doc raw-source override (the same effect as the header `</>`
   * button's naked click).
   */
  onToggleRawSource?: () => void;
  /** Imperative handle, set on mount. */
  ref?: (api: EditorApi) => void;
}

const AST_DEBOUNCE_MS = 150;

const Editor: Component<EditorProps> = (props) => {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let astPending: ReturnType<typeof setTimeout> | undefined;

  const fireAst = (source: string) => {
    if (!props.onAstChange) return;
    props.onAstChange(normalize(source));
  };

  const scheduleAst = (source: string) => {
    if (!props.onAstChange) return;
    if (astPending !== undefined) clearTimeout(astPending);
    astPending = setTimeout(() => {
      astPending = undefined;
      fireAst(source);
    }, AST_DEBOUNCE_MS);
  };

  // Unsubscribe handle for the resolver's onUpdate notifications.
  // Re-bound whenever the `wikilinkResolver` prop changes.
  let unsubResolver: (() => void) | undefined;

  const subscribeResolver = (
    resolver: WikiLinkResolver | null | undefined,
    targetView: EditorView | undefined,
  ) => {
    unsubResolver?.();
    unsubResolver = undefined;
    if (resolver && targetView) {
      unsubResolver = resolver.onUpdate(() => {
        targetView.dispatch({ effects: wikilinkResolverUpdated.of(null) });
      });
    }
  };

  /** Click handler: route `WikiLink` Lezer-node clicks to the parent. */
  const handleClickAtPos = (clickView: EditorView, pos: number): boolean => {
    const tree = syntaxTree(clickView.state);
    let hit: { from: number; to: number } | null = null;
    tree.iterate({
      from: pos,
      to: pos,
      enter: (node) => {
        if (node.name === "WikiLink" && node.from <= pos && pos <= node.to) {
          hit = { from: node.from, to: node.to };
        }
      },
    });
    if (!hit) return false;
    const region = hit as { from: number; to: number };
    const raw = clickView.state.sliceDoc(region.from, region.to);
    const tok = scanWikilinks(raw).find((t) => t.kind === "wiki_link");
    if (!tok || tok.kind !== "wiki_link") return false;
    const targetWithAnchor =
      tok.anchor === null
        ? tok.target
        : `${tok.target}${tok.anchor.kind === "block" ? "#^" : "#"}${tok.anchor.value}`;

    const resolverObj = props.wikilinkResolver ?? null;
    if (!resolverObj) return false;

    handleWikiLinkClick(targetWithAnchor, {
      resolver: resolverObj,
      onNavigate: (path, anchor) =>
        props.onNavigateWikilink?.(path, anchor),
      onOfferCreate: (path) => props.onOfferCreateWikilink?.(path),
    });
    return true;
  };

  onMount(() => {
    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const source = update.state.doc.toString();
      scheduleAst(source);
      props.onContentChange?.(source);
    });

    const focusListener = EditorView.focusChangeEffect.of(
      (_state, focusing) => {
        if (!focusing) props.onBlur?.();
        return null;
      },
    );

    // CodeMirror places the caret on `mousedown`, not `click`, so a
    // `click` handler that calls `preventDefault()` is too late — the
    // cursor has already moved. We listen on `mousedown` instead so
    // the wiki-link route can intercept before CM's default selection
    // logic runs. Same gating (left-button, no modifiers) applies.
    const clickHandler = EditorView.domEventHandlers({
      mousedown(event, clickView) {
        if (event.button !== 0) return false;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return false;
        }
        const target = event.target as Node | null;
        if (!target) return false;
        const pos = clickView.posAtDOM(target);
        if (handleClickAtPos(clickView, pos)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    });

    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          keymap.of([
            {
              key: "Mod-e",
              run: () => {
                props.onToggleRawSource?.();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown({ extensions: [wikilinkExtension] }),
          decorationCompartment.of(
            props.rawSource ? [] : livePreviewDecorations,
          ),
          wikilinkResolverCompartment.of(
            wikilinkResolverFacet.of(facetValueFor(props.wikilinkResolver)),
          ),
          themeCompartment.of(buildCmTheme()),
          clickHandler,
          updateListener,
          focusListener,
        ],
      }),
    });

    subscribeResolver(props.wikilinkResolver, view);

    // Fire the initial AST synchronously so consumers don't have to
    // wait for the first keystroke to know what's loaded.
    fireAst(props.value);

    props.ref?.({
      getContent: () => view?.state.doc.toString() ?? "",
      replaceContent: (next) => {
        if (!view) return;
        const current = view.state.doc.toString();
        if (current === next) return;
        view.dispatch({
          changes: { from: 0, to: current.length, insert: next },
        });
      },
      replaceRange: (from, to, text) => {
        if (!view) return;
        view.dispatch({ changes: { from, to, insert: text } });
      },
      scrollToHeading: (value) => {
        if (!view) return;
        const target = value.trim();
        if (target.length === 0) return;
        const tree = syntaxTree(view.state);
        let found: { from: number } | null = null;
        tree.iterate({
          enter: (node) => {
            if (found) return false;
            if (!/^(ATX|Setext)Heading[1-6]$/.test(node.name)) return;
            // Read the heading content. ATX: strip leading `#`s and
            // trailing optional `#`s; Setext: the first line is the
            // content, the underline is on the next line.
            const line = view!.state.doc.lineAt(node.from);
            const raw = line.text;
            const atx = raw.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
            const text = (atx?.[1] ?? raw).trim();
            if (text === target) {
              found = { from: line.from };
              return false;
            }
            return;
          },
        });
        if (!found) return;
        const hit = found as { from: number };
        view.dispatch({
          effects: EditorView.scrollIntoView(hit.from, { y: "start" }),
        });
      },
    });
  });

  // Replace the document when `value` changes externally. Compare
  // against the current content so we don't fight a buffer the user
  // is actively editing.
  createEffect(
    on(
      () => props.value,
      (next) => {
        if (!view) return;
        const current = view.state.doc.toString();
        if (current === next) return;
        view.dispatch({
          changes: { from: 0, to: current.length, insert: next },
        });
        // The updateListener above will schedule the AST + onContentChange.
      },
      { defer: true },
    ),
  );

  // Swap the decoration plugin in/out when the raw-source state flips
  // (L2 Session E). Raw mode reconfigures the compartment to a no-op
  // extension so the hidden marker spans reappear; Lezer parsing is
  // untouched, so `onAstChange` keeps firing.
  createEffect(
    on(
      () => props.rawSource,
      (raw) => {
        view?.dispatch({
          effects: decorationCompartment.reconfigure(
            raw ? [] : livePreviewDecorations,
          ),
        });
      },
      { defer: true },
    ),
  );

  // Rebuild the CM6 chrome theme when the resolved theme flips. The
  // parent has already written `<html data-theme>`, so `buildCmTheme`
  // reads the correct token values.
  createEffect(
    on(
      () => props.resolvedTheme,
      () => {
        view?.dispatch({
          effects: themeCompartment.reconfigure(buildCmTheme()),
        });
      },
      { defer: true },
    ),
  );

  // Swap the wiki-link resolver when the parent's prop changes (a
  // different vault is open). Reconfigure the facet via the
  // compartment and re-bind the onUpdate subscription so cache
  // notifications dispatch into the right view.
  createEffect(
    on(
      () => props.wikilinkResolver,
      (resolver) => {
        view?.dispatch({
          effects: wikilinkResolverCompartment.reconfigure(
            wikilinkResolverFacet.of(facetValueFor(resolver)),
          ),
        });
        subscribeResolver(resolver, view);
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    unsubResolver?.();
    if (astPending !== undefined) clearTimeout(astPending);
    view?.destroy();
    view = undefined;
  });

  return (
    <div
      ref={host}
      style={{
        flex: "1",
        "min-height": "0",
        display: "flex",
        "flex-direction": "column",
        border: "1px solid var(--c-border-subtle)",
        "border-radius": "var(--radius-md)",
        background: "var(--c-bg-primary)",
        overflow: "hidden",
      }}
    />
  );
};

export default Editor;
