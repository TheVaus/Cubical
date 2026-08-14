export function parseDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === "") {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r" && input[i + 1] === "\n") {
      endRow();
      i += 2;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endRow();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (field !== "" || row.length > 0) endRow();
  return rows;
}

export function padRows(rows: string[][]): string[][] {
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  return rows.map((r) =>
    r.length === width
      ? r
      : [...r, ...Array<string>(width - r.length).fill("")],
  );
}
