import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import { EditorView, keymap } from "@codemirror/view";
import Minimap from "./editor/minimap/Minimap";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  DEFAULT_BINDINGS,
  toCmBindings,
  type Command,
  type KeyBinding,
} from "./core/commands";
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
  findBlockDefinitionOffset,
  findHeadingOffset,
} from "./editor/anchorScroll";
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
import type { PropertyResolver } from "./editor/propertyResolver";
import {
  propertyResolverFacet,
  propertyResolverUpdated,
} from "./editor/propertyRef";
import type { DataviewRunner } from "./editor/dataview";
import { dataviewRunnerFacet, dataviewRunnerUpdated } from "./editor/dataview";
import {
  closestDataviewFrame,
  closestDataviewLink,
  maybeInterceptDataviewMousedown,
} from "./editor/dataviewMousedown";
import { livePreviewFor } from "./editor/livePreview";
import { colorSourceHighlight } from "./editor/colorSource";
import { createUpdateSubscriber } from "./editor/updateSubscription";
import { verticalDocLineMotion } from "./editor/embedNav";
import { autoCloseExtension } from "./editor/autoClose";
import { autocompleteExtensionFor } from "./editor/autocomplete";
import type { AutocompleteProvider } from "./editor/autocompleteProvider";
import { byteOffsetOf } from "./editor/blockRef";
import { buildCmTheme } from "./editor/cm-theme";
import type { ResolvedAnchor } from "./api/ipc";
import type { ResolvedTheme } from "./styles/theme";

declare global {
  interface Window {
    __cubical?: {
      embedResolver: EmbedResolver | null;
      wikilinkResolver: WikiLinkResolver | null;
    };
  }
}

const decorationCompartment = new Compartment();

const colorSourceCompartment = new Compartment();

const themeCompartment = new Compartment();

const wikilinkResolverCompartment = new Compartment();

const embedResolverCompartment = new Compartment();

const propertyResolverCompartment = new Compartment();

const openNotePathCompartment = new Compartment();

const dataviewRunnerCompartment = new Compartment();

const autocompleteCompartment = new Compartment();

const keymapCompartment = new Compartment();

const facetValueFor = (
  resolver: WikiLinkResolver | null | undefined,
): WikiLinkResolverFacetValue | null =>
  resolver
    ? {
        get: (t) => resolver.get(t),
        fetch: (t) => resolver.fetch(t),
      }
    : null;

export interface EditorApi {
  getContent: () => string;
  replaceContent: (next: string) => void;
  replaceRange: (from: number, to: number, text: string) => void;
  scrollToHeading: (value: string) => boolean;
  scrollToBlock: (value: string) => boolean;
  requestAnchorScroll: (anchor: ResolvedAnchor) => void;
}

export interface EditorProps {
  value: string;
  resolvedTheme: ResolvedTheme;
  rawSource: boolean;
  minimapEnabled?: boolean;
  colorizeSource?: boolean;
  wikilinkResolver?: WikiLinkResolver | null;
  embedResolver?: EmbedResolver | null;
  propertyResolver?: PropertyResolver | null;
  propertyRefsEnabled?: boolean;
  mathEnabled?: boolean;
  equationsEnabled?: boolean;
  dataviewRunner?: DataviewRunner | null;
  openNotePath?: string | null;
  autocompleteProvider?: AutocompleteProvider | null;
  editorBindings?: KeyBinding[];
  onNavigateWikilink?: (path: string, anchor: ResolvedAnchor | null) => void;
  onOfferCreateWikilink?: (path: string) => void;
  onAnchorNotFound?: (anchor: ResolvedAnchor) => void;
  onNavigateTag?: (tagPath: string) => void;
  onAstChange?: (doc: CanonicalDocument) => void;
  onContentChange?: (content: string) => void;
  onBlur?: () => void;
  onToggleRawSource?: () => void;
  onCopyBlockRef?: (byteOffset: number) => void;
  ref?: (api: EditorApi) => void;
}

const AST_DEBOUNCE_MS = 150;

