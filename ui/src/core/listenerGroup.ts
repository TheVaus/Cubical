export type Unlisten = () => void;

export interface ListenerGroup {
  attach(what: string, register: () => Promise<Unlisten>): Promise<void>;
  detach(): void;
  attached(): number;
}

export function createListenerGroup(): ListenerGroup {
  const unlisten: Unlisten[] = [];
  let detached = false;

  return {
    async attach(what, register) {
      try {
        const off = await register();
        if (detached) off();
        else unlisten.push(off);
      } catch (e) {
        console.error(`${what} listener did not attach`, e);
      }
    },
    detach() {
      detached = true;
      while (unlisten.length > 0) {
        const off = unlisten.pop();
        try {
          off?.();
        } catch (e) {
          console.error("listener did not detach", e);
        }
      }
    },
    attached: () => unlisten.length,
  };
}
