/**
 * Pure DOM renderer for a Dataview query result (L4-D).
 *
 * The CodeMirror block widget is a thin host; this module builds the
 * fragment, mirroring `editor/embedRender.ts`. No markdown parsing —
 * cells render as plain text. Note links call `ctx.onOpen(path)` so the
 * renderer has no editor dependency and stays jsdom-testable in isolation.
 */
import type { DataviewResult } from "../api/ipc";

export interface RenderDataviewCtx {
  /** Invoked when a note link is clicked. */
  onOpen: (path: string) => void;
}

function noteLink(
  path: string,
  title: string,
  ctx: RenderDataviewCtx,
): HTMLAnchorElement {
  const a = document.createElement("a");
  a.textContent = title;
  a.className = "cq-dataview-link";
  a.href = "#";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.onOpen(path);
  });
  return a;
}

/**
 * Build the DOM fragment for a dataview result. The caller (the CM6
 * widget host) appends it into the editor; in tests it is appended into
 * a plain element.
 */
export function renderDataview(
  result: DataviewResult,
  ctx: RenderDataviewCtx,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (result.kind === "error") {
    const div = document.createElement("div");
    div.className = "cq-dataview-error";
    div.textContent = `⚠ ${result.message}`;
    frag.appendChild(div);
    return frag;
  }

  if (result.kind === "count") {
    const div = document.createElement("div");
    div.className = "cq-dataview-count";
    div.textContent = String(result.count);
    frag.appendChild(div);
    return frag;
  }

  if (result.kind === "list") {
    const ul = document.createElement("ul");
    ul.className = "cq-dataview-list";
    for (const n of result.notes) {
      const li = document.createElement("li");
      li.appendChild(noteLink(n.path, n.title, ctx));
      ul.appendChild(li);
    }
    frag.appendChild(ul);
    return frag;
  }

  // table
  const table = document.createElement("table");
  table.className = "cq-dataview-table";

  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const h of ["File", ...result.columns]) {
    const th = document.createElement("th");
    th.textContent = h;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of result.rows) {
    const tr = document.createElement("tr");
    const fileTd = document.createElement("td");
    fileTd.appendChild(noteLink(row.note.path, row.note.title, ctx));
    tr.appendChild(fileTd);
    for (const cell of row.cells) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  frag.appendChild(table);
  return frag;
}
