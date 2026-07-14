import {
  createEffect,
  createSignal,
  For,
  Show,
  untrack,
  type Component,
} from "solid-js";

import Button from "@ds/components/forms/Button/Button";

import { queryTagPage, type TagPageFile } from "./api/ipc";
import { errorMessage } from "./errorMessage";

/**
 * Virtual tag-page state — what `queryTagPage` last produced for the
 * current `(vault_id, tag_path)`, plus a coarse phase to drive the UI.
 *
 * `loading` is the first-paint phase before any response has landed (we
 * deliberately do not flip back to `loading` between tag-path switches
 * — keeping the previous list visible until the new one arrives is the
 * less-jarring UX, mirroring `Backlinks`).
 */
type TagPageState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; files: TagPageFile[] }
  | { phase: "error"; message: string };

export interface TagPageProps {
  /** Vault to query; `null` when no vault is open. */
  vaultId: string | null;
  /** Tag path being viewed (no leading `#`). */
  tagPath: string;
  /**
   * Monotonic counter — bumping it forces a refetch even if vault +
   * tag haven't changed. The shell uses this on a debounced
   * `vault:file-changed` so a new note carrying the tag appears
   * without reload.
   */
  refreshSignal: number;
  /** Row click — navigates to the file in the editor view. */
  onSelectFile: (path: string) => void;
  /** "Back to editor" — exits the tag view without selecting a file. */
  onBack: () => void;
}

/**
 * Virtual tag page (L3 Session E, spec §2.5). Backed by the
 * `query_tag_page` IPC — a libSQL-backed listing of every file carrying
 * `tagPath` or any of its descendants. No backing `.md` file exists.
 *
 * Reached from a click on a tag decoration in the editor (`Editor.tsx`'s
 * `handleTagClickAtPos`) or a tag chip in `Properties`. Row clicks
 * navigate back to the editor with that file selected via the shell's
 * `handleSelectFile` seam.
 */
const TagPage: Component<TagPageProps> = (props) => {
  const [state, setState] = createSignal<TagPageState>({ phase: "idle" });

  // Same self-trigger-protection pattern as `Backlinks`: every read of
  // `state()` from inside this effect goes through `untrack` so writing
  // a fresh state object doesn't re-enter the effect. The `token`
  // closure drops late responses from superseded fetches.
  let token = 0;
  createEffect(() => {
    const vid = props.vaultId;
    const tag = props.tagPath;
    // Subscribe to refresh ticks so vault:file-changed re-runs us.
    void props.refreshSignal;

    if (!vid) {
      setState({ phase: "idle" });
      return;
    }

    const my = ++token;
    // First load: show "loading"; on refresh of an already-loaded tag,
    // leave the prior list in place to avoid a flash.
    const prior = untrack(state);
    if (prior.phase === "idle" || prior.phase === "error") {
      setState({ phase: "loading" });
    }
    queryTagPage({ vault_id: vid, tag_path: tag })
      .then((resp) => {
        if (my !== token) return;
        setState({ phase: "loaded", files: resp.files });
      })
      .catch((e) => {
        if (my !== token) return;
        const message = errorMessage(e);
        setState({ phase: "error", message });
      });
  });

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        flex: 1,
        "min-width": 0,
        "min-height": 0,
        gap: "var(--space-3)",
        padding: "var(--space-4)",
        border: "1px solid var(--c-border-subtle)",
        "border-radius": "var(--radius-md)",
        background: "var(--c-bg-secondary)",
        overflow: "auto",
      }}
    >
      <header
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: "var(--space-3)",
        }}
      >
        <h2
          style={{
            margin: 0,
            "font-size": "var(--text-xl)",
            "font-family": "var(--font-mono)",
            color: "var(--c-accent)",
          }}
        >
          #{props.tagPath}
        </h2>
        <Button variant="secondary" size="sm" onClick={props.onBack}>
          ← Back
        </Button>
      </header>

      <Show when={state().phase === "loading"}>
        <p
          style={{
            margin: 0,
            color: "var(--c-fg-muted)",
            "font-size": "var(--text-sm)",
          }}
        >
          Loading…
        </p>
      </Show>
      <Show when={state().phase === "error"}>
        <p
          role="alert"
          style={{
            margin: 0,
            color: "var(--c-error)",
            "font-size": "var(--text-sm)",
          }}
        >
          {(state() as { phase: "error"; message: string }).message}
        </p>
      </Show>
      <Show when={state().phase === "loaded"}>
        {(() => {
          const files = () =>
            (state() as { phase: "loaded"; files: TagPageFile[] }).files;
          return (
            <Show
              when={files().length > 0}
              fallback={
                <p
                  style={{
                    margin: 0,
                    color: "var(--c-fg-muted)",
                    "font-size": "var(--text-sm)",
                  }}
                >
                  No files carry this tag yet.
                </p>
              }
            >
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  "list-style": "none",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "var(--space-1)",
                }}
              >
                <For each={files()}>
                  {(file) => (
                    <li>
                      <Button
                        variant="ghost"
                        block
                        onClick={() => props.onSelectFile(file.path)}
                      >
                        <span style={{ "font-weight": "500" }}>
                          {file.title}
                        </span>
                        <span
                          style={{
                            color: "var(--c-fg-muted)",
                            "font-size": "var(--text-xs)",
                            "font-family": "var(--font-mono)",
                          }}
                        >
                          {file.path}
                        </span>
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          );
        })()}
      </Show>
    </div>
  );
};

export default TagPage;
