import { createMemo, createSignal, type Accessor, type Component } from "solid-js";

import { corePluginActive } from "./corePlugins";

export interface SidebarPanelProps {
  vaultId: string | null;
  path: string | null;
  refreshSignal: number;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
}

export interface SidebarPanel {
  id: string;
  label: string;
  order: number;
  panel: Component<SidebarPanelProps>;
  plugin?: string;
}

const panels: SidebarPanel[] = [];
const leftModes: string[] = [];

export function registerSidebarPanels(
  contributed: readonly SidebarPanel[],
): void {
  for (const panel of contributed) {
    if (!panels.some((p) => p.id === panel.id)) panels.push(panel);
  }
  panels.sort((a, b) => a.order - b.order);
}

export function registeredSidebarPanels(): readonly SidebarPanel[] {
  return panels;
}

export function offeredSidebarPanels(
  corePlugins: Record<string, boolean>,
): readonly SidebarPanel[] {
  return panels.filter(
    (p) => p.plugin === undefined || corePluginActive(corePlugins, p.plugin),
  );
}

function resolveSidebarPanel(
  id: string,
  corePlugins: Record<string, boolean>,
): string {
  const offered = offeredSidebarPanels(corePlugins);
  return offered.some((p) => p.id === id) ? id : (offered[0]?.id ?? "");
}

export interface SidebarPanelChoice {
  current: Accessor<string>;
  offers: (id: string) => boolean;
  choose: (id: string) => void;
}

export function createSidebarPanelChoice(
  corePlugins: Accessor<Record<string, boolean>>,
): SidebarPanelChoice {
  const [chosen, choose] = createSignal(defaultSidebarPanel());
  const current = createMemo(() => resolveSidebarPanel(chosen(), corePlugins()));
  const offers = (id: string) =>
    offeredSidebarPanels(corePlugins()).some((p) => p.id === id);
  return { current, offers, choose: (id) => void choose(id) };
}

export function defaultSidebarPanel(): string {
  return panels[0]?.id ?? "";
}

export function registerLeftSidebarModes(ids: readonly string[]): void {
  for (const id of ids) if (!leftModes.includes(id)) leftModes.push(id);
}

export function defaultLeftSidebarMode(): string {
  return leftModes[0] ?? "";
}

export function isLeftSidebarMode(id: string): boolean {
  return leftModes.includes(id);
}
