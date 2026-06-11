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
  wikilinkResolverFacet,
  wikilinkResolverUpdated,
  type WikiLinkResolverFacetValue,
} from "./editor/decorations";
import { tagExtension } from "./editor/tag";
import {
  closestTagSpan,
  maybeInterceptTagMousedown,
  tagPathFromSlice,
} from "./editor/tagMousedown";
import { wikilinkExtension } from "./editor/wikilink";
import { handleWikiLinkClick } from "./editor/wikilinkClick";
import {
  closestWikiLinkSpan,
  maybeInterceptWikiLinkMousedown,
} from "./editor/wikilinkMousedown";
import type { WikiLinkResolver } from "./editor/wikilinkResolver";
import type { EmbedResolver } from "./editor/embedResolver";
import {
  embedResolverFacet,
  embedResolverUpdated,
  openNotePathFacet,
} from "./editor/embed";
import { livePreviewBundle } from "./editor/livePreview";
import { verticalDocLineMotion } from "./editor/embedNav";
import { autocompletion } from "@codemirror/autocomplete";
import {
  blockCompletionSource,
  linkCompletionSource,
  tagCompletionSource,
} from "./editor/autocomplete";
import type { AutocompleteProvider } from "./editor/autocompleteProvider";
import { byteOffsetOf } from "./editor/blockRef";
import { buildCmTheme } from "./editor/cm-theme";
import type { ResolvedAnchor } from "./api/ipc";
import type { ResolvedTheme } from "./styles/theme";

/**
 * Dev-only diagnostic handle for the L4-A-fix bug #5 decision tree
 * (`docs/superpowers/specs/2026-06-04-l4a-fix-design.md` §3.3) and
 * any future async-cache instrumentation. Stripped from production
 * bundles via `import.meta.env.DEV`. The global is set in `onMount`,
 * mirrored on vault swap via the resolver `createEffect`s, and
 * deleted in `onCleanup`.
 */
declare global {
  interface Window {
    __cubical?: {
      embedResolver: EmbedResolver | null;
      wikilinkResolver: WikiLinkResolver | null;
    };
  }
}

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

/**
 * Holds the per-editor embed resolver supplied to the embed widget via
 * {@link embedResolverFacet}. Reconfigured whenever the parent's
 * `embedResolver` prop changes.
 */
const embedResolverCompartment = new Compartment();

/**
 * Holds the open-note vault-relative path supplied to the embed widget
 * via {@link openNotePathFacet}. Reconfigured whenever the parent's
 * `openNotePath` prop changes — used to seed the cycle chain.
 */
const openNotePathCompartment = new Compartment();

/**
 * Holds the autocomplete extension. Reconfigured when the per-vault
 * {@link AutocompleteProvider} prop changes (a different vault opens),
 * so the `[[` / `#` completion sources always query the right vault.
 * `null` provider → no-op (`[]`), so the editor works with no vault.
 */
const autocompleteCompartment = new Compartment();

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

