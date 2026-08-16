import { Show, type Component } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import Modal from "@ds/components/overlay/Modal/Modal";

import type { FileActions } from "./fileActions";

export interface DeleteDialogProps {
  actions: FileActions;
}

const DeleteDialog: Component<DeleteDialogProps> = (props) => (
  <Show when={props.actions.deleteTarget()}>
    {(target) => (
      <Modal
        open={true}
        size="sm"
        placement="center"
        ariaLabel="Confirm delete"
        onClose={() => {
          if (!props.actions.deleteInFlight()) props.actions.cancelDelete();
        }}
      >
        <div
          style={{
            padding: "var(--space-4)",
            display: "flex",
            "flex-direction": "column",
            gap: "var(--space-3)",
          }}
        >
          <p
            style={{
              margin: 0,
              "font-size": "var(--text-sm)",
              color: "var(--c-fg-primary)",
            }}
          >
            {target().kind === "folder"
              ? `Delete "${target().path}" and its ${target().fileCount} file${
                  target().fileCount === 1 ? "" : "s"
                }?`
              : `Delete "${target().path}"?`}
          </p>
          <div
            style={{
              display: "flex",
              "justify-content": "flex-end",
              gap: "var(--space-2)",
            }}
          >
            <Button
              variant="secondary"
              disabled={props.actions.deleteInFlight()}
              onClick={() => props.actions.cancelDelete()}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={props.actions.deleteInFlight()}
              onClick={() => void props.actions.confirmDelete()}
            >
              {props.actions.deleteInFlight() ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </Modal>
    )}
  </Show>
);

export default DeleteDialog;
