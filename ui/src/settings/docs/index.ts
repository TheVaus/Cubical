import type { Component } from "solid-js";

import type { PluginDocId } from "../corePlugins";
import EquationsDoc from "./EquationsDoc";
import MathDoc from "./MathDoc";
import PropertyRefsDoc from "./PropertyRefsDoc";
import QueryDoc from "./QueryDoc";

export interface PluginDoc {
  title: string;
  body: Component;
}

export const PLUGIN_DOCS: Record<PluginDocId, PluginDoc> = {
  query: { title: "Query", body: QueryDoc },
  "property-refs": { title: "Property references", body: PropertyRefsDoc },
  math: { title: "Math", body: MathDoc },
  equations: { title: "Equations", body: EquationsDoc },
};
