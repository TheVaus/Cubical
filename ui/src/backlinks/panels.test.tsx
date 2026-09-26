// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import type { Mention } from "../api/mentions";

const getBacklinks = vi.fn();
const getUnlinkedMentions = vi.fn();
const linkMention = vi.fn();

vi.mock("../api/ipc", () => ({
  getBacklinks: (...args: unknown[]) => getBacklinks(...args),
}));
vi.mock("../api/mentions", () => ({
  getUnlinkedMentions: (...args: unknown[]) => getUnlinkedMentions(...args),
  linkMention: (...args: unknown[]) => linkMention(...args),
}));

import Backlinks from "./Backlinks";
import UnlinkedMentions from "./UnlinkedMentions";

const flush = () => new Promise((r) => setTimeout(r, 0));
const noop = () => {};

let dispose: (() => void) | undefined;

beforeEach(() => {
  getBacklinks.mockReset();
  getUnlinkedMentions.mockReset();
  linkMention.mockReset();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function mount(el: () => unknown) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el as never, host);
  return host;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mention = (source_path: string, position: number): Mention => ({
  source_path,
  position,
  byte_len: 4,
  context: `mentions plan in ${source_path}`,
  needle: "plan",
});

describe("Backlinks — responses outliving their target", () => {
  it("drops a response that lands after the note was closed", async () => {
    const [path, setPath] = createSignal<string | null>("a.md");
    const pending = deferred<unknown>();
    getBacklinks.mockReturnValueOnce(pending.promise);
    const host = mount(() => (
      <Backlinks vaultId="v1" path={path()} refreshSignal={0} onRowClick={noop} />
    ));

    setPath(null);
    pending.resolve({
      backlinks: [{ source_path: "src.md", context: "see [[a]]", position: 4 }],
    });
    await flush();

    expect(host.textContent).toContain("Select a note");
    expect(host.textContent).not.toContain("see [[a]]");
  });
});

describe("UnlinkedMentions — responses outliving their target", () => {
  it("drops a response that lands after the note was closed", async () => {
    const [path, setPath] = createSignal<string | null>("a.md");
    const pending = deferred<unknown>();
    getUnlinkedMentions.mockReturnValueOnce(pending.promise);
    const host = mount(() => (
      <UnlinkedMentions
        vaultId="v1"
        path={path()}
        refreshSignal={0}
        onRowClick={noop}
      />
    ));

    setPath(null);
    pending.resolve({ mentions: [mention("src.md", 4)] });
    await flush();

    expect(host.textContent).toContain("Select a note");
    expect(host.textContent).not.toContain("src.md");
  });

  it("does not apply a finished link to the note opened since", async () => {
    const [path, setPath] = createSignal("a.md");
    getUnlinkedMentions.mockResolvedValueOnce({
      mentions: [mention("src.md", 4)],
    });
    const host = mount(() => (
      <UnlinkedMentions
        vaultId="v1"
        path={path()}
        refreshSignal={0}
        onRowClick={noop}
      />
    ));
    await flush();

    const link = deferred<unknown>();
    linkMention.mockReturnValueOnce(link.promise);
    host
      .querySelector('[aria-label="Link this mention to a"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    getUnlinkedMentions.mockResolvedValueOnce({
      mentions: [mention("src.md", 10)],
    });
    setPath("b.md");
    await flush();

    link.resolve({});
    await flush();

    expect(host.querySelector('[data-key="src.md@10"]')).not.toBeNull();
  });

  it("does not show a link failure against the note opened since", async () => {
    const [path, setPath] = createSignal("a.md");
    getUnlinkedMentions.mockResolvedValue({ mentions: [mention("src.md", 4)] });
    const host = mount(() => (
      <UnlinkedMentions
        vaultId="v1"
        path={path()}
        refreshSignal={0}
        onRowClick={noop}
      />
    ));
    await flush();

    const link = deferred<unknown>();
    linkMention.mockReturnValueOnce(link.promise);
    host
      .querySelector('[aria-label="Link this mention to a"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    setPath("b.md");
    await flush();
    link.reject(new Error("write failed"));
    await flush();

    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
