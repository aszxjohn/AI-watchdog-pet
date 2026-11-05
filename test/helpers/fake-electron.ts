/**
 * A stand-in for the electron APIs that src/main/ipc/register.ts and the
 * preloads touch, wired together the way Electron is: ipcRenderer.invoke
 * structured-clones the arguments, calls the listener that
 * registerIpcHandler gave ipcMain.handle (from a top-level app:// frame),
 * and structured-clones the reply back. Use it with
 * `vi.mock('electron', () => import('../helpers/fake-electron'))`.
 */
import type { IpcMainInvokeEvent } from 'electron';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export const listeners = new Map<string, Listener>();
export const exposed = new Map<string, unknown>();

export const app = { isPackaged: false };

const senderEvent = {
  senderFrame: { url: 'app://panels/index.html', parent: null },
} as unknown as IpcMainInvokeEvent;

export const ipcMain = {
  handle(channel: string, listener: Listener): void {
    if (listeners.has(channel)) {
      throw new Error(
        `Attempted to register a second handler for '${channel}'`,
      );
    }
    listeners.set(channel, listener);
  },
};

export const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const listener = listeners.get(channel);
    if (listener === undefined) {
      throw new Error(
        `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`,
      );
    }
    const reply = await listener(senderEvent, ...structuredClone(args));
    return structuredClone(reply);
  },
};

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    exposed.set(key, api);
  },
};
