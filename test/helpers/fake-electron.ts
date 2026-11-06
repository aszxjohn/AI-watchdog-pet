/**
 * A stand-in for the electron APIs that src/main/ipc/*, src/main/stage-view
 * and the preloads touch, wired together the way Electron is:
 *
 * - ipcRenderer.invoke structured-clones the arguments, calls the listener
 *   that registerIpcHandler gave ipcMain.handle with an event from `sender`
 *   (a top-level app:// frame unless a test changes it), and
 *   structured-clones the reply back.
 * - `sender.send` (what pushToRenderer calls) structured-clones the payload
 *   and calls every ipcRenderer.on listener for that channel, synchronously
 *   and in order.
 *
 * Use it with `vi.mock('electron', () => import('../helpers/fake-electron'))`
 * and call resetFakeElectron() in beforeEach. A test that re-imports modules
 * after vi.resetModules() must have imported `electron` (directly or through
 * a static import) before the first reset; otherwise the mock is built from a
 * fresh copy of this file and no longer shares its state with the test.
 */
import type { IpcMainInvokeEvent, IpcRendererEvent } from 'electron';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type RendererListener = (event: IpcRendererEvent, ...args: unknown[]) => void;

export const listeners = new Map<string, Listener>();
export const rendererListeners = new Map<string, RendererListener[]>();
export const exposed = new Map<string, unknown>();

export const app = { isPackaged: false };

/** A fake webContents: what an IPC event's `sender` and a push target need. */
export interface FakeWebContents {
  readonly id: number;
  readonly mainFrame: { url: string; parent: null };
  destroyed: boolean;
  /** Every `send` call that reached it, already structured-cloned. */
  readonly sent: { channel: string; args: unknown[] }[];
  /** How many `destroyed` listeners were registered on it. */
  destroyedListenerCount(): number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  once(event: string, listener: () => void): void;
  /** Marks it destroyed and fires `destroyed`, as Electron does. */
  destroy(): void;
}

/**
 * A fake webContents. When `deliver` is true (the default) a send also
 * reaches this process's ipcRenderer.on listeners.
 */
export function createFakeWebContents(
  id: number,
  url = 'app://panels/index.html',
  deliver = true,
): FakeWebContents {
  const onDestroyed: (() => void)[] = [];
  const contents: FakeWebContents = {
    id,
    mainFrame: { url, parent: null },
    destroyed: false,
    sent: [],
    destroyedListenerCount: () => onDestroyed.length,
    send(channel, ...args) {
      if (contents.destroyed) {
        throw new Error('Object has been destroyed');
      }
      const cloned = structuredClone(args);
      contents.sent.push({ channel, args: cloned });
      if (!deliver) {
        return;
      }
      const event = { sender: ipcRenderer } as unknown as IpcRendererEvent;
      // A copy, so a listener that unsubscribes does not skip the next one.
      for (const listener of (rendererListeners.get(channel) ?? []).slice()) {
        listener(event, ...structuredClone(cloned));
      }
    },
    isDestroyed: () => contents.destroyed,
    once(event, listener) {
      if (event === 'destroyed') {
        onDestroyed.push(listener);
      }
    },
    destroy() {
      contents.destroyed = true;
      for (const listener of onDestroyed.splice(0)) {
        listener();
      }
    },
  };
  return contents;
}

/** The webContents that ipcRenderer.invoke calls come from. */
export let sender = createFakeWebContents(1);

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

interface FakeIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: RendererListener): FakeIpcRenderer;
  removeListener(channel: string, listener: RendererListener): FakeIpcRenderer;
}

export const ipcRenderer: FakeIpcRenderer = {
  async invoke(channel, ...args) {
    const listener = listeners.get(channel);
    if (listener === undefined) {
      throw new Error(
        `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`,
      );
    }
    const event = {
      sender,
      senderFrame: sender.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    const reply = await listener(event, ...structuredClone(args));
    return structuredClone(reply);
  },
  on(channel, listener) {
    const list = rendererListeners.get(channel) ?? [];
    list.push(listener);
    rendererListeners.set(channel, list);
    return ipcRenderer;
  },
  removeListener(channel, listener) {
    const list = rendererListeners.get(channel) ?? [];
    const index = list.indexOf(listener);
    if (index >= 0) {
      list.splice(index, 1);
    }
    return ipcRenderer;
  },
};

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    exposed.set(key, api);
  },
};

/** Clears every registration and gives invoke a fresh sender. */
export function resetFakeElectron(): void {
  listeners.clear();
  rendererListeners.clear();
  exposed.clear();
  app.isPackaged = false;
  sender = createFakeWebContents(1);
}

/** Total ipcRenderer.on listeners on `channel`. */
export function rendererListenerCount(channel: string): number {
  return rendererListeners.get(channel)?.length ?? 0;
}
