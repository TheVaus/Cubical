import { createEffect, createSignal, For, Show, untrack, type Component } from "solid-js";

import Badge from "@ds/components/feedback/Badge/Badge";
import Button from "@ds/components/forms/Button/Button";
import Icon from "@ds/components/graphics/Icon/Icon";
import Popover from "@ds/components/overlay/Popover/Popover";

import {
  listDanglingLinks,
  repairDanglingLink,
  type DanglingLinkGroup,
  type RepairCandidate,
} from "../api/ipc";
import { errorMessage } from "../errorMessage";
import {
  candidateKey,
  candidateRankLabel,
  occurrenceSummary,
  reattachActionLabel,
  reduceIntegrityState,
  type IntegrityViewState,
} from "./integrityState";

export interface IntegrityPanelProps {
  vaultId: string | null;
  refreshSignal: number;
  onRowClick: (path: string) => void;
  onRepaired?: (group: DanglingLinkGroup, candidate: RepairCandidate) => void;
}

const IntegrityPanel: Component<IntegrityPanelProps> = (props) => {
  const [state, setState] = createSignal<IntegrityViewState>({ kind: "idle" });
  const [openGroup, setOpenGroup] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);

  let token = 0;

  const load = (vaultId: string) => {
    const my = ++token;
    setState(reduceIntegrityState(untrack(state), { type: "fetch:start" }));
    listDanglingLinks({ vault_id: vaultId })
      .then((resp) => {
        if (my !== token) return;
        setState(
          reduceIntegrityState(untrack(state), {
            type: "fetch:success",
            groups: resp.groups,
            truncated: resp.truncated,
          }),
        );
      })
      .catch((e: unknown) => {
        if (my !== token) return;
        setState(
          reduceIntegrityState(untrack(state), {
            type: "fetch:error",
            message: errorMessage(e),
          }),
        );
      });
  };

  createEffect(() => {
    const vid = props.vaultId;
    void props.refreshSignal;
    if (!vid) {
      setState(reduceIntegrityState(untrack(state), { type: "vault:cleared" }));
      return;
    }
    load(vid);
  });

  const reattach = async (
    group: DanglingLinkGroup,
    candidate: RepairCandidate,
  ) => {
    const vid = props.vaultId;
    if (!vid) return;
    setBusy(candidateKey(group, candidate));
    try {
      await repairDanglingLink({
        vault_id: vid,
        target_raw: group.target_raw,
        to_path: candidate.path,
      });
      setOpenGroup(null);
      props.onRepaired?.(group, candidate);
      load(vid);
    } catch (e: unknown) {
      setState(
        reduceIntegrityState(untrack(state), {
          type: "fetch:error",
          message: errorMessage(e),
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-label="Link integrity"
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
        Link integrity
      </header>

      <Show when={state().kind === "idle"}>
        <Muted>Open a vault to check link integrity.</Muted>
      </Show>
      <Show when={state().kind === "loading"}>
        <Muted>Loading…</Muted>
      </Show>
      <Show when={state().kind === "empty"}>
        <Muted>No dangling links.</Muted>
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
              <Show when={s.truncated}>
                <Muted>Showing the most-referenced groups only.</Muted>
              </Show>
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
                <For each={s.groups}>
                  {(group) => (
                    <GroupCard
                      group={group}
                      open={openGroup() === group.target_raw}
                      busyKey={busy()}
                      onToggle={() =>
                        setOpenGroup((cur) =>
                          cur === group.target_raw ? null : group.target_raw,
                        )
                      }
                      onClose={() => setOpenGroup(null)}
                      onOpenSource={props.onRowClick}
                      onPick={(candidate) => void reattach(group, candidate)}
                    />
                  )}
                </For>
              </ul>
            </>
          );
        }}
      </Show>
    </section>
  );
};

const Muted: Component<{ children: string }> = (props) => (
  <p
    style={{
      margin: 0,
      color: "var(--c-fg-muted)",
      "font-size": "var(--text-xs)",
    }}
  >
    {props.children}
  </p>
);

