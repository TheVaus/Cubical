// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

const queryTagPage = vi.fn();

vi.mock("../api/ipc", () => ({
  queryTagPage: (...args: unknown[]) => queryTagPage(...args),
}));

import TagPage from "./TagPage";

const flush = () => new Promise((r) => setTimeout(r, 0));
const noop = () => {};

let dispose: (() => void) | undefined;

beforeEach(() => {
  queryTagPage.mockReset();
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

const files = (path: string) => ({ files: [{ path, title: path }] });

describe("TagPage", () => {
  it("does not show the previous tag's files under a new tag", async () => {
    const [tag, setTag] = createSignal("a");
    queryTagPage.mockResolvedValueOnce(files("tagged-a.md"));
    const host = mount(() => (
      <TagPage
        vaultId="v1"
        tagPath={tag()}
        refreshSignal={0}
        onSelectFile={noop}
        onBack={noop}
      />
    ));
    await flush();
    expect(host.textContent).toContain("tagged-a.md");

    queryTagPage.mockReturnValueOnce(new Promise(() => {}));
    setTag("b");
    await flush();

    expect(host.textContent).toContain("#b");
    expect(host.textContent).not.toContain("tagged-a.md");
    expect(host.textContent).toContain("Loading…");
  });

  it("keeps the list on screen while a same-tag refresh is in flight", async () => {
    const [tick, setTick] = createSignal(0);
    queryTagPage.mockResolvedValueOnce(files("tagged-a.md"));
    const host = mount(() => (
      <TagPage
        vaultId="v1"
        tagPath="a"
        refreshSignal={tick()}
        onSelectFile={noop}
        onBack={noop}
      />
    ));
    await flush();

    queryTagPage.mockReturnValueOnce(new Promise(() => {}));
    setTick(1);
    await flush();

    expect(host.textContent).toContain("tagged-a.md");
    expect(host.textContent).not.toContain("Loading…");
  });

  it("drops a response that lands after the vault closed", async () => {
    const [vault, setVault] = createSignal<string | null>("v1");
    let release!: (v: unknown) => void;
    queryTagPage.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const host = mount(() => (
      <TagPage
        vaultId={vault()}
        tagPath="a"
        refreshSignal={0}
        onSelectFile={noop}
        onBack={noop}
      />
    ));

    setVault(null);
    release(files("tagged-a.md"));
    await flush();

    expect(host.textContent).not.toContain("tagged-a.md");
  });
});
