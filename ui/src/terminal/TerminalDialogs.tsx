import { Show, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import Modal from "@ds/components/overlay/Modal/Modal";

import type { ConsentPrompt } from "./wiring";

export function TerminalConsentDialog(props: {
  prompt: () => ConsentPrompt | null;
  onAccept: () => void;
  onDecline: () => void;
}): JSXElement {
  return (
    <Show when={props.prompt()}>
      {(prompt) => (
        <Modal
          open={true}
          size="sm"
          placement="center"
          title="Help AI CLIs understand this vault?"
          onClose={props.onDecline}
        >
          <div class="terminal-dialog">
            <p class="terminal-dialog__body">
              Cubical can create <code>AGENTS.md</code> and{" "}
              <code>CLAUDE.md</code> at your vault root, each a one-line pointer
              to <code>{prompt().status.canonical_path}</code>. AI CLIs read
              them from the working directory, so they only work at the root.
              They are yours to edit or delete, and Cubical never rewrites them.
            </p>
            <div class="terminal-dialog__actions">
              <Button variant="secondary" onClick={props.onDecline}>
                No, leave my vault alone
              </Button>
              <Button variant="primary" onClick={props.onAccept}>
                Create them
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Show>
  );
}

export function TerminalCloseDialog(props: {
  tabId: () => string | null;
  onAnswer: (proceed: boolean) => void;
}): JSXElement {
  return (
    <Show when={props.tabId() !== null}>
      <Modal
        open={true}
        size="sm"
        placement="center"
        title="Something is still running"
        onClose={() => props.onAnswer(false)}
      >
        <div class="terminal-dialog">
          <p class="terminal-dialog__body">
            This terminal has a command running in the foreground. Closing the
            tab ends it.
          </p>
          <div class="terminal-dialog__actions">
            <Button variant="secondary" onClick={() => props.onAnswer(false)}>
              Keep it open
            </Button>
            <Button variant="danger" onClick={() => props.onAnswer(true)}>
              Close anyway
            </Button>
          </div>
        </div>
      </Modal>
    </Show>
  );
}