const GroupCard: Component<{
  group: DanglingLinkGroup;
  open: boolean;
  busyKey: string | null;
  onToggle: () => void;
  onClose: () => void;
  onOpenSource: (path: string) => void;
  onPick: (candidate: RepairCandidate) => void;
}> = (props) => (
  <li
    role="listitem"
    data-key={props.group.target_raw}
    style={{
      display: "flex",
      "flex-direction": "column",
      gap: "var(--space-1)",
      padding: "var(--space-2) var(--space-3)",
      border: "1px solid var(--c-border-subtle)",
      "border-radius": "var(--radius-sm, var(--radius-md))",
      background: "var(--c-bg-secondary)",
      "min-width": 0,
    }}
  >
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "var(--space-2)",
        "min-width": 0,
      }}
    >
      <Icon name="link" size={14} />
      <span
        style={{
          flex: 1,
          "min-width": 0,
          "font-family": "var(--font-mono)",
          "font-size": "var(--text-sm)",
          color: "var(--c-fg-primary)",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
        title={`[[${props.group.target_raw}]]`}
      >
        [[{props.group.target_raw}]]
      </span>
      <Badge tone="warning">{occurrenceSummary(props.group)}</Badge>
    </div>

    <Show when={props.group.missing_path}>
      {(missing) => (
        <span
          style={{
            "font-size": "var(--text-xs)",
            "font-family": "var(--font-mono)",
            color: "var(--c-fg-secondary)",
          }}
        >
          was {missing()}
        </span>
      )}
    </Show>

    <ul
      role="list"
      aria-label={`Notes linking to ${props.group.target_raw}`}
      style={{ margin: 0, padding: 0, "list-style": "none", "min-width": 0 }}
    >
      <For each={props.group.occurrences}>
        {(occurrence) => (
          <li style={{ "min-width": 0 }}>
            <button
              type="button"
              onClick={() => props.onOpenSource(occurrence.source_path)}
              title={occurrence.source_path}
              style={{
                width: "100%",
                "text-align": "left",
                "font-size": "var(--text-xs)",
                "font-family": "var(--font-mono)",
                color: "var(--c-fg-secondary)",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
            >
              {occurrence.source_path}
            </button>
          </li>
        )}
      </For>
    </ul>

    <div style={{ position: "relative", "min-width": 0 }}>
      <Button
        size="sm"
        variant="secondary"
        fullWidth
        disabled={props.group.candidates.length === 0}
        ariaExpanded={props.open}
        title={
          props.group.candidates.length === 0
            ? "No repair candidate found — link to the note by hand"
            : `Reattach [[${props.group.target_raw}]] to a file you choose`
        }
        onClick={props.onToggle}
      >
        Reattach to…
      </Button>
      <Popover
        open={props.open}
        onClose={props.onClose}
        ariaLabel={`Reattach [[${props.group.target_raw}]]`}
        placement="bottom-start"
      >
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "var(--space-1)",
            padding: "var(--space-2)",
            "min-width": "14rem",
          }}
        >
          <span
            style={{
              "font-size": "var(--text-xs)",
              color: "var(--c-fg-muted)",
            }}
          >
            Rewrites every referring note. Pick the file this link meant.
          </span>
          <For each={props.group.candidates}>
            {(candidate) => (
              <Button
                size="sm"
                variant="secondary"
                fullWidth
                disabled={
                  props.busyKey === candidateKey(props.group, candidate)
                }
                ariaLabel={reattachActionLabel(props.group, candidate)}
                onClick={() => props.onPick(candidate)}
              >
                <span
                  style={{
                    display: "flex",
                    "flex-direction": "column",
                    "align-items": "flex-start",
                    gap: "2px",
                    "min-width": 0,
                  }}
                >
                  <span style={{ "font-family": "var(--font-mono)" }}>
                    {candidate.path}
                  </span>
                  <span style={{ color: "var(--c-fg-muted)" }}>
                    {candidateRankLabel(candidate.rank)}
                  </span>
                </span>
              </Button>
            )}
          </For>
        </div>
      </Popover>
    </div>
  </li>
);

export default IntegrityPanel;
