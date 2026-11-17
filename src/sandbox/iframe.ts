/**
 * The sandbox iframe's code (AD-7, Story 3.5): the inline script of
 * `pack://_stage/sandbox.html` calls startIframe(self, <Worker script>)
 * once. Its document is `<iframe sandbox="allow-scripts">` without
 * `allow-same-origin`, so its origin is opaque, and its CSP lets only that
 * inline script run and Workers come only from blobs.
 *
 * 1. It takes the first `load` message from its parent (the overlay), and
 *    only when that message is exactly `{ type: 'load', source }` with
 *    exactly one MessagePort; every message from anyone else, and every
 *    later one, is ignored.
 * 2. It puts the entry source before the Worker script (as a JSON string
 *    the bootstrap evaluates in a Compartment, never as code here), makes a
 *    blob of it and starts a classic Worker from it (no `type`).
 * 3. It hands the port to the Worker and relays nothing after that.
 * 4. Only if the Worker cannot be made, or fires an `error` event, does it
 *    tell its parent so, with nothing else in the message.
 *
 * The browser objects come in as `scope` (structural types only), so this
 * is unit-tested under Node. Keep this file ASCII-only: it is part of the
 * hashed sandbox script.
 */
import type {
  SandboxFrameNotice,
  SandboxLoadMessage,
  SandboxPortMessage,
} from '../shared/sandbox';
import { ENTRY_SOURCE_GLOBAL } from './document';

/** A `message` event as the iframe sees it. */
export interface IframeMessageEvent {
  readonly source: unknown;
  readonly data: unknown;
  readonly ports: readonly unknown[];
}

/** The parts of a Worker the iframe uses. */
export interface IframeWorker {
  postMessage(message: SandboxPortMessage, transfer: unknown[]): void;
  addEventListener(type: 'error', listener: () => void): void;
}

/** The parts of the iframe's window it uses. */
export interface IframeScope {
  readonly parent: {
    postMessage(message: SandboxFrameNotice, targetOrigin: string): void;
  };
  addEventListener(
    type: 'message',
    listener: (event: IframeMessageEvent) => void,
  ): void;
  readonly Blob: new (parts: string[], options: { type: string }) => unknown;
  readonly URL: { createObjectURL(blob: unknown): string };
  /** A classic Worker: the constructor is never given options. */
  readonly Worker: new (url: string) => IframeWorker;
}

/**
 * The entry source of `data` when it is exactly a SandboxLoadMessage
 * (`type` and a string `source`, no other key), else undefined.
 */
export function loadMessageSource(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const keys = Object.keys(data);
  const { type, source } = data as Partial<
    Record<keyof SandboxLoadMessage, unknown>
  >;
  return keys.length === 2 && type === 'load' && typeof source === 'string'
    ? source
    : undefined;
}

/** The blob's source: the entry, as a string constant, then the Worker script. */
export function workerSource(workerScript: string, entry: string): string {
  return `const ${ENTRY_SOURCE_GLOBAL} = ${JSON.stringify(entry)};\n${workerScript}`;
}

/** Whether `data` claims to be a `load` message, well formed or not. */
function isLoadAttempt(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'load'
  );
}

/** Starts listening for the overlay's one `load` message. */
export function startIframe(scope: IframeScope, workerScript: string): void {
  let loaded = false;
  const workerFailed = (): void => {
    try {
      scope.parent.postMessage({ type: 'worker-error' }, '*');
    } catch {
      // The parent is gone; nothing is left to tell.
    }
  };
  scope.addEventListener('message', (event) => {
    if (loaded || event.source !== scope.parent || !isLoadAttempt(event.data)) {
      return;
    }
    // The first load from the parent is the only one, good or bad.
    loaded = true;
    const source = loadMessageSource(event.data);
    if (source === undefined || event.ports.length !== 1) {
      return;
    }
    const port = event.ports[0];
    try {
      const url = scope.URL.createObjectURL(
        new scope.Blob([workerSource(workerScript, source)], {
          type: 'text/javascript',
        }),
      );
      const worker = new scope.Worker(url);
      worker.addEventListener('error', workerFailed);
      worker.postMessage({ type: 'port' }, [port]);
    } catch {
      workerFailed();
    }
  });
}
