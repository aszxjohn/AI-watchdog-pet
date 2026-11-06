import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowsEnvironment } from '../../src/main/windows/environment';
import { devServerCsp } from '../../src/main/windows/csp';
import {
  createRequestFilter,
  devCspHeaders,
  guardWebContents,
  installSessionGuards,
  installWebContentsGuards,
  type GuardedContents,
  type GuardedSession,
} from '../../src/main/windows/security';

vi.mock('electron', () => import('../helpers/fake-electron'));

const DEV_ORIGIN = 'http://localhost:5173';
const PACKAGED: WindowsEnvironment = {
  packaged: true,
  devServerUrl: undefined,
  devServerOrigin: undefined,
};
const DEV: WindowsEnvironment = {
  packaged: false,
  devServerUrl: DEV_ORIGIN,
  devServerOrigin: DEV_ORIGIN,
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** `[windows] …` lines logged at warn level. */
function warnings(): string[] {
  return warn.mock.calls.map((call: unknown[]) => String(call[0]));
}

/** A fake webContents that records the guards installed on it. */
function fakeContents(type = 'window') {
  let openHandler: ((details: { url: string }) => { action: string }) | null =
    null;
  let navigate: ((event: NavigateEvent) => void) | null = null;
  let attachWebview: ((event: { preventDefault(): void }) => void) | null =
    null;
  const contents = {
    getType: () => type,
    setWindowOpenHandler: vi.fn((handler: typeof openHandler) => {
      openHandler = handler;
    }),
    on: vi.fn((event: string, listener: (event: never) => void) => {
      if (event === 'will-frame-navigate') {
        navigate = listener as (event: NavigateEvent) => void;
      }
      if (event === 'will-attach-webview') {
        attachWebview = listener as (event: { preventDefault(): void }) => void;
      }
    }),
  };
  return {
    contents,
    open: (url: string) => openHandler?.({ url }),
    /** Fires will-frame-navigate; answers whether it was prevented. */
    navigate(url: string): boolean {
      const event = { url, preventDefault: vi.fn() };
      navigate?.(event);
      return event.preventDefault.mock.calls.length > 0;
    },
    /** Fires will-attach-webview; answers whether it was prevented. */
    attachWebview(): boolean {
      const event = { preventDefault: vi.fn() };
      attachWebview?.(event);
      return event.preventDefault.mock.calls.length > 0;
    },
    guarded: () =>
      openHandler !== null && navigate !== null && attachWebview !== null,
  };
}

interface NavigateEvent {
  url: string;
  preventDefault(): void;
}

describe('guardWebContents: new windows', () => {
  it.each([
    ['https://example.com/'],
    ['app://panels/index.html'],
    ['about:blank'],
  ])('denies window.open / target=_blank to %s and logs it', (url) => {
    const fake = fakeContents();
    guardWebContents(fake.contents as unknown as GuardedContents, DEV);
    expect(fake.open(url)).toStrictEqual({ action: 'deny' });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(/^\[windows\] new window denied: /);
  });

  it('logs the origin only, not the path or query', () => {
    const fake = fakeContents();
    guardWebContents(fake.contents as unknown as GuardedContents, DEV);
    fake.open('https://example.com/a/b?token=secret');
    expect(warnings()).toStrictEqual([
      '[windows] new window denied: https://example.com',
    ]);
  });
});

describe('guardWebContents: navigation', () => {
  it.each([
    ['app://panels/index.html#/packs', false, false],
    ['pack://_stage/sandbox.html', false, false],
    [`${DEV_ORIGIN}/index.html`, true, false],
    ['https://example.com/', true, true],
    ['file:///etc/passwd', true, true],
    ['http://localhost:5174/', true, true],
  ])('%s: blocked when packaged %s, in dev %s', (url, packaged, dev) => {
    for (const [env, blocked] of [
      [PACKAGED, packaged],
      [DEV, dev],
    ] as const) {
      const fake = fakeContents();
      guardWebContents(fake.contents as unknown as GuardedContents, env);
      expect(fake.navigate(url)).toBe(blocked);
    }
  });

  it('logs a blocked navigation once per attempt', () => {
    const fake = fakeContents();
    guardWebContents(fake.contents as unknown as GuardedContents, PACKAGED);
    fake.navigate('https://example.com/x?q=1');
    fake.navigate('app://panels/index.html');
    expect(warnings()).toStrictEqual([
      '[windows] navigation blocked: https://example.com',
    ]);
  });
});

describe('guardWebContents: webview', () => {
  it.each([[PACKAGED], [DEV]])('blocks every <webview> and logs it', (env) => {
    const fake = fakeContents();
    guardWebContents(fake.contents as unknown as GuardedContents, env);
    expect(fake.attachWebview()).toBe(true);
    expect(fake.attachWebview()).toBe(true);
    expect(warnings()).toStrictEqual([
      '[windows] webview blocked',
      '[windows] webview blocked',
    ]);
  });
});

describe('installWebContentsGuards', () => {
  function capture() {
    let created: ((event: unknown, contents: unknown) => void) | undefined;
    const app = {
      on: vi.fn(
        (event: string, listener: (event: unknown, c: unknown) => void) => {
          if (event === 'web-contents-created') {
            created = listener;
          }
        },
      ),
    };
    installWebContentsGuards(app as never, PACKAGED);
    return (contents: unknown) => created?.({}, contents);
  }

  it('guards every window webContents as it is created', () => {
    const create = capture();
    const fake = fakeContents('window');
    create(fake.contents);
    expect(fake.guarded()).toBe(true);
    expect(fake.navigate('https://example.com/')).toBe(true);
    expect(fake.open('https://example.com/')).toStrictEqual({
      action: 'deny',
    });
  });

  it.each([['remote'], ['webview'], ['backgroundPage'], ['offscreen']])(
    'leaves %s webContents alone',
    (type) => {
      const create = capture();
      const fake = fakeContents(type);
      create(fake.contents);
      expect(fake.guarded()).toBe(false);
    },
  );
});

describe('createRequestFilter', () => {
  it.each([
    ['app://panels/assets/index.js', false, false],
    ['pack://some-pack/1.0.0/a.png', false, false],
    ['devtools://devtools/bundled/inspector.html', false, false],
    [`${DEV_ORIGIN}/@vite/client`, true, false],
    ['ws://localhost:5173/?token=1', true, false],
    ['https://example.com/x.js', true, true],
    ['wss://example.com/socket', true, true],
    ['http://127.0.0.1:5173/', true, true],
  ])('%s: cancelled when packaged %s, in dev %s', (url, packaged, dev) => {
    expect(createRequestFilter(PACKAGED)({ url })).toStrictEqual({
      cancel: packaged,
    });
    expect(createRequestFilter(DEV)({ url })).toStrictEqual({ cancel: dev });
  });

  it('logs each blocked origin once', () => {
    const filter = createRequestFilter(PACKAGED);
    filter({ url: 'https://example.com/a.js' });
    filter({ url: 'https://example.com/b.js?x=1' });
    filter({ url: 'wss://example.com/socket' });
    filter({ url: 'https://other.example/' });
    filter({ url: 'app://panels/index.html' });
    filter({ url: 'https://other.example/again' });
    expect(warnings()).toStrictEqual([
      '[windows] request blocked: https://example.com (later requests to it are blocked without a log line)',
      '[windows] request blocked: wss://example.com (later requests to it are blocked without a log line)',
      '[windows] request blocked: https://other.example (later requests to it are blocked without a log line)',
    ]);
  });
});

describe('devCspHeaders', () => {
  it('adds the dev CSP to dev server responses, replacing any CSP they had', () => {
    expect(
      devCspHeaders(
        {
          url: `${DEV_ORIGIN}/`,
          responseHeaders: {
            'Content-Type': ['text/html'],
            'content-security-policy': ["script-src 'unsafe-eval'"],
            'Cache-Control': 'no-cache',
          },
        },
        DEV,
      ),
    ).toStrictEqual({
      'Content-Type': ['text/html'],
      'Cache-Control': ['no-cache'],
      'Content-Security-Policy': [devServerCsp(DEV_ORIGIN)],
    });
  });

  it('handles a response with no headers', () => {
    expect(devCspHeaders({ url: `${DEV_ORIGIN}/x.js` }, DEV)).toStrictEqual({
      'Content-Security-Policy': [devServerCsp(DEV_ORIGIN)],
    });
  });

  it.each([
    ['app://panels/index.html'],
    ['http://localhost:5174/'],
    ['https://example.com/'],
    ['not a url'],
  ])('leaves %s alone', (url) => {
    expect(devCspHeaders({ url }, DEV)).toBeUndefined();
  });

  it('does nothing once packaged', () => {
    expect(
      devCspHeaders({ url: `${DEV_ORIGIN}/` }, { ...DEV, packaged: true }),
    ).toBeUndefined();
    expect(devCspHeaders({ url: `${DEV_ORIGIN}/` }, PACKAGED)).toBeUndefined();
  });
});

describe('installSessionGuards', () => {
  function fakeSession() {
    const session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: vi.fn(),
        onHeadersReceived: vi.fn(),
      },
    };
    return session;
  }

  it.each([
    ['notifications'],
    ['media'],
    ['geolocation'],
    ['clipboard-read'],
    ['openExternal'],
  ])('denies the %s permission', (permission) => {
    const session = fakeSession();
    installSessionGuards(session as unknown as GuardedSession, PACKAGED);
    const handler = session.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void;
    const callback = vi.fn();
    handler({}, permission, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([['notifications'], ['media'], ['clipboard-read'], ['hid']])(
    'answers false to a %s permission check',
    (permission) => {
      const session = fakeSession();
      installSessionGuards(session as unknown as GuardedSession, PACKAGED);
      const handler = session.setPermissionCheckHandler.mock.calls[0]?.[0] as (
        contents: unknown,
        permission: string,
        origin: string,
        details: object,
      ) => boolean;
      expect(handler({}, permission, 'app://panels', {})).toBe(false);
    },
  );

  it.each([['hid'], ['serial'], ['usb']])(
    'denies %s device permission',
    (deviceType) => {
      const session = fakeSession();
      installSessionGuards(session as unknown as GuardedSession, DEV);
      const handler = session.setDevicePermissionHandler.mock.calls[0]?.[0] as (
        details: object,
      ) => boolean;
      expect(handler({ deviceType, origin: 'app://panels', device: {} })).toBe(
        false,
      );
    },
  );

  it('cancels outside requests through webRequest', () => {
    const session = fakeSession();
    installSessionGuards(session as unknown as GuardedSession, PACKAGED);
    const listener = session.webRequest.onBeforeRequest.mock.calls[0]?.[0] as (
      details: { url: string },
      callback: (response: { cancel: boolean }) => void,
    ) => void;
    const callback = vi.fn();
    listener({ url: 'https://example.com/' }, callback);
    listener({ url: 'app://panels/index.html' }, callback);
    expect(callback.mock.calls).toStrictEqual([
      [{ cancel: true }],
      [{ cancel: false }],
    ]);
  });

  it('adds the dev CSP header only while not packaged', () => {
    const packaged = fakeSession();
    installSessionGuards(packaged as unknown as GuardedSession, PACKAGED);
    expect(packaged.webRequest.onHeadersReceived).not.toHaveBeenCalled();

    const dev = fakeSession();
    installSessionGuards(dev as unknown as GuardedSession, DEV);
    const listener = dev.webRequest.onHeadersReceived.mock.calls[0]?.[0] as (
      details: { url: string; responseHeaders?: Record<string, string[]> },
      callback: (response: object) => void,
    ) => void;
    const callback = vi.fn();
    listener({ url: `${DEV_ORIGIN}/`, responseHeaders: {} }, callback);
    listener({ url: 'app://panels/index.html' }, callback);
    expect(callback.mock.calls).toStrictEqual([
      [
        {
          responseHeaders: {
            'Content-Security-Policy': [devServerCsp(DEV_ORIGIN)],
          },
        },
      ],
      [{}],
    ]);
  });
});