/** Build the autocomplete extension for a provider, or a no-op when null. */
const autocompleteExtensionFor = (
  provider: AutocompleteProvider | null | undefined,
) =>
  provider
    ? autocompletion({
        override: [
          linkCompletionSource(provider),
          tagCompletionSource(provider),
          blockCompletionSource(provider),
        ],
      })
    : [];

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
  /**
   * Per-vault resolver for embed content (L3 Session H.2). `null` when
   * no vault is open — the embed widget renders nothing in that state.
   */
  embedResolver?: EmbedResolver | null;
  /**
   * Vault-relative path of the currently open note (e.g. `notes/Daily.md`),
   * supplied so the embed widget can seed its cycle-detection chain. `null`
   * when no note is selected.
   */
  openNotePath?: string | null;
  /**
   * Per-vault autocomplete provider (L3 Session F). `null` when no
   * vault is open — `[[` / `#` complete nothing.
   */
  autocompleteProvider?: AutocompleteProvider | null;
  /** Called when a click lands on a resolved wiki-link. */
  onNavigateWikilink?: (path: string, anchor: ResolvedAnchor | null) => void;
  /** Called when a click lands on an unresolved wiki-link. */
  onOfferCreateWikilink?: (path: string) => void;
  /**
   * Called when a click lands on a tag decoration (L3 Session E).
   * `tagPath` is the bare body without the leading `#`. Case is
   * preserved as written in the document.
   */
  onNavigateTag?: (tagPath: string) => void;
  onAstChange?: (doc: CanonicalDocument) => void;
  onContentChange?: (content: string) => void;
  onBlur?: () => void;
  /**
   * Fired by the `Cmd/Ctrl+E` keybind so the parent can flip the
   * per-doc raw-source override (the same effect as the header `</>`
   * button's naked click).
   */
  onToggleRawSource?: () => void;
  /**
   * Fired by the block-reference keybind (`Cmd/Ctrl+Shift+B`). The
   * argument is the cursor's UTF-8 byte offset into the buffer; the
   * parent mints a block id at that line via `create_block_ref` and
   * copies a `[[…#^id]]` link to the clipboard.
   */
  onCopyBlockRef?: (byteOffset: number) => void;
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

  // Unsubscribe handle for the embed resolver's onUpdate notifications.
  let unsubEmbedResolver: (() => void) | undefined;

  const subscribeEmbedResolver = (
    resolver: EmbedResolver | null | undefined,
    targetView: EditorView | undefined,
  ) => {
    unsubEmbedResolver?.();
    unsubEmbedResolver = undefined;
    if (resolver && targetView) {
      unsubEmbedResolver = resolver.onUpdate(() => {
        targetView.dispatch({ effects: embedResolverUpdated.of(null) });
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

    // Fire-and-forget the async router. preventDefault() will run
    // synchronously below (we return true), blocking CM's caret move
    // before the resolver fetch settles; the navigation lands on the
    // next microtask (cache hit) or shortly after (cold cache).
    void handleWikiLinkClick(targetWithAnchor, {
      resolver: resolverObj,
      onNavigate: (path, anchor) =>
        props.onNavigateWikilink?.(path, anchor),
      onOfferCreate: (path) => props.onOfferCreateWikilink?.(path),
    });
    return true;
  };

  /**
   * Click handler: route `Tag` Lezer-node clicks to the parent.
   *
   * Same mechanism as `handleClickAtPos` for wiki-links — pull the
   * literal source for the node, strip the leading `#`, hand the tag
   * path to the `onNavigateTag` callback.
   *
   * Returns `true` when the click was handled and the caller should
   * `preventDefault`; `false` when no `Tag` node sits at `pos` (let CM
   * do its default caret move).
   */
  const handleTagClickAtPos = (clickView: EditorView, pos: number): boolean => {
    if (!props.onNavigateTag) return false;
    const tree = syntaxTree(clickView.state);
    let hit: { from: number; to: number } | null = null;
    tree.iterate({
      from: pos,
      to: pos,
      enter: (node) => {
        if (node.name === "Tag" && node.from <= pos && pos <= node.to) {
          hit = { from: node.from, to: node.to };
        }
      },
    });
    if (!hit) return false;
    const region = hit as { from: number; to: number };
    const raw = clickView.state.sliceDoc(region.from, region.to);
    const path = tagPathFromSlice(raw);
    if (path === null) return false;
    props.onNavigateTag(path);
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
            {
              key: "Mod-Shift-b",
              run: (view) => {
                const head = view.state.selection.main.head;
                const text = view.state.doc.toString();
                props.onCopyBlockRef?.(byteOffsetOf(text, head));
                return true;
              },
            },
            // Correct vertical cursor motion around tall block embeds.
            // CM6's geometric Up/Down overshoots a multi-row embed card
            // (one document line, many screen rows); these handlers
            // detect the overshoot and step exactly one document line so
            // the cursor can land on the embed line. No-op for normal
            // lines (returns false → default motion runs). Must precede
            // defaultKeymap so it wins for Arrow keys.
            {
              key: "ArrowUp",
              run: (view) => verticalDocLineMotion(view, false),
            },
            {
              key: "ArrowDown",
              run: (view) => verticalDocLineMotion(view, true),
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown({ extensions: [wikilinkExtension, tagExtension] }),
          decorationCompartment.of(
            props.rawSource ? [] : livePreviewBundle,
          ),
          wikilinkResolverCompartment.of(
            wikilinkResolverFacet.of(facetValueFor(props.wikilinkResolver)),
          ),
          embedResolverCompartment.of(
            embedResolverFacet.of(props.embedResolver ?? null),
          ),
          openNotePathCompartment.of(
            openNotePathFacet.of(props.openNotePath ?? null),
          ),
          autocompleteCompartment.of(
            autocompleteExtensionFor(props.autocompleteProvider),
          ),
          themeCompartment.of(buildCmTheme()),
          updateListener,
          focusListener,
        ],
      }),
    });

    // Wiki-link click interceptor.
    //
    // Previous attempts (`EditorView.domEventHandlers({ click })` and then
    // `…({ mousedown })`) failed in production WKWebView even though they
    // worked in Chromium: in WKWebView the contenteditable text-selection
    // logic moves the caret on `mousedown` *before* CM6's bubble-phase
    // listener fires, so `event.preventDefault()` is already too late.
    // Additionally, `posAtDOM(event.target)` returned positions that were
    // not always inside the WikiLink Lezer node when the target landed on
    // a text node inside a Decoration.mark span surrounded by hidden
    // Decoration.replace ranges.
    //
    // This handler avoids both problems:
    //   • Capture phase on `view.contentDOM` so we run before CM6 *and*
    //     before any default-selection logic dispatched from the same
    //     event loop turn.
    //   • DOM traversal (`closest('.cm-md-wikilink…')`) to detect a
    //     wiki-link click directly — no reliance on Lezer position
    //     matching DOM targets.
    //   • `posAtCoords({x, y})` to derive the doc position from the
    //     click's screen coordinates, which is more robust than
    //     `posAtDOM(target)` across DOM shapes.
    //   • `stopImmediatePropagation()` so no later handler (capture- or
    //     bubble-phase) re-runs and re-dispatches selection.
    const onContentMousedown = (event: MouseEvent) => {
      if (!view) return;
      const v = view;
      maybeInterceptWikiLinkMousedown(event, {
        findWikiLinkSpan: closestWikiLinkSpan,
        onWikiLinkHit: (e) => {
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          return handleClickAtPos(v, pos);
        },
      });
    };
    view.contentDOM.addEventListener("mousedown", onContentMousedown, true);

    // Tag click interceptor — same capture-phase pattern as wiki-links.
    // Wiki-links run first; tags only see the event if the wiki-link
    // path declined to handle it (a wiki-link span and a tag span can't
    // overlap, so order here is incidental — but the wiki-link handler
    // is registered first to preserve its claim on its own marks).
    const onContentTagMousedown = (event: MouseEvent) => {
      if (!view) return;
      const v = view;
      maybeInterceptTagMousedown(event, {
        findTagSpan: closestTagSpan,
        onTagHit: (e) => {
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          return handleTagClickAtPos(v, pos);
        },
      });
    };
    view.contentDOM.addEventListener("mousedown", onContentTagMousedown, true);

    subscribeResolver(props.wikilinkResolver, view);
    subscribeEmbedResolver(props.embedResolver, view);

    // Dev-only diagnostic handle — see `declare global` block above for context.
    if (import.meta.env.DEV) {
      window.__cubical = {
        embedResolver: props.embedResolver ?? null,
        wikilinkResolver: props.wikilinkResolver ?? null,
      };
    }

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
            raw ? [] : livePreviewBundle,
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
        if (import.meta.env.DEV && window.__cubical) {
          window.__cubical.wikilinkResolver = resolver ?? null;
        }
      },
      { defer: true },
    ),
  );

  // Swap the embed resolver when the parent's prop changes (a different
  // vault is open). Reconfigure the facet via the compartment and
  // re-bind the onUpdate subscription so cache notifications dispatch
  // into the right view.
  createEffect(
    on(
      () => props.embedResolver,
      (resolver) => {
        view?.dispatch({
          effects: embedResolverCompartment.reconfigure(
            embedResolverFacet.of(resolver ?? null),
          ),
        });
        subscribeEmbedResolver(resolver, view);
        if (import.meta.env.DEV && window.__cubical) {
          window.__cubical.embedResolver = resolver ?? null;
        }
      },
      { defer: true },
    ),
  );

  // Swap the open-note path facet when the parent's prop changes. The
  // embed widget reads this as the seed of its cycle-detection chain;
  // every navigation between notes flips the value.
  createEffect(
    on(
      () => props.openNotePath,
      (path) => {
        view?.dispatch({
          effects: openNotePathCompartment.reconfigure(
            openNotePathFacet.of(path ?? null),
          ),
        });
      },
      { defer: true },
    ),
  );

  // Swap the autocomplete provider when the parent's prop changes (a
  // different vault is open). Reconfigure the compartment so the
  // completion sources close over the new vault id.
  createEffect(
    on(
      () => props.autocompleteProvider,
      (provider) => {
        view?.dispatch({
          effects: autocompleteCompartment.reconfigure(
            autocompleteExtensionFor(provider),
          ),
        });
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    if (import.meta.env.DEV) {
      delete window.__cubical;
    }
    unsubResolver?.();
    unsubEmbedResolver?.();
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
        border: "none",
        background: "transparent",
        overflow: "hidden",
      }}
    />
  );
};

export default Editor;
