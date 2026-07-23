import type {
  PendingRewriteBreakdownRow,
  RecentRenameOp,
} from "../api/ipc";

export type PendingRewritesPopoverState =
  | { kind: "closed" }
  | { kind: "loading" }
  | {
      kind: "loaded";
      breakdown: PendingRewriteBreakdownRow[];
      ops: RecentRenameOp[];
    }
  | { kind: "error"; message: string };

export type PendingRewritesPopoverAction =
  | { type: "open" }
  | {
      type: "fetch:success";
      breakdown: PendingRewriteBreakdownRow[];
      ops: RecentRenameOp[];
    }
  | { type: "fetch:error"; message: string }
  | { type: "close" };

export function reducePendingRewritesPopover(
  state: PendingRewritesPopoverState,
  action: PendingRewritesPopoverAction,
): PendingRewritesPopoverState {
  switch (action.type) {
    case "open":
      return { kind: "loading" };
    case "fetch:success":
      return {
        kind: "loaded",
        breakdown: action.breakdown,
        ops: action.ops,
      };
    case "fetch:error":
      return { kind: "error", message: action.message };
    case "close":
      return { kind: "closed" };
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

export function renameOpKey(op: RecentRenameOp): string {
  return `op-${op.rename_op_id}`;
}

export function breakdownKey(row: PendingRewriteBreakdownRow): string {
  return `bd-${row.target_file}`;
}
