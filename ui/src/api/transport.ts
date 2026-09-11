import { invoke as invokeCommand } from "@tauri-apps/api/core";

import { measurePerfAsync } from "../core/perf";

export const invoke = <T,>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> => measurePerfAsync(`ipc:${cmd}`, () => invokeCommand<T>(cmd, args));
