/**
 * pack-host (Stories 3.5, 3.6): asks main to write one run log line about
 * a pack (`packs:log`). A call that fails, or an answer that is not ok,
 * goes to the console; nothing throws.
 */
import type { IpcResult } from '../../shared/ipc';
import type { PackLogEntry } from '../../shared/sandbox';

/** `window.awp.packs`, as far as the log uses it. */
export interface PackLogApi {
  log(entry: PackLogEntry): Promise<IpcResult<null>>;
}

/** The function that writes one line through `api`. */
export function createPackLog(
  api: PackLogApi,
  logError: (message: string, ...details: unknown[]) => void = console.error,
): (entry: PackLogEntry) => void {
  return (entry) => {
    let reply: Promise<IpcResult<null>>;
    try {
      reply = api.log(entry);
    } catch (error) {
      logError(`[overlay] packs:log failed (${entry.kind})`, error);
      return;
    }
    void reply.then(
      (result) => {
        if (!result.ok) {
          logError(
            `[overlay] packs:log: ${result.error.code}: ${result.error.message}`,
          );
        }
      },
      (error: unknown) => {
        logError(`[overlay] packs:log failed (${entry.kind})`, error);
      },
    );
  };
}
