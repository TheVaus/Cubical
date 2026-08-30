import { Show, createEffect, createResource, type JSXElement } from "solid-js";

import Callout from "@ds/components/feedback/Callout/Callout";

import { readFileBytes } from "../api/ipc";
import { errorMessage } from "../errorMessage";
import { basename } from "../vault/noteName";
import { base64ToText } from "./decode";
import {
  renderDelimitedTable,
  renderImage,
  renderPlainText,
  replaceChildren,
} from "./render";
import {
  delimiterForPath,
  formatBytes,
  maxBytesForKind,
  supportsSourceView,
  viewerKindForPath,
  type ViewerKind,
} from "./viewerKind";
import "./viewer.css";

export interface FileViewerProps {
  vaultId: string;
  path: string;
  sizeBytes: number;
  mtimeUnix: number;
  rawSource?: boolean;
}

export interface Payload {
  kind: ViewerKind;
  mime: string;
  base64: string;
}

const KEY_SEP = "\u0000";

export function renderViewerPayload(
  payload: Payload,
  path: string,
  raw = false,
): DocumentFragment {
  if (raw && supportsSourceView(payload.kind)) {
    return renderPlainText(base64ToText(payload.base64));
  }
  switch (payload.kind) {
    case "image":
      return renderImage(payload.mime, payload.base64, basename(path));
    case "delimited":
      return renderDelimitedTable(
        base64ToText(payload.base64),
        delimiterForPath(path),
      );
    case "text":
      return renderPlainText(base64ToText(payload.base64));
    case "unsupported":
      return renderPlainText("");
  }
}

export function FileViewer(props: FileViewerProps): JSXElement {
  const kind = (): ViewerKind => viewerKindForPath(props.path);
  const overSizeLimit = (): boolean =>
    props.sizeBytes > maxBytesForKind(kind());

  const [payload] = createResource(
    () =>
      overSizeLimit()
        ? null
        : [props.mtimeUnix, props.vaultId, props.path].join(KEY_SEP),
    async (key): Promise<Payload> => {
      const parts = key.split(KEY_SEP);
      const vaultId = parts[1] ?? "";
      const path = parts[2] ?? "";
      const resp = await readFileBytes({ vault_id: vaultId, path }).catch(
        (e: unknown) => {
          throw new Error(errorMessage(e));
        },
      );
      return {
        kind: viewerKindForPath(path),
        mime: resp.mime,
        base64: resp.base64,
      };
    },
  );

  let stage: HTMLDivElement | undefined;

  const raw = (): boolean =>
    (props.rawSource ?? false) && supportsSourceView(kind());

  createEffect(() => {
    if (stage === undefined) return;
    if (payload.state !== "ready") return;
    const p = payload();
    if (p === undefined) return;
    replaceChildren(stage, renderViewerPayload(p, props.path, raw()));
  });

  return (
    <div class="viewer" data-viewer-kind={kind()} data-raw={raw() ? "" : undefined}>
      <Show when={overSizeLimit()}>
        <div class="viewer__notice">
          <Callout tone="warning" title="Too large to preview">
            {basename(props.path)} is {formatBytes(props.sizeBytes)}, over the{" "}
            {formatBytes(maxBytesForKind(kind()))} preview limit. The file is
            untouched on disk — open it in another app.
          </Callout>
        </div>
      </Show>

      <Show when={!overSizeLimit()}>
        <Show when={payload.loading}>
          <div class="viewer__status">Loading {basename(props.path)}…</div>
        </Show>

        <Show when={payload.error}>
          <div class="viewer__notice">
            <Callout tone="error" title="Could not open this file">
              {errorMessage(payload.error)}
            </Callout>
          </div>
        </Show>

        <div class="viewer__stage" ref={stage} />
      </Show>
    </div>
  );
}

export default FileViewer;
