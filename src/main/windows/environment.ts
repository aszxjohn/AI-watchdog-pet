/**
 * The one place that decides which environment main runs in and which URLs
 * that environment allows (AD-24). Every other module asks here instead of
 * reading `app.isPackaged` or the Forge dev server constants itself.
 *
 * - Packaged: pages come from `app://`; nothing else is allowed.
 * - `npm start` (`!app.isPackaged`): each renderer (panels, overlay) comes
 *   from its own Vite dev server, so those origins (http) and their HMR
 *   sockets (ws, same host and port) are allowed as well, but only for
 *   requests the renderers' top frames make (Story 3.5, Epic 1 retro A8).
 * - A pack sandbox (its iframe, and the Workers that iframe starts) gets
 *   no request through, in any environment (isAllowedRequest).
 *
 * The URL checks are pure: they take the environment as an argument and
 * never throw.
 */
import { app } from 'electron';
import { APP_SCHEME, PACK_SCHEME } from '../../shared/constants';
import { SANDBOX_DOCUMENT_URL } from '../../shared/sandbox';
import { OVERLAY_HOST, PANELS_HOST } from './protocols';

/** The stage's own renderers: the pages main loads into its windows. */
export const RENDERER_NAMES = ['panels', 'overlay'] as const;

export type RendererName = (typeof RENDERER_NAMES)[number];

/** The `app://` host each renderer is served from. */
const APP_HOSTS: Readonly<Record<RendererName, string>> = Object.freeze({
  panels: PANELS_HOST,
  overlay: OVERLAY_HOST,
});

/** A renderer's Vite dev server. */
export interface DevServer {
  /** The URL Forge defined (`http://localhost:5173`). */
  readonly url: string;
  /** Its origin (`http://localhost:5173`). */
  readonly origin: string;
}

export interface WindowsEnvironment {
  /** `app.isPackaged`. */
  readonly packaged: boolean;
  /**
   * Each renderer's Vite dev server, only while not packaged and Forge
   * defined one; undefined otherwise.
   */
  readonly devServers: Readonly<Record<RendererName, DevServer | undefined>>;
}

/**
 * The environment right now. Forge's Vite plugin defines
 * `<NAME>_VITE_DEV_SERVER_URL` at build time (a URL under `npm start`,
 * `undefined` once packaged); `typeof` keeps this safe where a constant is
 * not defined at all (unit tests).
 */
export function currentEnvironment(): WindowsEnvironment {
  const packaged = app.isPackaged;
  const devServer = (url: unknown): DevServer | undefined =>
    packaged ? undefined : devServerAt(url);
  return {
    packaged,
    devServers: {
      panels: devServer(
        typeof PANELS_VITE_DEV_SERVER_URL === 'undefined'
          ? undefined
          : PANELS_VITE_DEV_SERVER_URL,
      ),
      overlay: devServer(
        typeof OVERLAY_VITE_DEV_SERVER_URL === 'undefined'
          ? undefined
          : OVERLAY_VITE_DEV_SERVER_URL,
      ),
    },
  };
}

