import type { CorePlugin } from "../settings/corePlugins";

export const PROPERTY_REFS_PLUGIN: CorePlugin = {
  id: "property-refs",
  name: "Property references",
  description:
    "Show a frontmatter value inline: [[note.prop]] pulls from another note, [[.prop]] from this one.",
  settingKey: "plugins.property_refs_enabled",
  defaultEnabled: true,
  docId: "property-refs",
};

export const MATH_PLUGIN: CorePlugin = {
  id: "math",
  name: "Math",
  description:
    "Typeset LaTeX with KaTeX — ```math blocks and $$…$$ display math render as you write.",
  settingKey: "plugins.math_enabled",
  defaultEnabled: true,
  docId: "math",
};

export const EQUATIONS_PLUGIN: CorePlugin = {
  id: "equations",
  name: "Equations",
  description:
    "Compute inside a note: `= 5-3` renders 2, and an operand can be a property from any note.",
  settingKey: "plugins.equations_enabled",
  defaultEnabled: true,
  docId: "equations",
  requires: [PROPERTY_REFS_PLUGIN.id],
};
