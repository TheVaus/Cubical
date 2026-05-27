import { describe, expect, it } from "vitest";

import { scanTags, type TokenizedRun } from "./tag";

const tag = (path: string): TokenizedRun => ({ kind: "tag", path });
const text = (value: string): TokenizedRun => ({ kind: "text", value });

describe("scanTags", () => {
  it("returns empty array for empty input", () => {
    expect(scanTags("")).toEqual([]);
  });

  it("passes plain text through", () => {
    expect(scanTags("just words")).toEqual([text("just words")]);
  });

  it("recognises a simple tag at run start", () => {
    expect(scanTags("#todo")).toEqual([tag("todo")]);
  });

  it("recognises a tag after space", () => {
    expect(scanTags("a #todo b")).toEqual([
      text("a "),
      tag("todo"),
      text(" b"),
    ]);
  });

  it("does not match a hash that follows a word char", () => {
    expect(scanTags("issue#42")).toEqual([text("issue#42")]);
  });

  it("emits a nested tag as a single token", () => {
    expect(scanTags("#project/cubical")).toEqual([tag("project/cubical")]);
  });

  it("supports deeper nesting", () => {
    expect(scanTags("#a/b/c")).toEqual([tag("a/b/c")]);
  });

  it("does not include a trailing slash", () => {
    expect(scanTags("#a/")).toEqual([tag("a"), text("/")]);
  });

  it("breaks nesting on an empty segment", () => {
    expect(scanTags("#a//b")).toEqual([tag("a"), text("//b")]);
  });

  it("treats a bare hash as text", () => {
    expect(scanTags("#")).toEqual([text("#")]);
  });

  it("treats `# heading` as text", () => {
    expect(scanTags("# heading")).toEqual([text("# heading")]);
  });

  it("treats a digit-leading hash as text", () => {
    expect(scanTags("#42")).toEqual([text("#42")]);
  });

  it("allows underscore start", () => {
    expect(scanTags("#_draft")).toEqual([tag("_draft")]);
  });

  it("allows alphanumeric, underscore, and hyphen in body", () => {
    expect(scanTags("#a1_b-c")).toEqual([tag("a1_b-c")]);
  });

  it("emits multiple tags in one run", () => {
    expect(scanTags("#one #two #three")).toEqual([
      tag("one"),
      text(" "),
      tag("two"),
      text(" "),
      tag("three"),
    ]);
  });

  it("recognises a tag after newline", () => {
    expect(scanTags("first\n#tag")).toEqual([text("first\n"), tag("tag")]);
  });

  it("recognises a tag after tab", () => {
    expect(scanTags("a\t#x")).toEqual([text("a\t"), tag("x")]);
  });

  it("stops the tag at punctuation", () => {
    expect(scanTags("#todo.")).toEqual([tag("todo"), text(".")]);
  });

  it("treats `##foo` as text", () => {
    expect(scanTags("##foo")).toEqual([text("##foo")]);
  });
});
