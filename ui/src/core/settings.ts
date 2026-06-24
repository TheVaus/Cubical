import {
  getSetting,
  setSetting,
  type Setting,
  type SettingValue,
} from "../api/ipc";

/**
 * Core substrate — vault-local settings side-effects.
 *
 * App used to inline the same two boilerplate shapes ~9 times each:
 *
 *   1. *Persist on change* — `if (id) setSetting(id, key, v).catch(log)`.
 *   2. *Seed on vault open* — `try { const s = await getSetting(id, key);
 *      applyTo(s ?? fallback) } catch (e) { log }`.
 *
 * Those two side-effects are the only thing the substrate owns. Each
 * setting's *reactive value* stays owned by the feature that renders it
 * (theme, raw-source, properties, core-plugins, …), so the store keeps
 * its compile-time key→value typing (`Setting`/`SettingValue`) instead of
 * collapsing into a stringly-typed `Record`. The substrate persists and
 * seeds; it never decides what a setting *means*.
 */

/**
 * Persist a vault-local setting, fire-and-forget. No-ops when no vault is
 * open (the setting is vault-local — nowhere to write yet); logs and
 * swallows IPC failures so a settings write never breaks the UI.
 */
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

/**
 * Seed one setting on vault open: read it and hand the resolved value to
 * `apply` — the stored value, or `fallback` when the key is absent. A read
 * *failure* is logged and `apply` is skipped, leaving the feature at its
 * initial value (which the caller seeds to the same default), matching the
 * pre-extraction behaviour. `apply` is the feature's own setter (+ any
 * side-effect, e.g. applying a theme), keeping value ownership with it.
 */
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
