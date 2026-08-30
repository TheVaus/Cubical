export interface VaultSwitch<T> {
  open: () => Promise<T>;
  release: () => void;
  adopt: (opened: T) => void;
}

export async function switchVault<T>(steps: VaultSwitch<T>): Promise<T> {
  const opened = await steps.open();
  steps.release();
  steps.adopt(opened);
  return opened;
}
