import { createEffect, on, onCleanup, onMount, type Component } from "solid-js";
import { EditorView } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import type { ResolvedTheme } from "../../styles/theme";
import type { MinimapColors } from "./types";
import { layoutDocument } from "./pretextLayout";
import { drawMinimap } from "./minimapRender";
import {
  fractionFromClientY,
  indicatorRect,
  lineHeightFor,
  scrollTopForFraction,
} from "./minimapGeometry";

const WIDTH = 96;
const RELAYOUT_MS = 200;
/** Measurement/draw font size (px); line *advance* is the scale-to-fit height. */
const FONT_PX = 2;

/** Read minimap colors from the CM theme tokens currently on <html>. */
function readColors(): MinimapColors {
  const cs = getComputedStyle(document.documentElement);
  const tok = (n: string, fallback: string) =>
    cs.getPropertyValue(n).trim() || fallback;
  return {
    text: tok("--c-fg-primary", "#111"),
    background: tok("--c-bg-primary", "#fff"),
    indicator: tok("--editor-selection-bg", "#3b82f6"),
  };
}

/** Minimap font: small, mono, matching the editor family. */
function readFont(): string {
  const cs = getComputedStyle(document.documentElement);
  const family = cs.getPropertyValue("--font-mono").trim() || "monospace";
  return `${FONT_PX}px ${family}`;
}

/**
 * The element that actually scrolls the document. CodeMirror no longer
 * scrolls internally (`cm-theme.ts` sets the scroller `overflow: visible`
 * so the editor grows and the *page* container scrolls); the minimap must
 * read scroll geometry from that page container, not `view.scrollDOM`.
 * Walks up to the nearest scrollable ancestor, falling back to the start
 * element if none is found.
 */
function scrollViewportOf(el: HTMLElement): HTMLElement {
  for (let cur = el.parentElement; cur; cur = cur.parentElement) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === "auto" || oy === "scroll") return cur;
  }
  return el;
}

/**
 * Read-only document minimap. A canvas companion *beside* CodeMirror — it
 * reads `view` doc state plus the page scroll viewport's geometry and drives
 * that viewport's `scrollTop`; it never dispatches a document change (the
 * "Solid stays out of CM editing" contract in `Editor.tsx`). See
 * `docs/superpowers/specs/2026-06-28-pretext-minimap-design.md`.
 *
 * Doc changes drive a debounced relayout (Pretext) via an appended CM
 * `updateListener`; scrolls drive a cheap rAF-throttled repaint (the indicator
 * moves, the layout is reused). Both are torn down on cleanup.
 */
const Minimap: Component<{
  view: EditorView;
  resolvedTheme: ResolvedTheme;
}> = (props) => {
  let canvas!: HTMLCanvasElement;
  let relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  let rafPending = false;
  let disposed = false;

  // Last computed layout, reused on scroll-only repaints.
  let layout: { lines: { text: string }[]; contentHeight: number } = {
    lines: [],
    contentHeight: 0,
  };
  let lineHeight = 1;

  // The page scroll viewport (resolved in onMount); defaults to the CM
  // scroller so any pre-mount read is still safe.
  let scrollEl: HTMLElement = props.view.scrollDOM;

  const stripHeight = () => scrollEl.clientHeight;

  const viewportInfo = () => ({
    scrollTop: scrollEl.scrollTop,
    scrollHeight: scrollEl.scrollHeight,
    clientHeight: scrollEl.clientHeight,
  });

  const paint = () => {
    if (disposed) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const h = stripHeight();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== WIDTH * dpr || canvas.height !== h * dpr) {
      canvas.width = WIDTH * dpr;
      canvas.height = h * dpr;
      // The editor grows to its content height, so the strip can't size to
      // it via CSS `height: 100%` — pin the sticky canvas to the *viewport*
      // height we just measured.
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMinimap(ctx, {
      layout,
      lineHeight,
      indicator: indicatorRect(viewportInfo(), h),
      colors: readColors(),
      width: WIDTH,
      height: h,
      font: readFont(),
    });
  };

  const relayout = () => {
    if (disposed) return;
    const text = props.view.state.doc.toString();
    const lineCount = props.view.state.doc.lines;
    lineHeight = lineHeightFor(lineCount, stripHeight());
    layout = layoutDocument({
      text,
      width: WIDTH,
      lineHeight,
      font: readFont(),
    });
    paint();
  };

  const scheduleRelayout = () => {
    if (relayoutTimer !== undefined) clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(relayout, RELAYOUT_MS);
  };

  const schedulePaint = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      paint();
    });
  };

  const onScroll = () => schedulePaint();

  onMount(() => {
    // Doc changes → debounced relayout. Appended (not initial config) because
    // the minimap mounts after the EditorView; the `disposed` guard makes the
    // callback inert after cleanup.
    const listener = EditorView.updateListener.of((u) => {
      if (disposed) return;
      if (u.docChanged) scheduleRelayout();
    });
    props.view.dispatch({ effects: StateEffect.appendConfig.of(listener) });

    // CM no longer scrolls itself; track the page scroll viewport instead.
    scrollEl = scrollViewportOf(props.view.scrollDOM);
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => scheduleRelayout());
    ro.observe(scrollEl);

    relayout();

    onCleanup(() => {
      disposed = true;
      scrollEl.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (relayoutTimer !== undefined) clearTimeout(relayoutTimer);
    });
  });

  // Pointer drag → scroll the editor.
  let dragging = false;
  const scrollToEvent = (clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const f = fractionFromClientY(clientY, rect.top, rect.height);
    scrollEl.scrollTop = scrollTopForFraction(f, viewportInfo());
  };
  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    scrollToEvent(e.clientY);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (dragging) scrollToEvent(e.clientY);
  };
  const onPointerUp = (e: PointerEvent) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  };

  // Repaint when the theme flips; colors are re-read fresh inside paint().
  createEffect(
    on(
      () => props.resolvedTheme,
      () => schedulePaint(),
      { defer: true },
    ),
  );

  return (
    <canvas
      ref={canvas}
      style={{
        width: `${WIDTH}px`,
        // Height is set in JS to the scroll viewport's height; sticky keeps
        // the strip pinned beside the visible text as the page scrolls,
        // and flex-start stops it stretching to the (tall) editor content.
        "align-self": "flex-start",
        position: "sticky",
        top: "0",
        "flex-shrink": "0",
        cursor: "pointer",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
};

export default Minimap;
