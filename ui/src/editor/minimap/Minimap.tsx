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
const FONT_PX = 2;

function readColors(): MinimapColors {
  const cs = getComputedStyle(document.documentElement);
  const tok = (n: string, fallback: string) =>
    cs.getPropertyValue(n).trim() || fallback;
  return {
    text: tok("--c-fg-primary", "#111"),
    background: tok("--c-bg-primary", "#fff"),
    indicator: tok("--editor-selection-bg", "rgba(79, 109, 104, 0.18)"),
  };
}

function readFont(): string {
  const cs = getComputedStyle(document.documentElement);
  const family = cs.getPropertyValue("--font-mono").trim() || "monospace";
  return `${FONT_PX}px ${family}`;
}

function scrollViewportOf(el: HTMLElement): HTMLElement {
  for (let cur = el.parentElement; cur; cur = cur.parentElement) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === "auto" || oy === "scroll") return cur;
  }
  return el;
}

const Minimap: Component<{
  view: EditorView;
  resolvedTheme: ResolvedTheme;
}> = (props) => {
  let canvas!: HTMLCanvasElement;
  let relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  let rafPending = false;
  let disposed = false;

  let layout: { lines: { text: string }[]; contentHeight: number } = {
    lines: [],
    contentHeight: 0,
  };
  let lineHeight = 1;

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
    const listener = EditorView.updateListener.of((u) => {
      if (disposed) return;
      if (u.docChanged) scheduleRelayout();
    });
    props.view.dispatch({ effects: StateEffect.appendConfig.of(listener) });

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
