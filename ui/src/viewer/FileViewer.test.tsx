// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const readFileBytes = vi.fn();
vi.mock("../api/ipc", () => ({
  readFileBytes: (req: unknown) => readFileBytes(req),
}));

const { FileViewer } = await import("./FileViewer");

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  readFileBytes.mockReset();
});

function mount(el: () => unknown): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el as never, host);
  return host;
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function respond(base64: string, mime: string) {
  readFileBytes.mockResolvedValue({ base64, mime, size_bytes: base64.length });
}

describe("FileViewer", () => {
  it("renders an image as a base64 data URL", async () => {
    respond("QUJD", "image/png");
    const host = mount(() => (
      <FileViewer
        vaultId="v1"
        path="pics/gradient.png"
        sizeBytes={100}
        mtimeUnix={1}
      />
    ));
    await flush();

    const img = host.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,QUJD");
    expect(img!.getAttribute("alt")).toBe("gradient.png");
  });

  it("renders an SVG through img so its script context stays inert", async () => {
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    respond(svg, "image/svg+xml");
    const host = mount(() => (
      <FileViewer vaultId="v1" path="logo.svg" sizeBytes={50} mtimeUnix={1} />
    ));
    await flush();

    expect(host.querySelector("img")!.getAttribute("src")).toBe(
      `data:image/svg+xml;base64,${svg}`,
    );
    expect(host.querySelector("script")).toBeNull();
    expect(host.innerHTML).not.toContain("<svg");
  });

  it("renders text content verbatim", async () => {
    respond(btoa("line one\nline two"), "text/plain");
    const host = mount(() => (
      <FileViewer vaultId="v1" path="notes.txt" sizeBytes={20} mtimeUnix={1} />
    ));
    await flush();

    expect(host.querySelector(".viewer__text")!.textContent).toBe(
      "line one\nline two",
    );
  });

  it("renders a CSV as a table with a header row", async () => {
    respond(btoa('name,role\nGandalf,"Wizard, grey"'), "text/csv");
    const host = mount(() => (
      <FileViewer
        vaultId="v1"
        path="inventory.csv"
        sizeBytes={30}
        mtimeUnix={1}
      />
    ));
    await flush();

    const headers = [...host.querySelectorAll("th")].map((c) => c.textContent);
    expect(headers).toEqual(["name", "role"]);
    const cells = [...host.querySelectorAll("td")].map((c) => c.textContent);
    expect(cells).toEqual(["Gandalf", "Wizard, grey"]);
  });

  it("splits a TSV on tabs rather than commas", async () => {
    respond(btoa("a,still,one\tb"), "text/tab-separated-values");
    const host = mount(() => (
      <FileViewer vaultId="v1" path="data.tsv" sizeBytes={30} mtimeUnix={1} />
    ));
    await flush();

    expect([...host.querySelectorAll("th")].map((c) => c.textContent)).toEqual([
      "a,still,one",
      "b",
    ]);
  });

  it("refuses to read a file over the size cap", async () => {
    const host = mount(() => (
      <FileViewer
        vaultId="v1"
        path="huge.png"
        sizeBytes={26 * 1024 * 1024}
        mtimeUnix={1}
      />
    ));
    await flush();

    expect(readFileBytes).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Too large to preview");
    expect(host.textContent).toContain("26 MB");
  });

  it("applies the smaller text cap to text files", async () => {
    const host = mount(() => (
      <FileViewer
        vaultId="v1"
        path="huge.txt"
        sizeBytes={3 * 1024 * 1024}
        mtimeUnix={1}
      />
    ));
    await flush();

    expect(readFileBytes).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Too large to preview");
  });

  it("surfaces a read failure instead of rendering an empty pane", async () => {
    readFileBytes.mockRejectedValue({ message: "file not found in vault" });
    const host = mount(() => (
      <FileViewer vaultId="v1" path="gone.png" sizeBytes={10} mtimeUnix={1} />
    ));
    await flush();

    expect(host.textContent).toContain("Could not open this file");
    expect(host.textContent).toContain("file not found in vault");
  });

  it("re-reads when the file changes on disk, and not otherwise", async () => {
    const { createSignal } = await import("solid-js");
    respond("QUJD", "image/png");
    const [mtime, setMtime] = createSignal(100);
    const [size, setSize] = createSignal(10);
    mount(() => (
      <FileViewer
        vaultId="v1"
        path="gradient.png"
        sizeBytes={size()}
        mtimeUnix={mtime()}
      />
    ));
    await flush();
    expect(readFileBytes).toHaveBeenCalledTimes(1);

    setSize(11);
    await flush();
    expect(readFileBytes).toHaveBeenCalledTimes(1);

    setMtime(200);
    await flush();
    expect(readFileBytes).toHaveBeenCalledTimes(2);
  });

  it("requests the file it was given", async () => {
    respond("QUJD", "image/png");
    mount(() => (
      <FileViewer vaultId="v7" path="a/b/c.png" sizeBytes={10} mtimeUnix={1} />
    ));
    await flush();

    expect(readFileBytes).toHaveBeenCalledWith({
      vault_id: "v7",
      path: "a/b/c.png",
    });
  });
});
