export interface Debounced {
  readonly schedule: () => void;
  readonly cancel: () => void;
  readonly pending: () => boolean;
}

export function createDebounced(run: () => void, waitMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    schedule: () => {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, waitMs);
    },
    cancel,
    pending: () => timer !== undefined,
  };
}
