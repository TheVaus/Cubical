import {
  For,
  Match,
  Show,
  Switch,
  createResource,
  type JSXElement,
} from "solid-js";

import Callout from "@ds/components/feedback/Callout/Callout";

import { readFileBytes } from "../api/ipc";
import { errorMessage } from "../errorMessage";
import { base64ToText, dataUrl } from "./decode";
import { padRows, parseDelimited } from "./delimited";
import {
  delimiterForPath,
  formatBytes,
  MAX_DELIMITED_VIEWER_ROWS,
  maxBytesForKind,
  viewerKindForPath,
  type ViewerKind,
} from "./viewerKind";
import "./viewer.css";

export interface FileViewerProps {
  vaultId: string;
  path: string;
  sizeBytes: number;
  mtimeUnix: number;
}

interface Payload {
  kind: ViewerKind;
  mime: string;
  base64: string;
}

const KEY_SEP = "\u0000";

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
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

  const text = (): string => {
    if (payload.state !== "ready") return "";
    const p = payload();
    return p ? base64ToText(p.base64) : "";
  };

  const table = () => {
    const rows = padRows(parseDelimited(text(), delimiterForPath(props.path)));
    return {
      header: rows[0] ?? [],
      body: rows.slice(1, MAX_DELIMITED_VIEWER_ROWS + 1),
      truncated: Math.max(0, rows.length - 1 - MAX_DELIMITED_VIEWER_ROWS),
    };
  };

  return (
    <div class="viewer" data-viewer-kind={kind()}>
      <Show when={overSizeLimit()}>
        <div class="viewer__notice">
          <Callout tone="warning" title="Too large to preview">
            {fileName(props.path)} is {formatBytes(props.sizeBytes)}, over the{" "}
            {formatBytes(maxBytesForKind(kind()))} preview limit. The file is
            untouched on disk — open it in another app.
          </Callout>
        </div>
      </Show>

      <Show when={!overSizeLimit()}>
        <Show when={payload.loading}>
          <div class="viewer__status">Loading {fileName(props.path)}…</div>
        </Show>

        <Show when={payload.error}>
          <div class="viewer__notice">
            <Callout tone="error" title="Could not open this file">
              {errorMessage(payload.error)}
            </Callout>
          </div>
        </Show>

        <Show when={payload.state === "ready" && payload()}>
          {(p) => (
            <Switch>
              <Match when={p().kind === "image"}>
                <div class="viewer__image-stage">
                  <img
                    class="viewer__image"
                    src={dataUrl(p().mime, p().base64)}
                    alt={fileName(props.path)}
                  />
                </div>
              </Match>

              <Match when={p().kind === "text"}>
                <pre class="viewer__text">{text()}</pre>
              </Match>

              <Match when={p().kind === "delimited"}>
                <div class="viewer__table-scroll">
                  <table class="viewer__table">
                    <thead>
                      <tr>
                        <For each={table().header}>
                          {(cell) => <th>{cell}</th>}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={table().body}>
                        {(row) => (
                          <tr>
                            <For each={row}>{(cell) => <td>{cell}</td>}</For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                  <Show when={table().truncated > 0}>
                    <p class="viewer__truncated">
                      Showing the first {MAX_DELIMITED_VIEWER_ROWS} rows —{" "}
                      {table().truncated} more in the file.
                    </p>
                  </Show>
                </div>
              </Match>
            </Switch>
          )}
        </Show>
      </Show>
    </div>
  );
}

export default FileViewer;
