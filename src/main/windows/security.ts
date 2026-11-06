/**
 * The runtime half of AD-24 and NFR5 for every window and the session they
 * share. (The static half is lint and dependency-cruiser; the per-window
 * webPreferences are in panel-window.ts and canvas-window.ts.)
 *
 * - Every `window` webContents: `window.open` and `target=_blank` are
 *   denied, a frame may only navigate where environment.ts allows, and no
 *   `<webview>` may attach.
 * - The default session: every permission request and permission check is
 *   denied, and so is every device (HID, serial, USB) permission; every request
 *   to a URL environment.ts does not allow is cancelled, and each such
 *   origin is logged once; while not packaged, each dev server's (panels,
 *   overlay) responses get the dev CSP header for that origin (csp.ts).
 *
 * The decisions are pure functions over a WindowsEnvironment; the install
 * functions only wire them to Electron.
 */
import type { App, Session } from 'electron';
import { logEvent } from '../log/run-log';
import { devServerCsp } from './csp';
import {
  describeUrlOrigin,
  devServersOf,
  isAllowedNavigationUrl,
  isAllowedRequestUrl,
  type WindowsEnvironment,
} from './environment';

/** The parts of a webContents the guards touch. */
export interface GuardedContents {
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: 'deny' },
  ): void;
  on(
    event: 'will-frame-navigate',
    listener: (event: { url: string; preventDefault(): void }) => void,
  ): unknown;
  on(
    event: 'will-attach-webview',
    listener: (event: { preventDefault(): void }) => void,
  ): unknown;
}

/**
 * Denies new windows, navigation outside the allowlist and `<webview>` on
 * `contents`.
 */
export function guardWebContents(
  contents: GuardedContents,
  env: WindowsEnvironment,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    logEvent('windows', `new window denied: ${describeUrlOrigin(url)}`, 'warn');
    return { action: 'deny' };
  });
  contents.on('will-frame-navigate', (event) => {
    if (!isAllowedNavigationUrl(event.url, env)) {
      event.preventDefault();
      logEvent(
        'windows',
        `navigation blocked: ${describeUrlOrigin(event.url)}`,
        'warn',
      );
    }
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logEvent('windows', 'webview blocked', 'warn');
  });
}

/**
 * Guards every webContents of type `window` as it is created, so no window
 * can be opened without them. Call once, before any window exists.
 */
export function installWebContentsGuards(
  app: Pick<App, 'on'>,
  env: WindowsEnvironment,
): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'window') {
      guardWebContents(contents, env);
    }
  });
}

/**
 * The webRequest decision: allowed URLs go through; any other is
 * cancelled, and the first cancelled request to each origin is logged.
 */
export function createRequestFilter(
  env: WindowsEnvironment,
): (details: { url: string }) => { cancel: boolean } {
  const reported = new Set<string>();
  return ({ url }) => {
    if (isAllowedRequestUrl(url, env)) {
      return { cancel: false };
    }
    const origin = describeUrlOrigin(url);
    if (!reported.has(origin)) {
      reported.add(origin);
      logEvent(
        'windows',
        `request blocked: ${origin} (later requests to it are blocked without a log line)`,
        'warn',
      );
    }
    return { cancel: true };
  };
}

/**
 * Response headers for a response from one of the dev servers, with that
 * server's dev CSP in place of any CSP it had; undefined (leave the response
 * alone) for any other URL or when there is no dev server.
 */
export function devCspHeaders(
  details: {
    url: string;
    responseHeaders?: Record<string, string | string[]>;
  },
  env: WindowsEnvironment,
): Record<string, string[]> | undefined {
  if (env.packaged) {
    return undefined;
  }
  let origin: string;
  try {
    origin = new URL(details.url).origin;
  } catch {
    return undefined;
  }
  if (!devServersOf(env).some((server) => server.origin === origin)) {
    return undefined;
  }
  const headers: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
    if (name.toLowerCase() !== 'content-security-policy') {
      headers[name] = Array.isArray(value) ? value : [value];
    }
  }
  headers['Content-Security-Policy'] = [devServerCsp(origin)];
  return headers;
}

/** The parts of a Session the guards touch. */
export type GuardedSession = Pick<
  Session,
  | 'setPermissionRequestHandler'
  | 'setPermissionCheckHandler'
  | 'setDevicePermissionHandler'
> & {
  readonly webRequest: Pick<
    Session['webRequest'],
    'onBeforeRequest' | 'onHeadersReceived'
  >;
};

/** Installs the session guards. Call once, after `ready`. */
export function installSessionGuards(
  session: GuardedSession,
  env: WindowsEnvironment,
): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);

  const filter = createRequestFilter(env);
  session.webRequest.onBeforeRequest((details, callback) => {
    callback(filter(details));
  });

  if (!env.packaged && devServersOf(env).length > 0) {
    session.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = devCspHeaders(details, env);
      callback(responseHeaders === undefined ? {} : { responseHeaders });
    });
  }
}
