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
 * Read-only document minimap. A canvas companion *beside* CodeMirror — it
 * only reads `view` state/geometry and sets `scrollDOM.scrollTop`; it never
 * dispatches a document change (the "Solid stays out of CM editing" contract
 * in `Editor.tsx`). See `docs/superpowers/specs/2026-06-28-pretext-minimap-design.md`.
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

  const stripHeight = () => props.view.scrollDOM.clientHeight;

  const viewportInfo = () => {
    const dom = props.view.scrollDOM;
    return {
      scrollTop: dom.scrollTop,
      scrollHeight: dom.scrollHeight,
      clientHeight: dom.clientHeight,
    };
  };

  const paint = () => {
    if (disposed) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const h = stripHeight();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== WIDTH * dpr || canvas.height !== h * dpr) {
      canvas.width = WIDTH * dpr;
      canvas.height = h * dpr;
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

    props.view.scrollDOM.addEventListener("scroll", onScroll, {
      passive: true,
    });
    const ro = new ResizeObserver(() => scheduleRelayout());
    ro.observe(props.view.scrollDOM);

    relayout();

    onCleanup(() => {
      disposed = true;
      props.view.scrollDOM.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (relayoutTimer !== undefined) clearTimeout(relayoutTimer);
    });
  });

  // Pointer drag → scroll the editor.
  let dragging = false;
  const scrollToEvent = (clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const f = fractionFromClientY(clientY, rect.top, rect.height);
    props.view.scrollDOM.scrollTop = scrollTopForFraction(f, viewportInfo());
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
        height: "100%",
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
