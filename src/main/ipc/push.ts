/**
 * The only way main pushes to a renderer (AD-20, AD-24): main pushes nothing
 * but StageView, and only through pushToRenderer.
 *
 * Lint cannot enforce this the way it fences ipcMain and ipcRenderer:
 * `webContents.send` is a method on an object main already holds, not an
 * import. Call `send` nowhere else; review is the backstop.
 */
import type { WebFrameMain } from 'electron';
import {
  isIpcChannelName,
  type IpcPayload,
  type IpcPushContract,
} from '../../shared/ipc';
import { errorCode, logEvent } from '../log/run-log';
import { frameRejection } from './origin';

/** The parts of a WebContents a push touches. */
export interface PushTarget {
  readonly id: number;
  readonly mainFrame: Pick<WebFrameMain, 'url' | 'parent'>;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export type PushOutcome =
  /** Delivered to Electron for sending. */
  | 'sent'
  /** The webContents is gone; drop it from any subscriber list. */
  | 'destroyed'
  /** Its top-level frame is not an allowed page (now); nothing was sent. */
  | 'rejected'
  /** The contract or payload is wrong (a bug in main); nothing was sent. */
  | 'invalid'
  /** `send` itself threw; nothing was sent. */
  | 'failed';

/**
 * Sends `payload` on `contract.channel` to `target`, after checking, in this
 * order, that the channel name is `<domain>:<action>`, the payload matches
 * `contract.payload`, the target is not destroyed, and its top-level frame
 * is still an allowed page. Never throws.
 */
export function pushToRenderer<C extends IpcPushContract>(
  target: PushTarget,
  contract: C,
  payload: IpcPayload<C>,
): PushOutcome {
  const { channel } = contract;
  if (!isIpcChannelName(channel)) {
    logEvent(
      'ipc',
      `push on "${channel}" refused: not a <domain>:<action> channel`,
      'error',
    );
    return 'invalid';
  }

  let data: unknown;
  try {
    const parsed = contract.payload.safeParse(payload);
    if (!parsed.success) {
      logEvent(
        'ipc',
        `${channel}: invalid push payload: ${parsed.error.issues.length} issue(s)`,
        'error',
      );
      return 'invalid';
    }
    data = parsed.data;
  } catch (error) {
    logEvent(
      'ipc',
      `${channel}: push payload schema threw (${errorCode(error)})`,
      'error',
    );
    return 'invalid';
  }

  let rejection: string | null;
  try {
    if (target.isDestroyed()) {
      return 'destroyed';
    }
    rejection = frameRejection(target.mainFrame);
  } catch {
    // mainFrame throws once the webContents is being torn down.
    return 'destroyed';
  }
  if (rejection !== null) {
    logEvent(
      'ipc',
      `${channel}: push to webContents ${target.id} refused: ${rejection}`,
      'warn',
    );
    return 'rejected';
  }

  try {
    target.send(channel, data);
  } catch (error) {
    logEvent(
      'ipc',
      `${channel}: push to webContents ${target.id} failed (${errorCode(error)})`,
      'error',
    );
    return 'failed';
  }
  return 'sent';
}
