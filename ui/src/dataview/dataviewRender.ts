import type { DataviewResult, NoteRef } from "../api/ipc";

function noteLink(note: NoteRef): HTMLAnchorElement {
  const a = document.createElement("a");
  a.textContent = note.title;
  a.className = "cq-dataview-link";
  a.href = "#";
  a.setAttribute("data-path", note.path);
  return a;
}

function labelCell(note: NoteRef | null, text: string): HTMLTableCellElement {
  const td = document.createElement("td");
  if (note) td.appendChild(noteLink(note));
  else td.textContent = text;
  return td;
}

export function renderDataview(result: DataviewResult): DocumentFragment {
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
    for (const item of result.items) {
      const li = document.createElement("li");
      if (item.note) li.appendChild(noteLink(item.note));
      else li.textContent = item.text;
      ul.appendChild(li);
    }
    frag.appendChild(ul);
    return frag;
  }

  const scroll = document.createElement("div");
  scroll.className = "cq-dataview-scroll";

  const table = document.createElement("table");
  table.className = "cq-dataview-table";

  const headers =
    result.row_label === null
      ? result.columns
      : [result.row_label, ...result.columns];

  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of result.rows) {
    const tr = document.createElement("tr");
    if (result.row_label !== null) {
      tr.appendChild(labelCell(row.note, ""));
    }
    for (const cell of row.cells) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  frag.appendChild(scroll);
  return frag;
}
