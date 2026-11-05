import {
  app,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebFrameMain,
} from 'electron';
import { APP_SCHEME, IPC_HANDLER_TIMEOUT_MS } from '../../shared/constants';
import {
  ipcFailure,
  isIpcChannelName,
  type IpcArgs,
  type IpcContract,
  type IpcData,
  type IpcResult,
} from '../../shared/ipc';

export type IpcHandler<C extends IpcContract> = (
  event: IpcMainInvokeEvent,
  ...args: IpcArgs<C>
) => IpcData<C> | Promise<IpcData<C>>;

/**
 * The only way main registers an invoke handler (AD-24, Consistency
 * Conventions: IPC). Every call is checked in this order, and the first
 * failure answers `{ ok: false, error }` without running the handler:
 *
 * 1. the sender is a live, top-level frame whose URL is allowed (`app://`,
 *    or the Vite dev server origin while `!app.isPackaged`);
 * 2. the arguments match `contract.input` (a schema that throws counts as a
 *    mismatch);
 * 3. the handler runs and settles within IPC_HANDLER_TIMEOUT_MS; a throw,
 *    rejection or timeout is logged here and answered with a fixed message,
 *    so no error text or stack trace reaches the renderer;
 * 4. the result matches `contract.output` (a throwing schema counts as a
 *    mismatch).
 *
 * Throws at registration when the channel name is not `<domain>:<action>`.
 */
export function registerIpcHandler<C extends IpcContract>(
  contract: C,
  handler: IpcHandler<C>,
): void {
  const { channel } = contract;
  if (!isIpcChannelName(channel)) {
    throw new Error(
      `IPC channel "${channel}" must be <domain>:<action> in lower-case kebab-case, e.g. "app:get-version"`,
    );
  }

  ipcMain.handle(
    channel,
    async (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ): Promise<IpcResult<IpcData<C>>> => {
      const rejection = senderRejection(event);
      if (rejection !== null) {
        console.warn(`[ipc] ${channel}: sender rejected: ${rejection}`);
        return ipcFailure('sender-rejected', 'sender is not allowed');
      }

      const input = validate(contract.input, args);
      if (!input.ok) {
        logInvalid(channel, 'input', input);
        return ipcFailure(
          'invalid-input',
          'arguments do not match the channel schema',
        );
      }

      let data: unknown;
      try {
        data = await withTimeout(() =>
          handler(event, ...(input.data as IpcArgs<C>)),
        );
      } catch (error) {
        console.error(`[ipc] ${channel}: handler failed`, error);
        return ipcFailure('handler-failed', 'handler failed');
      }
      if (data === TIMED_OUT) {
        console.error(
          `[ipc] ${channel}: handler did not settle within ${IPC_HANDLER_TIMEOUT_MS} ms`,
        );
        return ipcFailure('handler-failed', 'handler failed');
      }

      const output = validate(contract.output, data);
      if (!output.ok) {
        logInvalid(channel, 'output', output);
        return ipcFailure('invalid-output', 'handler returned invalid data');
      }
      return { ok: true, data: output.data as IpcData<C> };
    },
  );
}

type Validation =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly issues: number }
  | { readonly ok: false; readonly thrown: unknown };

/** `schema.safeParse`, except that a refine/transform that throws is caught. */
function validate(schema: IpcContract['output'], value: unknown): Validation {
  try {
    const result = schema.safeParse(value);
    return result.success
      ? { ok: true, data: result.data }
      : { ok: false, issues: result.error.issues.length };
  } catch (thrown) {
    return { ok: false, thrown };
  }
}

function logInvalid(
  channel: string,
  side: 'input' | 'output',
  failure: Exclude<Validation, { ok: true }>,
): void {
  if ('thrown' in failure) {
    console.error(`[ipc] ${channel}: ${side} schema threw`, failure.thrown);
    return;
  }
  // Bad input is the renderer's doing; bad output is a bug in main.
  const log = side === 'input' ? console.warn : console.error;
  log(`[ipc] ${channel}: invalid ${side}: ${failure.issues} issue(s)`);
}

const TIMED_OUT = Symbol('ipc-handler-timed-out');

/**
 * Runs the handler, settling with TIMED_OUT if it has not settled after
 * IPC_HANDLER_TIMEOUT_MS so the renderer is never left waiting. A synchronous
 * throw or a rejection propagates to the caller.
 */
async function withTimeout<T>(
  run: () => T | Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), IPC_HANDLER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Why the sender is refused, or null when it is allowed. Never throws. */
function senderRejection(event: IpcMainInvokeEvent): string | null {
  let frame: WebFrameMain | null;
  let url: string;
  try {
    frame = event.senderFrame;
    if (frame === null) {
      return 'senderFrame is null';
    }
    if (frame.parent !== null) {
      return 'not a top-level frame';
    }
    url = frame.url;
  } catch {
    // WebFrameMain throws when the frame was disposed mid-call.
    return 'senderFrame is no longer available';
  }
  return isAllowedSenderUrl(url) ? null : `origin not allowed (${url})`;
}

function isAllowedSenderUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === `${APP_SCHEME}:`) {
    return true;
  }
  const devOrigin = devServerOrigin();
  return devOrigin !== undefined && parsed.origin === devOrigin;
}

/**
 * The Vite dev server origin, only while `!app.isPackaged`. Forge's Vite
 * plugin defines MAIN_WINDOW_VITE_DEV_SERVER_URL at build time (a URL under
 * `npm start`, undefined in a packaged build); `typeof` also keeps this safe
 * where the constant is not defined at all (unit tests). Story 1.5 moves the
 * environment check into main/windows (AD-24).
 */
function devServerOrigin(): string | undefined {
  if (app.isPackaged) {
    return undefined;
  }
  if (
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'string' ||
    MAIN_WINDOW_VITE_DEV_SERVER_URL === ''
  ) {
    return undefined;
  }
  try {
    return new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
  } catch {
    return undefined;
  }
}
