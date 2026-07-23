import type { DataviewResult } from "../api/ipc";

function noteLink(path: string, title: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.textContent = title;
  a.className = "cq-dataview-link";
  a.href = "#";
  a.setAttribute("data-path", path);
  return a;
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
    for (const n of result.notes) {
      const li = document.createElement("li");
      li.appendChild(noteLink(n.path, n.title));
      ul.appendChild(li);
    }
    frag.appendChild(ul);
    return frag;
  }

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
    fileTd.appendChild(noteLink(row.note.path, row.note.title));
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
