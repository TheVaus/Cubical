import {
  getSetting,
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

export async function seedSetting<K extends Setting["key"]>(
  vaultId: string,
  key: K,
  fallback: SettingValue<K>,
  apply: (value: SettingValue<K>) => void,
): Promise<void> {
  try {
    const stored = await getSetting(vaultId, key);
    apply(stored ?? fallback);
  } catch (e) {
    console.error(`loading ${key} failed`, e);
  }
}
