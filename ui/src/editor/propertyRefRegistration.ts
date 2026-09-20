import type { CorePlugin } from "../settings/corePlugins";
import PropertyRefsDoc from "./propertyRefDoc";

export const PROPERTY_REFS_PLUGIN: CorePlugin = {
  id: "property-refs",
  name: "Property references",
  description:
    "Show a frontmatter value inline: [[note.prop]] pulls from another note, [[.prop]] from this one.",
  settingKey: "plugins.property_refs_enabled",
  defaultEnabled: true,
  doc: PropertyRefsDoc,
};
