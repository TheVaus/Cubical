import { describe, expect, it } from "vitest";
import {
  delimiterForPath,
  extensionOf,
  formatBytes,
  hasViewer,
  isEditableText,
  MAX_IMAGE_VIEWER_BYTES,
  MAX_TEXT_VIEWER_BYTES,
  maxBytesForKind,
  supportsSourceView,
  viewerKindForPath,
} from "./viewerKind";

describe("extensionOf", () => {
  it("lowercases the extension", () => {
    expect(extensionOf("Photo.PNG")).toBe("png");
  });

  it("uses the last dot", () => {
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  it("ignores dots in parent folders", () => {
    expect(extensionOf("my.folder/README")).toBe("");
  });

  it("treats a dotfile as having no extension", () => {
    expect(extensionOf(".gitignore")).toBe("");
  });

  it("returns empty for a bare name", () => {
    expect(extensionOf("LICENSE")).toBe("");
  });
});

describe("viewerKindForPath", () => {
  it("maps image extensions", () => {
    for (const p of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.svg"]) {
      expect(viewerKindForPath(p)).toBe("image");
    }
  });

  it("maps text extensions", () => {
    for (const p of ["a.txt", "a.text", "a.log"]) {
      expect(viewerKindForPath(p)).toBe("text");
    }
  });

  it("maps delimited extensions", () => {
    expect(viewerKindForPath("a.csv")).toBe("delimited");
    expect(viewerKindForPath("a.tsv")).toBe("delimited");
  });

  it("is case-insensitive", () => {
    expect(viewerKindForPath("nested/dir/Photo.JPEG")).toBe("image");
  });

  it("returns unsupported for formats with no viewer", () => {
    for (const p of ["a.pdf", "a.docx", "a.xlsx", "a.zip", "noext"]) {
      expect(viewerKindForPath(p)).toBe("unsupported");
    }
  });

  it("reports markdown as unsupported so the editor keeps owning it", () => {
    expect(viewerKindForPath("note.md")).toBe("unsupported");
    expect(hasViewer("note.md")).toBe(false);
  });
});

describe("delimiterForPath", () => {
  it("uses a tab for tsv and a comma otherwise", () => {
    expect(delimiterForPath("a.tsv")).toBe("\t");
    expect(delimiterForPath("a.csv")).toBe(",");
  });
});

describe("maxBytesForKind", () => {
  it("allows images to be larger than text", () => {
    expect(maxBytesForKind("image")).toBe(MAX_IMAGE_VIEWER_BYTES);
    expect(maxBytesForKind("text")).toBe(MAX_TEXT_VIEWER_BYTES);
    expect(maxBytesForKind("delimited")).toBe(MAX_TEXT_VIEWER_BYTES);
    expect(MAX_IMAGE_VIEWER_BYTES).toBeGreaterThan(MAX_TEXT_VIEWER_BYTES);
  });
});

describe("formatBytes", () => {
  it("formats across units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
  });
});

describe("isEditableText", () => {
  it("admits the plain-text extensions the engine will write back", () => {
    expect(isEditableText("notes.txt")).toBe(true);
    expect(isEditableText("a/b/run.LOG")).toBe(true);
    expect(isEditableText("readme.text")).toBe(true);
  });

  it("excludes delimited files, which have a viewer but no editor", () => {
    expect(isEditableText("data.csv")).toBe(false);
    expect(isEditableText("data.tsv")).toBe(false);
  });

  it("excludes images, markdown and unknown types", () => {
    expect(isEditableText("photo.png")).toBe(false);
    expect(isEditableText("note.md")).toBe(false);
    expect(isEditableText("archive.tar.gz")).toBe(false);
    expect(isEditableText("LICENSE")).toBe(false);
  });
});

describe("supportsSourceView", () => {
  it("is true for text and delimited, false for image and unsupported", () => {
    expect(supportsSourceView("text")).toBe(true);
    expect(supportsSourceView("delimited")).toBe(true);
    expect(supportsSourceView("image")).toBe(false);
    expect(supportsSourceView("unsupported")).toBe(false);
  });
});
