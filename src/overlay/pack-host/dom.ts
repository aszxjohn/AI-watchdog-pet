/**
 * The sandbox iframes pack-host uses (Story 3.5, AD-7), built on the
 * overlay's document. Only structural types of the browser objects, given
 * by main.ts, so this is unit-tested under Node with fakes.
 *
 * - Each iframe is `sandbox="allow-scripts"` (never `allow-same-origin`),
 *   hidden, and shows SANDBOX_DOCUMENT_URL; its load listener is set before
 *   its `src`.
 * - hand() makes a MessageChannel, keeps one end (its messages go to
 *   onMessage) and posts the other end with the load message to the
 *   iframe's window, once. The iframe's origin is opaque, so the target
 *   origin can only be `*`; what is posted is the entry source alone.
 * - The only message pack-host takes from an iframe's window is exactly
 *   `{ type: 'worker-error' }`, and only from a window of its own iframes.
 * - post() (Story 3.6) posts a stage message on the kept end, once hand()
 *   has made it; before that, or once removed, it posts nothing.
 * - remove() closes the kept end and removes the iframe; the Worker goes
 *   with its document.
 */
import {
  isSandboxFrameNotice,
  SANDBOX_DOCUMENT_URL,
  type SandboxLoadMessage,
} from '../../shared/sandbox';
import type { SandboxFrame, SandboxFrames } from './host';

/** The parts of a MessagePort pack-host keeps. */
export interface SandboxFramePort {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  start(): void;
  close(): void;
}

/**
 * A MessageChannel: pack-host keeps `port1` and hands over `port2` (of the
 * transferable type `T`).
 */
export interface SandboxFrameChannel<T> {
  readonly port1: SandboxFramePort;
  readonly port2: T;
}

/** The parts of an `<iframe>` element pack-host uses. */
export interface SandboxIframeElement<T> {
  /** `boolean | 'until-found'` in the DOM; pack-host sets true. */
  hidden: boolean | string;
  src: string;
  setAttribute(name: string, value: string): void;
  addEventListener(
    type: 'load',
    listener: () => void,
    options: { once: true },
  ): void;
  readonly contentWindow: {
    postMessage(
      message: SandboxLoadMessage,
      targetOrigin: string,
      transfer: T[],
    ): void;
  } | null;
  remove(): void;
}

/** The parts of the overlay's window pack-host listens on. */
export interface SandboxHostWindow {
  addEventListener(
    type: 'message',
    listener: (event: {
      readonly source: unknown;
      readonly data: unknown;
    }) => void,
  ): void;
}

export interface DomSandboxFramesOptions<T, F extends SandboxIframeElement<T>> {
  /** `document.createElement('iframe')`. */
  createIframe(): F;
  /** Puts the iframe in the document. */
  attach(iframe: F): void;
  /** The overlay's window. */
  readonly window: SandboxHostWindow;
  /** `new MessageChannel()`. */
  createChannel(): SandboxFrameChannel<T>;
}

export function createDomSandboxFrames<T, F extends SandboxIframeElement<T>>({
  createIframe,
  attach,
  window,
  createChannel,
}: DomSandboxFramesOptions<T, F>): SandboxFrames {
  /** Each loaded iframe's window → what to call when it says its Worker failed. */
  const workerErrors = new Map<unknown, () => void>();
  window.addEventListener('message', (event) => {
    const onWorkerError = workerErrors.get(event.source);
    if (onWorkerError !== undefined && isSandboxFrameNotice(event.data)) {
      onWorkerError();
    }
  });

  return {
    create(handlers): SandboxFrame {
      const iframe = createIframe();
      let port: SandboxFramePort | null = null;
      let frameWindow: unknown = null;
      let removed = false;
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.hidden = true;
      iframe.addEventListener(
        'load',
        () => {
          if (removed) {
            return;
          }
          frameWindow = iframe.contentWindow;
          if (frameWindow !== null) {
            workerErrors.set(frameWindow, () => {
              handlers.onWorkerError();
            });
          }
          handlers.onLoad();
        },
        { once: true },
      );
      iframe.src = SANDBOX_DOCUMENT_URL;
      attach(iframe);

      return {
        hand(message) {
          if (removed || port !== null) {
            return;
          }
          const target = iframe.contentWindow;
          if (target === null) {
            throw new Error('the sandbox iframe has no window');
          }
          const channel = createChannel();
          port = channel.port1;
          port.addEventListener('message', (event) => {
            if (!removed) {
              handlers.onMessage(event.data);
            }
          });
          port.start();
          target.postMessage(message, '*', [channel.port2]);
        },
        post(message) {
          if (!removed) {
            port?.postMessage(message);
          }
        },
        remove() {
          if (removed) {
            return;
          }
          removed = true;
          if (frameWindow !== null) {
            workerErrors.delete(frameWindow);
          }
          port?.close();
          iframe.remove();
        },
      };
    },
  };
}
