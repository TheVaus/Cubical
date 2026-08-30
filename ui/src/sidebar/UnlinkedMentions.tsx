import {
  createEffect,
  createSignal,
  For,
  Show,
  untrack,
  type Component,
} from "solid-js";

import Button from "@ds/components/forms/Button/Button";

import {
  getUnlinkedMentions,
  linkMention,
  type Mention,
} from "../api/ipc";
import { noteTitle } from "../vault/noteName";
import { errorMessage } from "../errorMessage";
import {
  mentionKey,
  reduceMentionsState,
  type MentionsViewState,
} from "./unlinkedMentionsState";
import { createTargetTracker } from "./refreshTarget";

export interface UnlinkedMentionsProps {
  vaultId: string | null;
  path: string | null;
  refreshSignal: number;
  onRowClick: (path: string) => void;
}

const UnlinkedMentions: Component<UnlinkedMentionsProps> = (props) => {
  const [state, setState] = createSignal<MentionsViewState>({ kind: "idle" });
  const [pending, setPending] = createSignal<string | null>(null);
  const [linkError, setLinkError] = createSignal<{
    key: string;
    message: string;
  } | null>(null);

  let token = 0;
  const tracker = createTargetTracker();
  createEffect(() => {
    const vid = props.vaultId;
    const p = props.path;
    void props.refreshSignal;

    if (!vid || !p) {
      setState(reduceMentionsState(untrack(state), { type: "file:cleared" }));
      return;
    }

    const my = ++token;
    setState(reduceMentionsState(untrack(state), tracker.start(vid, p)));
    getUnlinkedMentions({ vault_id: vid, path: p })
      .then((resp) => {
        if (my !== token) return;
        setState(
          reduceMentionsState(untrack(state), {
            type: "fetch:success",
            mentions: resp.mentions,
          }),
        );
      })
      .catch((e: unknown) => {
        if (my !== token) return;
        const message = errorMessage(e);
        setState(
          reduceMentionsState(untrack(state), { type: "fetch:error", message }),
        );
      });
  });

  const handleLink = async (m: Mention) => {
    const vid = props.vaultId;
    const openPath = props.path;
    if (!vid || !openPath) return;
    const k = mentionKey(m);
    setLinkError(null);
    setPending(k);
    try {
      await linkMention({
        vault_id: vid,
        source_path: m.source_path,
        position: m.position,
        byte_len: m.byte_len,
        target_title: noteTitle(openPath),
      });
      setState(
        reduceMentionsState(untrack(state), { type: "mention:linked", key: k }),
      );
    } catch (e) {
      const message = errorMessage(e);
      setLinkError({ key: k, message });
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      aria-label="Unlinked Mentions"
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
        Unlinked Mentions
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
            Select a note to see its unlinked mentions.
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
            Scanning…
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
            No unlinked mentions.
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
                <For each={s.mentions}>
                  {(m) => {
                    const k = mentionKey(m);
                    const isPending = () => pending() === k;
                    return (
                      <li
                        role="listitem"
                        data-key={k}
                        style={{
                          display: "flex",
                          "flex-direction": "column",
                          gap: "var(--space-1)",
                          padding: "var(--space-2) var(--space-3)",
                          border: "1px solid var(--c-border-subtle)",
                          "border-radius": "var(--radius-sm, var(--radius-md))",
                          background: "var(--c-bg-secondary)",
                        }}
                      >
                        <span
                          onClick={() => props.onRowClick(m.source_path)}
                          title={m.source_path}
                          style={{
                            "font-size": "var(--text-sm)",
                            "font-family": "var(--font-body)",
                            color: "var(--c-fg-primary)",
                            cursor: "pointer",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {noteTitle(m.source_path)}
                        </span>
                        <span
                          style={{
                            "font-size": "var(--text-xs)",
                            "font-family": "var(--font-mono)",
                            color: "var(--c-fg-secondary)",
                            "line-height": "var(--leading-base)",
                          }}
                        >
                          {m.context || "—"}
                        </span>
                        <Show when={linkError()?.key === k}>
                          <span
                            role="alert"
                            style={{
                              margin: 0,
                              color: "var(--c-error)",
                              "font-size": "var(--text-xs)",
                            }}
                          >
                            {linkError()!.message}
                          </span>
                        </Show>
                        <div
                          style={{ display: "flex", "justify-content": "flex-end" }}
                        >
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={isPending()}
                            ariaLabel={`Link this mention to ${
                              noteTitle(props.path ?? "") ||
                              "the open note"
                            }`}
                            onClick={() => void handleLink(m)}
                          >
                            {isPending() ? "Linking…" : "Link it"}
                          </Button>
                        </div>
                      </li>
                    );
                  }}
                </For>
              </ul>
            );
          }}
        </Show>
      </Show>
    </section>
  );
};

export default UnlinkedMentions;
