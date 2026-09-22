import { blockSetting, type BlockSetting } from "../settings/blockSettings";
import type { BooleanSettingKey } from "../settings/corePlugins";

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

export function statusbarBlockSettings(): BlockSetting[] {
  return [
    blockSetting(STATUSBAR_ENABLED_KEY, STATUSBAR_DEFAULT),
    ...registry.map((seg) => blockSetting(seg.settingKey, seg.defaultVisible)),
  ];
}

declare module "../api/ipc" {
  interface SettingRegistry {
    "statusbar.enabled": boolean;
  }
}
