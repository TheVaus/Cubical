import {
  setSetting,
  type Setting,
  type SettingValue,
} from "../api/ipc";

export function persistSetting<K extends Setting["key"]>(
  vaultId: string | null,
  key: K,
  value: SettingValue<K>,
): void {
  if (!vaultId) return;
  setSetting(vaultId, key, value).catch((e) => {
    console.error(`persisting ${key} failed`, e);
  });
}

