import type { Component } from "solid-js";

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

export function defaultSidebarPanel(): string {
  return panels[0]?.id ?? "";
}

export function isSidebarPanel(id: string): boolean {
  return panels.some((p) => p.id === id);
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
