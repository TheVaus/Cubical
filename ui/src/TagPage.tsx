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

type TagPageState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; files: TagPageFile[] }
  | { phase: "error"; message: string };

export interface TagPageProps {
  vaultId: string | null;
  tagPath: string;
  refreshSignal: number;
  onSelectFile: (path: string) => void;
  onBack: () => void;
}

const TagPage: Component<TagPageProps> = (props) => {
  const [state, setState] = createSignal<TagPageState>({ phase: "idle" });

  let token = 0;
  createEffect(() => {
    const vid = props.vaultId;
    const tag = props.tagPath;
    void props.refreshSignal;

    if (!vid) {
      setState({ phase: "idle" });
      return;
    }

    const my = ++token;
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
