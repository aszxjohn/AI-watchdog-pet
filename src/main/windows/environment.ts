/**
 * The one place that decides which environment main runs in and which URLs
 * that environment allows (AD-24). Every other module asks here instead of
 * reading `app.isPackaged` or the Forge dev server constant itself.
 *
 * - Packaged: pages come from `app://`; nothing else is allowed.
 * - `npm start` (`!app.isPackaged`): the panels page comes from the Vite dev
 *   server, so its origin (http) and its HMR socket (ws, same host and port)
 *   are allowed as well.
 *
 * The URL checks are pure: they take the environment as an argument and
 * never throw.
 */
import { app } from 'electron';
import { APP_SCHEME, PACK_SCHEME } from '../../shared/constants';

export interface WindowsEnvironment {
  /** `app.isPackaged`. */
  readonly packaged: boolean;
  /**
   * The panels Vite dev server URL, only while not packaged and Forge
   * defined one; undefined otherwise.
   */
  readonly devServerUrl: string | undefined;
  /** Origin of `devServerUrl` (`http://localhost:5173`), or undefined. */
  readonly devServerOrigin: string | undefined;
}

/**
 * The environment right now. Forge's Vite plugin defines
 * PANELS_VITE_DEV_SERVER_URL at build time (a URL under `npm start`,
 * `undefined` once packaged); `typeof` keeps this safe where the constant is
 * not defined at all (unit tests).
 */
export function currentEnvironment(): WindowsEnvironment {
  const packaged = app.isPackaged;
  const devServerUrl =
    !packaged &&
    typeof PANELS_VITE_DEV_SERVER_URL === 'string' &&
    PANELS_VITE_DEV_SERVER_URL !== ''
      ? PANELS_VITE_DEV_SERVER_URL
      : undefined;
  const devServerOrigin = originOf(devServerUrl);
  return {
    packaged,
    devServerUrl: devServerOrigin === undefined ? undefined : devServerUrl,
    devServerOrigin,
  };
}

/** `http(s)://host:port` of `url`, or undefined when it has no such origin. */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  const parsed = parseUrl(url);
  if (
    parsed === undefined ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
  ) {
    return undefined;
  }
  return parsed.origin;
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Whether `url` is on the dev server: same scheme, host and port. */
function isDevServerUrl(parsed: URL, env: WindowsEnvironment): boolean {
  return (
    env.devServerOrigin !== undefined && parsed.origin === env.devServerOrigin
  );
}

/**
 * Whether a frame showing `url` may talk to main over IPC (main/ipc): an
 * `app://` page, or the dev server while not packaged.
 */
export function isAllowedFrameUrl(
  url: string,
  env: WindowsEnvironment = currentEnvironment(),
): boolean {
  const parsed = parseUrl(url);
  if (parsed === undefined) {
    return false;
  }
  return parsed.protocol === `${APP_SCHEME}:` || isDevServerUrl(parsed, env);
}

/**
 * Whether a frame may navigate to `url` (`will-frame-navigate`): `app://`,
 * `pack://`, and the dev server while not packaged.
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
 * the dev server over http and its HMR WebSocket over ws on the same host
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
  if (env.devServerOrigin === undefined) {
    return false;
  }
  if (isDevServerUrl(parsed, env)) {
    return true;
  }
  // The HMR socket: ws:// (or wss:// for an https dev server), same host:port.
  const dev = new URL(env.devServerOrigin);
  const socketProtocol = dev.protocol === 'https:' ? 'wss:' : 'ws:';
  return parsed.protocol === socketProtocol && parsed.host === dev.host;
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
