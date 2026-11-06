/**
 * The one place that decides which environment main runs in and which URLs
 * that environment allows (AD-24). Every other module asks here instead of
 * reading `app.isPackaged` or the Forge dev server constants itself.
 *
 * - Packaged: pages come from `app://`; nothing else is allowed.
 * - `npm start` (`!app.isPackaged`): each renderer (panels, overlay) comes
 *   from its own Vite dev server, so those origins (http) and their HMR
 *   sockets (ws, same host and port) are allowed as well.
 *
 * The URL checks are pure: they take the environment as an argument and
 * never throw.
 */
import { app } from 'electron';
import { APP_SCHEME, PACK_SCHEME } from '../../shared/constants';
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
 * Whether the session may make a request to `url` (`webRequest`): `app:`,
 * `pack:` and `devtools:` (DevTools' own pages), plus, while not packaged,
 * each dev server over http and its HMR WebSocket over ws on the same host
 * and port. Everything else, http(s) and ws(s) to anywhere included, is
 * cancelled (AD-26: the app makes no outside requests).
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
    parsed.protocol === `${PACK_SCHEME}:` ||
    parsed.protocol === 'devtools:'
  ) {
    return true;
  }
  return devServersOf(env).some((server) => {
    if (parsed.origin === server.origin) {
      return true;
    }
    // The HMR socket: ws:// (or wss:// for an https dev server), same host:port.
    const dev = new URL(server.origin);
    const socketProtocol = dev.protocol === 'https:' ? 'wss:' : 'ws:';
    return parsed.protocol === socketProtocol && parsed.host === dev.host;
  });
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