/** The dev server at `url`, or undefined when it is not an http(s) URL. */
function devServerAt(url: unknown): DevServer | undefined {
  if (typeof url !== 'string' || url === '') {
    return undefined;
  }
  const parsed = parseUrl(url);
  if (
    parsed === undefined ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
  ) {
    return undefined;
  }
  return { url, origin: parsed.origin };
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** The dev servers this environment has, panels first. */
export function devServersOf(env: WindowsEnvironment): DevServer[] {
  return RENDERER_NAMES.flatMap((name) => {
    const server = env.devServers[name];
    return server === undefined ? [] : [server];
  });
}

/**
 * Whether this is development: there is a dev server (`npm start`). Only
 * then may DevTools load (`devtools:`) and does the panel open them. An
 * unpackaged run without one (`electron .` on a production build, as the
 * e2e tests do) is not.
 */
export function isDevelopment(env: WindowsEnvironment): boolean {
  return devServersOf(env).length > 0;
}

/** Whether `parsed` is on one of the dev servers: same scheme, host, port. */
function isDevServerUrl(parsed: URL, env: WindowsEnvironment): boolean {
  return devServersOf(env).some((server) => parsed.origin === server.origin);
}

/**
 * Which of the stage's renderers a frame showing `url` is: `app://panels/…`
 * or `app://overlay/…`, or, while not packaged, a page on that renderer's
 * own dev server. Undefined for anything else: then the frame may not talk
 * to main over IPC (main/ipc).
 */
export function rendererOfUrl(
  url: string,
  env: WindowsEnvironment = currentEnvironment(),
): RendererName | undefined {
  const parsed = parseUrl(url);
  if (parsed === undefined) {
    return undefined;
  }
  return RENDERER_NAMES.find(
    (name) =>
      (parsed.protocol === `${APP_SCHEME}:` &&
        parsed.host === APP_HOSTS[name]) ||
      parsed.origin === env.devServers[name]?.origin,
  );
}

/**
 * Whether a frame may navigate to `url` (`will-frame-navigate`): `app://`,
 * `pack://`, and the dev servers while not packaged.
 */
export function isAllowedNavigationUrl(
  url: string,
  env: WindowsEnvironment = currentEnvironment(),
): boolean {
  const parsed = parseUrl(url);
  if (parsed === undefined) {
    return false;
  }
  return (
    parsed.protocol === `${APP_SCHEME}:` ||
    parsed.protocol === `${PACK_SCHEME}:` ||
    isDevServerUrl(parsed, env)
  );
}

/**
 * Whether `parsed` is on one of the dev servers or is its HMR WebSocket:
 * ws:// (wss:// for an https dev server) on the same host and port.
 */
function isDevServerRequestUrl(parsed: URL, env: WindowsEnvironment): boolean {
  return devServersOf(env).some((server) => {
    if (parsed.origin === server.origin) {
      return true;
    }
    const dev = new URL(server.origin);
    const socketProtocol = dev.protocol === 'https:' ? 'wss:' : 'ws:';
    return parsed.protocol === socketProtocol && parsed.host === dev.host;
  });
}

/**
 * Whether the session may make a request to `url` (`webRequest`), going by
 * the URL alone: `app:` and `pack:`; while there is a dev server, also
 * `devtools:` (DevTools' own pages, which only development needs), each
 * dev server over http and its HMR WebSocket. Everything else, http(s) and
 * ws(s) to anywhere and `file:` included, is cancelled (AD-26: the app
 * makes no outside requests). isAllowedRequest adds who made the request.
 */
export function isAllowedRequestUrl(
  url: string,
  env: WindowsEnvironment = currentEnvironment(),
): boolean {
  const parsed = parseUrl(url);
  if (parsed === undefined) {
    return false;
  }
  if (
    parsed.protocol === `${APP_SCHEME}:` ||
    parsed.protocol === `${PACK_SCHEME}:`
  ) {
    return true;
  }
  if (parsed.protocol === 'devtools:') {
    return isDevelopment(env);
  }
  return isDevServerRequestUrl(parsed, env);
}

/**
 * The requesting frame as webRequest gives it (Electron's WebFrameMain).
 * Reading it may throw once the frame is gone.
 */
export interface RequestFrame {
  readonly url: string;
  readonly parent: RequestFrame | null;
}

/**
 * What the filter reads of webRequest's `onBeforeRequest` details.
 * Measured on Electron 45.2.1 (Story 3.5): a Worker's requests carry the
 * frame of the document that started it (a sandbox Worker's, the sandbox
 * iframe) and that document's `initiatorOrigin` (`"null"` for the opaque
 * sandbox); a window's own top-level navigation carries its top frame,
 * not yet showing anything (url ''), and no `initiatorOrigin`; an iframe's
 * navigation carries the iframe's own frame (its parent is the frame that
 * set `src`) and the parent's origin as `initiatorOrigin`. `webContentsId`
 * comes along but is not needed for the decision.
 */
export interface RequestDetails {
  readonly url: string;
  readonly resourceType?: string;
  readonly frame?: RequestFrame | null;
  readonly webContentsId?: number;
  readonly initiatorOrigin?: string;
}

/**
 * Who made a request, as far as its details tell:
 *
 * - `sandbox`: a pack sandbox, or what is treated as one: any frame that
 *   is not a top frame, a frame showing a `pack:` URL, or an opaque
 *   initiator (`initiatorOrigin` `"null"`), whatever the request is for;
 * - `sandbox-document`: the overlay's top frame loading
 *   SANDBOX_DOCUMENT_URL into one of its iframes, the one exception;
 * - `stage-page`: the top frame of one of the stage's renderers (panels,
 *   overlay), or a top frame's own navigation to one of them;
 * - `page`: any other top frame (DevTools, say);
 * - `unknown`: no frame and no initiator to go by (or a frame that can no
 *   longer be read).
 */
export type Requester =
  | 'sandbox'
  | 'sandbox-document'
  | 'stage-page'
  | 'page'
  | 'unknown';

/** What a requesting frame shows, and its parent's, read once. */
interface FrameFacts {
  readonly url: string;
  /** The parent frame's URL; null for a top frame. */
  readonly parentUrl: string | null;
  /** Whether the parent frame is itself a top frame. */
  readonly parentIsTop: boolean;
}

/** The facts of `frame`; undefined when absent, null, or no longer readable. */
function frameFactsOf(
  frame: RequestFrame | null | undefined,
): FrameFacts | undefined {
  if (frame === undefined || frame === null) {
    return undefined;
  }
  try {
    const { url, parent } = frame;
    return {
      url: String(url),
      parentUrl: parent === null ? null : String(parent.url),
      parentIsTop: parent === null || parent.parent === null,
    };
  } catch {
    return undefined;
  }
}

/** Whether `url` is a `pack:` URL. */
function isPackUrl(url: string): boolean {
  return parseUrl(url)?.protocol === `${PACK_SCHEME}:`;
}

/** Who made the request of `details` (see Requester). Never throws. */
export function requesterOf(
  details: RequestDetails,
  env: WindowsEnvironment = currentEnvironment(),
): Requester {
  const frame = frameFactsOf(details.frame);
  if (
    frame !== undefined &&
    frame.parentUrl !== null &&
    frame.parentIsTop &&
    details.resourceType === 'subFrame' &&
    details.url === SANDBOX_DOCUMENT_URL &&
    rendererOfUrl(frame.parentUrl, env) === 'overlay' &&
    details.initiatorOrigin === describeUrlOrigin(frame.parentUrl)
  ) {
    return 'sandbox-document';
  }
  if (details.initiatorOrigin === 'null') {
    return 'sandbox';
  }
  if (frame === undefined) {
    return 'unknown';
  }
  if (frame.parentUrl !== null || isPackUrl(frame.url)) {
    return 'sandbox';
  }
  if (rendererOfUrl(frame.url, env) !== undefined) {
    return 'stage-page';
  }
  if (
    details.resourceType === 'mainFrame' &&
    rendererOfUrl(details.url, env) !== undefined
  ) {
    return 'stage-page';
  }
  return 'page';
}

/** The webRequest decision for a request, and who made it (read once). */
export interface RequestDecision {
  readonly allowed: boolean;
  readonly requester: Requester;
}

/**
 * The webRequest decision for `details`: a sandbox's request is cancelled
 * whatever it is for, and the overlay loading the sandbox document goes
 * through. Any other request goes through when isAllowedRequestUrl allows
 * its URL, except that a dev server (or its HMR socket) is reached only
 * from a stage page (requesterOf: a renderer's top frame); when who made
 * the request is unknown, it is not. The requester comes with it, read
 * from the frame once (a frame can go away in between). Never throws.
 */
export function requestDecision(
  details: RequestDetails,
  env: WindowsEnvironment = currentEnvironment(),
): RequestDecision {
  const requester = requesterOf(details, env);
  return { allowed: isAllowedFor(requester, details.url, env), requester };
}

function isAllowedFor(
  requester: Requester,
  url: string,
  env: WindowsEnvironment,
): boolean {
  if (requester === 'sandbox') {
    return false;
  }
  if (requester === 'sandbox-document') {
    return true;
  }
  const parsed = parseUrl(url);
  if (parsed === undefined || !isAllowedRequestUrl(url, env)) {
    return false;
  }
  if (isDevServerRequestUrl(parsed, env)) {
    return requester === 'stage-page';
  }
  return true;
}

/** requestDecision's answer alone. Never throws. */
export function isAllowedRequest(
  details: RequestDetails,
  env: WindowsEnvironment = currentEnvironment(),
): boolean {
  return requestDecision(details, env).allowed;
}

/**
 * A short, query-free description of where `url` points, for the run log:
 * its origin, or its scheme when it has no origin (`data:`, `file:`…).
 */
export function describeUrlOrigin(url: string): string {
  const parsed = parseUrl(url);
  if (parsed === undefined) {
    return '(invalid URL)';
  }
  if (parsed.origin !== 'null') {
    return parsed.origin;
  }
  // Custom schemes Node does not know as "special" have an opaque origin;
  // keep their host so app://panels and pack://<id> stay distinguishable.
  return parsed.host === ''
    ? parsed.protocol
    : `${parsed.protocol}//${parsed.host}`;
}
