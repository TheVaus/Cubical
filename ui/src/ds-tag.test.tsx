// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render } from "solid-js/web";
import Tag from "@ds/components/data/Tag/Tag";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host;
}

describe("Tag", () => {
  it("renders the label verbatim with no leading #", () => {
    const host = mount(() => <Tag label="design" />);
    expect(host.textContent).toContain("design");
    expect(host.textContent).not.toContain("#design");
  });

  it("applies ds-tag--tag when tag is true, and omits it otherwise", () => {
    const tagged = mount(() => <Tag label="design" tag />);
    expect(tagged.querySelector(".ds-tag")!.classList.contains("ds-tag--tag")).toBe(true);
    dispose?.();

    const plain = mount(() => <Tag label="draft" />);
    expect(plain.querySelector(".ds-tag")!.classList.contains("ds-tag--tag")).toBe(false);
  });

  it("renders the label as a button and fires onClick when onClick is set", () => {
    let clicked = 0;
    const host = mount(() => (
      <Tag label="design" onClick={() => { clicked += 1; }} />
    ));
    const button = host.querySelector(".ds-tag__label") as HTMLElement;
    expect(button.tagName).toBe("BUTTON");
    button.click();
    expect(clicked).toBe(1);
  });

  it("renders the label as static (non-button) text when onClick is absent", () => {
    const host = mount(() => <Tag label="design" />);
    const label = host.querySelector(".ds-tag__label") as HTMLElement;
    expect(label.tagName).not.toBe("BUTTON");
  });

  it("renders a remove control that fires onRemove when set, and omits it otherwise", () => {
    let removed = 0;
    const host = mount(() => (
      <Tag label="design" onRemove={() => { removed += 1; }} />
    ));
    const buttons = host.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    (buttons[0] as HTMLElement).click();
    expect(removed).toBe(1);
    dispose?.();

    const noRemove = mount(() => <Tag label="design" />);
    expect(noRemove.querySelectorAll("button").length).toBe(0);
  });

  it("renders an edit control that fires onEdit when set, and omits it otherwise", () => {
    let edited = 0;
    const host = mount(() => (
      <Tag label="design" onEdit={() => { edited += 1; }} />
    ));
    const buttons = host.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    (buttons[0] as HTMLElement).click();
    expect(edited).toBe(1);
    dispose?.();

    const noEdit = mount(() => <Tag label="design" />);
    expect(noEdit.querySelectorAll("button").length).toBe(0);
  });

  it("hosts label + edit + remove together as three controls in one pill", () => {
    let clicked = 0;
    let edited = 0;
    let removed = 0;
    const host = mount(() => (
      <Tag
        label="design"
        tag
        onClick={() => { clicked += 1; }}
        onEdit={() => { edited += 1; }}
        onRemove={() => { removed += 1; }}
      />
    ));
    const pill = host.querySelector(".ds-tag")!;
    const buttons = pill.querySelectorAll("button");
    expect(buttons.length).toBe(3);
    (buttons[0] as HTMLElement).click();
    (buttons[1] as HTMLElement).click();
    (buttons[2] as HTMLElement).click();
    expect(clicked).toBe(1);
    expect(edited).toBe(1);
    expect(removed).toBe(1);
  });
});
