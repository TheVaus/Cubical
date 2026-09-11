import { Channel } from "@tauri-apps/api/core";

import { invoke } from "./transport";

export type GraphNodeKind = "note" | "attachment" | "ghost" | "tag";

export type GraphEdgeKind = "link" | "embed" | "ghost" | "tag";

export interface GraphNode {
  id: number;
  kind: GraphNodeKind;
  key: string;
  label: string;
}

export interface GraphEdge {
  source: number;
  target: number;
  kind: GraphEdgeKind;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphFilter {
  kinds?: GraphNodeKind[];
  pathPrefix?: string;
}

export interface LayoutFrame {
  iteration: number;
  positions: number[];
}

export interface LayoutComplete {
  iterations: number;
  positions: number[];
}

export function graphSnapshot(
  vaultId: string,
  filter: GraphFilter = {},
): Promise<GraphSnapshot> {
  return invoke<GraphSnapshot>("graph_snapshot", {
    req: { vaultId, filter },
  });
}

export function graphLayout(
  vaultId: string,
  snapshot: GraphSnapshot,
  onFrame: (frame: LayoutFrame) => void,
  opts: { seed?: number; iterations?: number } = {},
): Promise<LayoutComplete> {
  const channel = new Channel<LayoutFrame>();
  channel.onmessage = onFrame;
  return invoke<LayoutComplete>("graph_layout", {
    req: {
      vaultId,
      snapshot,
      seed: opts.seed ?? null,
      iterations: opts.iterations ?? null,
    },
    onFrame: channel,
  });
}

export function graphLayoutCancel(vaultId: string): Promise<void> {
  return invoke("graph_layout_cancel", { req: { vaultId } });
}
