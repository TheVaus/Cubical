import { dataUrl } from "./decode";
import { padRows, parseDelimited } from "./delimited";
import { MAX_DELIMITED_VIEWER_ROWS } from "./viewerKind";

export function renderPlainText(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const pre = document.createElement("pre");
  pre.className = "viewer__text";
  pre.textContent = text;
  frag.appendChild(pre);
  return frag;
}

export function renderImage(
  mime: string,
  base64: string,
  alt: string,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const stage = document.createElement("div");
  stage.className = "viewer__image-stage";
  const img = document.createElement("img");
  img.className = "viewer__image";
  img.src = dataUrl(mime, base64);
  img.alt = alt;
  stage.appendChild(img);
  frag.appendChild(stage);
  return frag;
}

export function renderDelimitedTable(
  text: string,
  delimiter: string,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const rows = padRows(parseDelimited(text, delimiter));

  const scroll = document.createElement("div");
  scroll.className = "viewer__table-scroll";

  const table = document.createElement("table");
  table.className = "viewer__table";

  const header = rows[0];
  if (header !== undefined) {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    for (const cell of header) {
      const th = document.createElement("th");
      th.textContent = cell;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
  }

  const body = rows.slice(1, MAX_DELIMITED_VIEWER_ROWS + 1);
  const tbody = document.createElement("tbody");
  for (const row of body) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);

  const truncated = Math.max(0, rows.length - 1 - MAX_DELIMITED_VIEWER_ROWS);
  if (truncated > 0) {
    const note = document.createElement("p");
    note.className = "viewer__truncated";
    note.textContent = `Showing the first ${MAX_DELIMITED_VIEWER_ROWS} rows — ${truncated} more in the file.`;
    scroll.appendChild(note);
  }

  frag.appendChild(scroll);
  return frag;
}

export function renderWarning(message: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const div = document.createElement("div");
  div.className = "viewer__inline-warning";
  div.textContent = `⚠ ${message}`;
  frag.appendChild(div);
  return frag;
}

export function replaceChildren(
  host: HTMLElement,
  content: DocumentFragment,
): void {
  while (host.firstChild !== null) host.removeChild(host.firstChild);
  host.appendChild(content);
}