const Editor: Component<EditorProps> = (props) => {
  const preview = () =>
    livePreviewFor(props.rawSource, {
      math: props.mathEnabled ?? true,
      equations: props.equationsEnabled ?? true,
      propertyRefs: props.propertyRefsEnabled ?? true,
    });
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let astPending: ReturnType<typeof setTimeout> | undefined;
  const [cmView, setCmView] = createSignal<EditorView>();

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

  const subscribeResolver = createUpdateSubscriber(wikilinkResolverUpdated);
  const subscribeEmbedResolver = createUpdateSubscriber(embedResolverUpdated);
  const subscribePropertyResolver = createUpdateSubscriber(
    propertyResolverUpdated,
  );
  const subscribeDataviewRunner = createUpdateSubscriber(dataviewRunnerUpdated);

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

    void handleWikiLinkClick(targetWithAnchor, {
      resolver: resolverObj,
      onNavigate: (path, anchor) =>
        props.onNavigateWikilink?.(path, anchor),
      onOfferCreate: (path) => props.onOfferCreateWikilink?.(path),
    });
    return true;
  };

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

  const editorCommands: Record<string, Command> = {
    "editor.toggleRawSource": {
      id: "editor.toggleRawSource",
      title: "Toggle raw source",
      run: () => props.onToggleRawSource?.(),
    },
    "editor.copyBlockRef": {
      id: "editor.copyBlockRef",
      title: "Copy block reference",
      run: () => {
        if (!view) return;
        const head = view.state.selection.main.head;
        const text = view.state.doc.toString();
        props.onCopyBlockRef?.(byteOffsetOf(text, head));
      },
    },
    "editor.followWikilink": {
      id: "editor.followWikilink",
      title: "Follow link under cursor",
      run: () => {
        if (!view) return;
        handleClickAtPos(view, view.state.selection.main.head);
      },
    },
  };

  const buildEditorKeymap = (bindings: KeyBinding[] | undefined) =>
    keymap.of([
      ...toCmBindings(bindings ?? DEFAULT_BINDINGS, editorCommands),
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
    ]);

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
          keymapCompartment.of(buildEditorKeymap(props.editorBindings)),
          markdown({ extensions: [wikilinkExtension, tagExtension] }),
          EditorView.lineWrapping,
          decorationCompartment.of(preview()),
          colorSourceCompartment.of(
            props.rawSource && props.colorizeSource ? colorSourceHighlight : [],
          ),
          wikilinkResolverCompartment.of(
            wikilinkResolverFacet.of(facetValueFor(props.wikilinkResolver)),
          ),
          embedResolverCompartment.of(
            embedResolverFacet.of(props.embedResolver ?? null),
          ),
          propertyResolverCompartment.of(
            propertyResolverFacet.of(props.propertyResolver ?? null),
          ),
          dataviewRunnerCompartment.of(
            dataviewRunnerFacet.of(props.dataviewRunner ?? null),
          ),
          openNotePathCompartment.of(
            openNotePathFacet.of(props.openNotePath ?? null),
          ),
          autocompleteCompartment.of(
            autocompleteExtensionFor(props.autocompleteProvider),
          ),
          autoCloseExtension,
          themeCompartment.of(buildCmTheme()),
          updateListener,
          focusListener,
        ],
      }),
    });

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

    const onContentDataviewMousedown = (event: MouseEvent) => {
      if (!view) return;
      const v = view;
      maybeInterceptDataviewMousedown(event, {
        findDataviewLink: closestDataviewLink,
        findDataviewFrame: closestDataviewFrame,
        onLinkHit: (link) => {
          const path = link.getAttribute("data-path");
          if (path === null || path === "") return false;
          const runner = props.dataviewRunner;
          if (!runner) return false;
          runner.open(path);
          return true;
        },
        onFrameHit: (frame) => {
          const pos = v.posAtDOM(frame);
          if (pos < 0) return false;
          v.dispatch({ selection: { anchor: pos } });
          return true;
        },
      });
    };
    view.contentDOM.addEventListener(
      "mousedown",
      onContentDataviewMousedown,
      true,
    );

    subscribeResolver(props.wikilinkResolver, view);
    subscribeEmbedResolver(props.embedResolver, view);
    subscribePropertyResolver(props.propertyResolver, view);
    subscribeDataviewRunner(props.dataviewRunner, view);

    if (import.meta.env.DEV) {
      window.__cubical = {
        embedResolver: props.embedResolver ?? null,
        wikilinkResolver: props.wikilinkResolver ?? null,
      };
    }

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
      scrollToHeading: (value) => scrollToHeadingImpl(value),
      scrollToBlock: (value) => scrollToBlockImpl(value),
      requestAnchorScroll: (anchor) => {
        pendingAnchor = anchor;
      },
    });

    setCmView(view);
  });

  const scrollToHeadingImpl = (value: string): boolean => {
    if (!view) return false;
    const offset = findHeadingOffset(view.state, value);
    if (offset === null) return false;
    view.dispatch({
      effects: EditorView.scrollIntoView(offset, { y: "start" }),
    });
    return true;
  };

  const scrollToBlockImpl = (value: string): boolean => {
    if (!view) return false;
    const offset = findBlockDefinitionOffset(
      view.state.doc.toString(),
      value.trim(),
    );
    if (offset === null) return false;
    view.dispatch({
      effects: EditorView.scrollIntoView(offset, { y: "start" }),
    });
    return true;
  };

  let pendingAnchor: ResolvedAnchor | null = null;

  const runPendingAnchor = () => {
    const anchor = pendingAnchor;
    if (!anchor) return;
    pendingAnchor = null;
    const found =
      anchor.kind === "heading"
        ? scrollToHeadingImpl(anchor.value)
        : scrollToBlockImpl(anchor.value);
    if (!found) props.onAnchorNotFound?.(anchor);
  };

  createEffect(
    on(
      () => props.value,
      (next) => {
        if (!view) return;
        const current = view.state.doc.toString();
        if (current !== next) {
          view.dispatch({
            changes: { from: 0, to: current.length, insert: next },
          });
        }
        runPendingAnchor();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () =>
        [
          props.rawSource,
          props.mathEnabled,
          props.equationsEnabled,
          props.propertyRefsEnabled,
        ] as const,
      () => {
        view?.dispatch({
          effects: decorationCompartment.reconfigure(preview()),
        });
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => props.rawSource && (props.colorizeSource ?? false),
      (active) => {
        view?.dispatch({
          effects: colorSourceCompartment.reconfigure(
            active ? colorSourceHighlight : [],
          ),
        });
      },
      { defer: true },
    ),
  );

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

  createEffect(
    on(
      () => props.propertyResolver,
      (resolver) => {
        view?.dispatch({
          effects: propertyResolverCompartment.reconfigure(
            propertyResolverFacet.of(resolver ?? null),
          ),
        });
        subscribePropertyResolver(resolver, view);
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => props.dataviewRunner,
      (runner) => {
        view?.dispatch({
          effects: dataviewRunnerCompartment.reconfigure(
            dataviewRunnerFacet.of(runner ?? null),
          ),
        });
        subscribeDataviewRunner(runner, view);
      },
      { defer: true },
    ),
  );

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

  createEffect(
    on(
      () => props.editorBindings,
      (bindings) => {
        view?.dispatch({
          effects: keymapCompartment.reconfigure(buildEditorKeymap(bindings)),
        });
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    if (import.meta.env.DEV) {
      delete window.__cubical;
    }
    if (astPending !== undefined) clearTimeout(astPending);
    view?.destroy();
    view = undefined;
  });

  return (
    <div style={{ display: "flex", flex: "1 0 auto" }}>
      <div
        ref={host}
        style={{
          flex: "1",
          "min-width": "0",
          display: "flex",
          "flex-direction": "column",
          border: "none",
          background: "transparent",
        }}
      />
      <Show when={props.minimapEnabled && cmView()}>
        {(v) => <Minimap view={v()} resolvedTheme={props.resolvedTheme} />}
      </Show>
    </div>
  );
};

export default Editor;
