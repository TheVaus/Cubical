import {
  createEffect,
  createSignal,
  For,
  Show,
  untrack,
  type Component,
} from "solid-js";

import { getBacklinks, type Backlink } from "../api/ipc";
import {
  backlinkKey,
  basenameWithoutExtension,
  reduceBacklinksState,
  type BacklinksViewState,
} from "./backlinksState";

/**
 * Props for the Backlinks panel.
 *
 * `vaultId` + `path` drive the fetch. `refreshSignal` is a tick the
 * parent increments to force a refetch (used by the
 * `vault:file-changed` debounce in `App.tsx`). `onRowClick` reuses
 * the parent's existing file-open flow.
 */
export interface BacklinksProps {
  vaultId: string | null;
  path: string | null;
  refreshSignal: number;
  onRowClick: (path: string) => void;
}

const Backlinks: Component<BacklinksProps> = (props) => {
  const [state, setState] = createSignal<BacklinksViewState>({ kind: "idle" });

  // Refetch whenever vault, path, or the refresh signal changes.
  // We capture the in-flight token in a closure so a late response
  // from a previous fetch never overwrites a newer one's state.
  //
  // Critical: every `state()` read goes through `untrack` so the effect
  // does NOT subscribe to its own writes. `reduceBacklinksState` always
  // returns a fresh object reference, so a tracked read here would form
  // a self-trigger loop (synchronously: blow the JS stack; once a file
  // is selected: spin on `fetch:start`, never reaching `loaded` because
  // each iteration's token supersedes the previous fetch's `.then`).
  let token = 0;
  createEffect(() => {
    const vid = props.vaultId;
    const p = props.path;
    // Read so the effect tracks it; value itself is unused.
    void props.refreshSignal;

    if (!vid || !p) {
      setState(reduceBacklinksState(untrack(state), { type: "file:cleared" }));
      return;
    }

    const my = ++token;
    setState(reduceBacklinksState(untrack(state), { type: "fetch:start" }));
    getBacklinks({ vault_id: vid, path: p })
      .then((resp) => {
        if (my !== token) return;
        setState(
          reduceBacklinksState(untrack(state), {
            type: "fetch:success",
            backlinks: resp.backlinks,
          }),
        );
      })
      .catch((e: unknown) => {
        if (my !== token) return;
        const message =
          typeof e === "object" && e !== null && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
        setState(
          reduceBacklinksState(untrack(state), { type: "fetch:error", message }),
        );
      });
  });

  return (
    <section
      aria-label="Backlinks"
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        "min-height": 0,
        flex: 1,
        "overflow-y": "auto",
      }}
    >
      <header
        style={{
          color: "var(--c-fg-secondary)",
          "font-size": "var(--text-xs)",
          "font-family": "var(--font-body)",
          "text-transform": "uppercase",
          "letter-spacing": "0.05em",
        }}
      >
        Backlinks
      </header>
      <Show
        when={state().kind !== "idle"}
        fallback={
          <p
            style={{
              margin: 0,
              color: "var(--c-fg-muted)",
              "font-size": "var(--text-xs)",
            }}
          >
            Select a note to see its backlinks.
          </p>
        }
      >
        <Show when={state().kind === "loading"}>
          <p
            style={{
              margin: 0,
              color: "var(--c-fg-muted)",
              "font-size": "var(--text-xs)",
            }}
          >
            Loading…
          </p>
        </Show>
        <Show when={state().kind === "empty"}>
          <p
            style={{
              margin: 0,
              color: "var(--c-fg-muted)",
              "font-size": "var(--text-xs)",
            }}
          >
            No backlinks yet.
          </p>
        </Show>
        <Show when={state().kind === "error"}>
          {(_) => {
            const s = state();
            if (s.kind !== "error") return null;
            return (
              <p
                role="alert"
                style={{
                  margin: 0,
                  color: "var(--c-error)",
                  "font-size": "var(--text-xs)",
                }}
              >
                {s.message}
              </p>
            );
          }}
        </Show>
        <Show when={state().kind === "loaded"}>
          {(_) => {
            const s = state();
            if (s.kind !== "loaded") return null;
            return (
              <ul
                role="list"
                style={{
                  margin: 0,
                  padding: 0,
                  "list-style": "none",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "var(--space-2)",
                }}
              >
                <For each={s.backlinks}>
                  {(b: Backlink) => (
                    <li
                      role="listitem"
                      onClick={() => props.onRowClick(b.source_path)}
                      data-key={backlinkKey(b)}
                      style={{
                        display: "flex",
                        "flex-direction": "column",
                        gap: "var(--space-1)",
                        padding: "var(--space-2) var(--space-3)",
                        border: "1px solid var(--c-border-subtle)",
                        "border-radius": "var(--radius-sm, var(--radius-md))",
                        background: "var(--c-bg-secondary)",
                        cursor: "pointer",
                        transition: "background var(--transition-fast)",
                      }}
                      title={b.source_path}
                    >
                      <span
                        style={{
                          "font-size": "var(--text-sm)",
                          "font-family": "var(--font-body)",
                          color: "var(--c-fg-primary)",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {basenameWithoutExtension(b.source_path)}
                      </span>
                      <span
                        style={{
                          "font-size": "var(--text-xs)",
                          "font-family": "var(--font-mono)",
                          color: "var(--c-fg-secondary)",
                          "line-height": "var(--leading-base)",
                        }}
                      >
                        {b.context || "—"}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            );
          }}
        </Show>
      </Show>
    </section>
  );
};

export default Backlinks;
