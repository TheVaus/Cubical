import {
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
  type Component,
} from "solid-js";

import {
  flushPendingRewrites,
  getPendingRewritesBreakdown,
  listRecentRenameOps,
  undoRename,
} from "../api/ipc";
import {
  breakdownKey,
  reducePendingRewritesPopover,
  renameOpKey,
  type PendingRewritesPopoverState,
} from "./pendingRewritesState";
import { formatPendingRewrites } from "./pendingRewritesLabel";

export interface PendingRewritesProps {
  /** Null until a vault is open. Component renders nothing in that case. */
  vaultId: string | null;
  /** Live count from `onVaultPendingRewritesChanged`. */
  count: number;
  /** Surface a human-facing message back to the parent (typically `showToast`). */
  onError: (message: string) => void;
}

const RECENT_RENAME_OPS_LIMIT = 5;

/**
 * Status-bar item + click-out popover for the L3 Session J pending
 * rewrites cache. Closed: the formatter label. Open: total + per-target
 * breakdown + "Save all pending" + recent rename ops with per-op Undo.
 *
 * Popover state is refetched on every open — keeps it consistent when
 * background events (own renames + flushes) landed between opens.
 *
 * See `docs/layer-3-spec.md` §9.16.
 */
const PendingRewrites: Component<PendingRewritesProps> = (props) => {
  const [state, setState] = createSignal<PendingRewritesPopoverState>({
    kind: "closed",
  });
  const [flushing, setFlushing] = createSignal(false);
  const [pendingUndoId, setPendingUndoId] = createSignal<number | null>(null);

  let token = 0;

  const refetch = () => {
    const vid = props.vaultId;
    if (!vid) return;
    const my = ++token;
    setState(reducePendingRewritesPopover(untrack(state), { type: "open" }));
    Promise.all([
      getPendingRewritesBreakdown({ vault_id: vid }),
      listRecentRenameOps({ vault_id: vid, limit: RECENT_RENAME_OPS_LIMIT }),
    ])
      .then(([bd, ops]) => {
        if (my !== token) return;
        setState(
          reducePendingRewritesPopover(untrack(state), {
            type: "fetch:success",
            breakdown: bd.rows,
            ops: ops.ops,
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
          reducePendingRewritesPopover(untrack(state), {
            type: "fetch:error",
            message,
          }),
        );
      });
  };

  const open = () => {
    if (!props.vaultId) return;
    refetch();
  };

  const close = () => {
    token++;
    setState(reducePendingRewritesPopover(untrack(state), { type: "close" }));
  };

  const onDocumentMouseDown = (e: MouseEvent) => {
    if (state().kind === "closed") return;
    const root = popoverRoot;
    if (root && e.target instanceof Node && root.contains(e.target)) return;
    close();
  };

  const onDocumentKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && state().kind !== "closed") close();
  };

  document.addEventListener("mousedown", onDocumentMouseDown);
  document.addEventListener("keydown", onDocumentKeyDown);
  onCleanup(() => {
    document.removeEventListener("mousedown", onDocumentMouseDown);
    document.removeEventListener("keydown", onDocumentKeyDown);
  });

  let popoverRoot: HTMLSpanElement | undefined;

  const handleFlushAll = async () => {
    const vid = props.vaultId;
    if (!vid) return;
    setFlushing(true);
    try {
      await flushPendingRewrites({ vault_id: vid });
      // Refetch (rows may have changed); the flush-complete event will
      // surface the toast.
      refetch();
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      props.onError(message);
    } finally {
      setFlushing(false);
    }
  };

  const handleUndo = async (rename_op_id: number) => {
    const vid = props.vaultId;
    if (!vid) return;
    setPendingUndoId(rename_op_id);
    try {
      await undoRename({ vault_id: vid, rename_op_id });
      refetch();
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      props.onError(message);
    } finally {
      setPendingUndoId(null);
    }
  };

  return (
    <Show when={props.vaultId !== null && formatPendingRewrites(props.count)}>
      {(display) => (
        <span style={{ position: "relative" }} ref={(el) => (popoverRoot = el)}>
          <button
            type="button"
            aria-label={`${display().label} — open details`}
            aria-expanded={state().kind !== "closed"}
            onClick={() => (state().kind === "closed" ? open() : close())}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--c-accent)",
              cursor: "pointer",
              "font-family": "var(--font-mono)",
              "font-size": "var(--text-xs)",
              padding: 0,
            }}
          >
            {display().label}
          </button>
          <Show when={state().kind !== "closed"}>
            <div
              role="dialog"
              aria-label="Pending rewrites"
              style={{
                position: "absolute",
                bottom: "calc(100% + var(--space-2))",
                right: 0,
                "min-width": "20rem",
                "max-width": "28rem",
                background: "var(--c-bg-primary)",
                border: "1px solid var(--c-border-subtle)",
                "border-radius": "var(--radius-md)",
                "box-shadow": "var(--shadow-lg)",
                padding: "var(--space-3)",
                display: "flex",
                "flex-direction": "column",
                gap: "var(--space-3)",
                "z-index": 15,
                "font-family": "var(--font-body)",
                color: "var(--c-fg-primary)",
                "text-align": "left",
              }}
            >
              <header
                style={{
                  "font-size": "var(--text-sm)",
                  "font-weight": "600",
                }}
              >
                {display().label}
              </header>
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
                    <>
                      <section
                        aria-label="Per-target breakdown"
                        style={{
                          display: "flex",
                          "flex-direction": "column",
                          gap: "var(--space-1)",
                        }}
                      >
                        <Show
                          when={s.breakdown.length > 0}
                          fallback={
                            <p
                              style={{
                                margin: 0,
                                color: "var(--c-fg-muted)",
                                "font-size": "var(--text-xs)",
                              }}
                            >
                              No pending changes.
                            </p>
                          }
                        >
                          <ul
                            role="list"
                            style={{
                              margin: 0,
                              padding: 0,
                              "list-style": "none",
                              display: "flex",
                              "flex-direction": "column",
                              gap: "var(--space-1)",
                            }}
                          >
                            <For each={s.breakdown}>
                              {(b) => (
                                <li
                                  data-key={breakdownKey(b)}
                                  style={{
                                    display: "flex",
                                    "justify-content": "space-between",
                                    gap: "var(--space-3)",
                                    "font-size": "var(--text-xs)",
                                    "font-family": "var(--font-mono)",
                                    color: "var(--c-fg-secondary)",
                                  }}
                                >
                                  <span
                                    title={b.target_file}
                                    style={{
                                      overflow: "hidden",
                                      "text-overflow": "ellipsis",
                                      "white-space": "nowrap",
                                    }}
                                  >
                                    {b.target_file}
                                  </span>
                                  <span style={{ "flex-shrink": 0 }}>
                                    {b.count}
                                  </span>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </section>
                      <button
                        type="button"
                        onClick={() => void handleFlushAll()}
                        disabled={flushing() || s.breakdown.length === 0}
                        style={{
                          padding: "var(--space-1) var(--space-3)",
                          "font-size": "var(--text-xs)",
                          color: "var(--c-fg-inverse)",
                          background: "var(--c-accent)",
                          border: "none",
                          "border-radius": "var(--radius-sm)",
                          cursor:
                            flushing() || s.breakdown.length === 0
                              ? "default"
                              : "pointer",
                          opacity:
                            flushing() || s.breakdown.length === 0 ? 0.6 : 1,
                        }}
                      >
                        {flushing() ? "Saving…" : "Save all pending changes"}
                      </button>
                      <section
                        aria-label="Recent renames"
                        style={{
                          display: "flex",
                          "flex-direction": "column",
                          gap: "var(--space-1)",
                        }}
                      >
                        <header
                          style={{
                            color: "var(--c-fg-secondary)",
                            "font-size": "var(--text-xs)",
                            "text-transform": "uppercase",
                            "letter-spacing": "0.05em",
                          }}
                        >
                          Recent renames
                        </header>
                        <Show
                          when={s.ops.length > 0}
                          fallback={
                            <p
                              style={{
                                margin: 0,
                                color: "var(--c-fg-muted)",
                                "font-size": "var(--text-xs)",
                              }}
                            >
                              No recent renames.
                            </p>
                          }
                        >
                          <ul
                            role="list"
                            style={{
                              margin: 0,
                              padding: 0,
                              "list-style": "none",
                              display: "flex",
                              "flex-direction": "column",
                              gap: "var(--space-1)",
                            }}
                          >
                            <For each={s.ops}>
                              {(op) => {
                                const isPending = () =>
                                  pendingUndoId() === op.rename_op_id;
                                return (
                                  <li
                                    data-key={renameOpKey(op)}
                                    style={{
                                      display: "flex",
                                      "justify-content": "space-between",
                                      "align-items": "center",
                                      gap: "var(--space-3)",
                                      "font-size": "var(--text-xs)",
                                    }}
                                  >
                                    <span
                                      style={{
                                        "font-family": "var(--font-mono)",
                                        color: "var(--c-fg-secondary)",
                                      }}
                                    >
                                      #{op.rename_op_id} · {op.kind} ·{" "}
                                      {op.row_count} row
                                      {op.row_count === 1 ? "" : "s"}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => void handleUndo(op.rename_op_id)}
                                      disabled={isPending()}
                                      style={{
                                        padding: "var(--space-1) var(--space-3)",
                                        "font-size": "var(--text-xs)",
                                        color: "var(--c-fg-primary)",
                                        background: "var(--c-bg-tertiary)",
                                        border:
                                          "1px solid var(--c-border-subtle)",
                                        "border-radius": "var(--radius-sm)",
                                        cursor: isPending() ? "wait" : "pointer",
                                      }}
                                    >
                                      {isPending() ? "Undoing…" : "Undo"}
                                    </button>
                                  </li>
                                );
                              }}
                            </For>
                          </ul>
                        </Show>
                      </section>
                    </>
                  );
                }}
              </Show>
            </div>
          </Show>
        </span>
      )}
    </Show>
  );
};

export default PendingRewrites;
