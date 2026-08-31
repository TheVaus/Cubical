import { For, Show } from "solid-js";

import Select from "@ds/components/forms/Select/Select";
import TextInput from "@ds/components/forms/TextInput/TextInput";

import { DATE_FORMAT_TOKENS } from "../../properties/dateFormats";
import { CURRENCY_CODES } from "../../properties/format";
import InfoButton, { type InfoControl } from "../InfoButton";
import OnOffControl from "../OnOffControl";
import type { SettingsState } from "../settingsState";

const TYPE_TOKENS: [string, string][] = [
  ["# type:text", "Text."],
  ["# type:int", "Whole number."],
  ["# type:float", "Decimal number."],
  [
    "# type:float/currency/usd",
    "Currency — usd · nis · eur (symbol only; value stays a number).",
  ],
  ["# type:boolean", "True / false toggle."],
  ["# type:enum(alive,dead)", "One of a fixed set of values."],
  [
    "# type:date",
    "A date. Formats: YYYY-MM-DD, YYYY-MM-DD HH:MM, YYYY, DD-MM-YYYY, MM/DD/YYYY, … — e.g. # type:date:DD-MM-YY.",
  ],
  [
    "# type:list",
    "A list of strings; items starting with # become clickable tags.",
  ],
];

const EXAMPLE_FRONTMATTER = `---
name: Ann       # type:text
price: 9.99     # type:float/currency/eur
status: alive   # type:enum(alive,dead)
meeting: 2026-06-17 14:30  # type:date:YYYY-MM-DD HH:MM
topics:         # type:list
  - "#draft"
---`;

const EditorPane = (props: { settings: SettingsState; info: InfoControl }) => (
  <>
    <h2 class="set-h2">Editor</h2>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Open notes in raw source by default</div>
        <div class="set-row__desc">Otherwise notes open in Live Preview.</div>
      </div>
      <OnOffControl
        value={props.settings.rawDefault()}
        onChange={props.settings.setRawDefaultValue}
      />
    </div>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Minimap</div>
        <div class="set-row__desc">
          Show a document overview strip beside the editor.
        </div>
      </div>
      <OnOffControl
        value={props.settings.minimapEnabled()}
        onChange={props.settings.setMinimapEnabledValue}
      />
    </div>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Live editor tabs</div>
        <div class="set-row__desc">
          How many open tabs keep a live editor. Tabs beyond this reload from
          disk when you return to them.
        </div>
      </div>
      <TextInput
        class="set-row__num"
        type="number"
        min={1}
        step={1}
        value={String(props.settings.liveTabLimit())}
        onChange={(v) => props.settings.setLiveTabLimitValue(Number(v))}
      />
    </div>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Colorize raw source</div>
        <div class="set-row__desc">
          In Raw Source mode, tint wiki-links, links and tags with rendered-mode
          colors. Nothing is hidden or rendered — only colors change.
        </div>
      </div>
      <OnOffControl
        value={props.settings.colorizeSource()}
        onChange={props.settings.setColorizeSourceValue}
      />
    </div>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Typed properties</div>
        <div class="set-row__desc">
          Give frontmatter properties a type (number, currency, date &amp; time,
          list, …) for type-aware editors.
        </div>
      </div>
      <div class="set-row__control">
        <InfoButton id="typed-props" info={props.info}>
          <p style={{ margin: "0 0 var(--space-1) 0" }}>
            <strong>How it works.</strong> Pick a type from the <code>▾</code>{" "}
            menu on any property row. The Properties panel then shows the right
            editor — a <code>$</code> field for currency, a date picker, a
            dropdown for an enum, and so on. The type is saved as a plain
            comment <em>inside the note</em>, so it travels with the file and any
            tool can read it. Nothing is stored outside the vault.
          </p>

          <div
            style={{
              display: "grid",
              "grid-template-columns": "auto 1fr",
              "column-gap": "var(--space-2)",
              "row-gap": "var(--space-1)",
              "align-items": "baseline",
              margin: "var(--space-2) 0",
            }}
          >
            <For each={TYPE_TOKENS}>
              {([token, desc]) => (
                <>
                  <code
                    style={{
                      "font-family": "var(--font-mono)",
                      "font-size": "var(--text-xs)",
                      color: "var(--c-accent)",
                      "white-space": "nowrap",
                    }}
                  >
                    {token}
                  </code>
                  <span style={{ "font-size": "var(--text-xs)" }}>{desc}</span>
                </>
              )}
            </For>
          </div>

          <p style={{ margin: "0 0 var(--space-1) 0" }}>Example frontmatter:</p>
          <pre
            style={{
              margin: "0 0 var(--space-1) 0",
              padding: "var(--space-2)",
              "font-family": "var(--font-mono)",
              "font-size": "var(--text-xs)",
              background: "var(--c-bg-primary)",
              border: "1px solid var(--c-border-subtle)",
              "border-radius": "var(--radius-sm)",
              "white-space": "pre-wrap",
            }}
          >
            {EXAMPLE_FRONTMATTER}
          </pre>
          <p style={{ margin: 0 }}>
            A date using the default format, or a currency using the default
            code, is written without the extra detail — only a different one is
            written inline. Turning this off leaves any existing{" "}
            <code># type:</code> comments untouched.
          </p>
        </InfoButton>
        <OnOffControl
          value={props.settings.typedProps()}
          onChange={props.settings.setTypedPropsValue}
        />
      </div>
    </div>
    <Show when={props.settings.typedProps()}>
      <div class="set-row">
        <div>
          <div class="set-row__lab">Default date format</div>
          <div class="set-row__desc">
            Applied to every date property; override per-property from the type
            menu.
          </div>
        </div>
        <Select
          options={DATE_FORMAT_TOKENS.map((t) => ({ value: t }))}
          value={props.settings.dateDefault()}
          onChange={(v) => props.settings.setDateDefaultValue(v)}
          ariaLabel="Default date format"
        />
      </div>
      <div class="set-row">
        <div>
          <div class="set-row__lab">Default currency</div>
          <div class="set-row__desc">
            Applied to currency properties; override per-property from the type
            menu.
          </div>
        </div>
        <Select
          options={CURRENCY_CODES.map((c) => ({
            value: c,
            label: c.toUpperCase(),
          }))}
          value={props.settings.currencyDefault()}
          onChange={(v) => props.settings.setCurrencyDefaultValue(v)}
          ariaLabel="Default currency"
        />
      </div>
      <div class="set-row">
        <div>
          <div class="set-row__lab">Render “tags” as tags</div>
          <div class="set-row__desc">
            Show the <code>tags</code> property's list as tag chips even when
            items don't start with <code>#</code>.
          </div>
        </div>
        <OnOffControl
          value={props.settings.tagsKeyAsTags()}
          onChange={props.settings.setTagsKeyAsTagsValue}
        />
      </div>
    </Show>
  </>
);

export default EditorPane;
