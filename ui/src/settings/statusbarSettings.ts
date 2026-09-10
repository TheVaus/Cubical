import type { BooleanSettingKey } from "./corePlugins";

export const STATUSBAR_ENABLED_KEY = "statusbar.enabled" as const;

export const STATUSBAR_DEFAULT = true;

export interface StatusbarSegment {
  id: string;
  name: string;
  description: string;
  settingKey: BooleanSettingKey;
  defaultVisible: boolean;
}

const registry: StatusbarSegment[] = [];

export function registerStatusbarSegments(
  segments: readonly StatusbarSegment[],
): void {
  for (const segment of segments) {
    if (!registry.some((s) => s.id === segment.id)) registry.push(segment);
  }
}

export function registeredStatusbarSegments(): readonly StatusbarSegment[] {
  return registry;
}

export function segmentVisible(
  state: Record<string, boolean>,
  seg: StatusbarSegment,
): boolean {
  return state[seg.settingKey] ?? seg.defaultVisible;
}
