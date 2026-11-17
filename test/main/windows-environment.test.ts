import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentEnvironment,
  describeUrlOrigin,
  devServersOf,
  isAllowedNavigationUrl,
  isAllowedRequest,
  isAllowedRequestUrl,
  isDevelopment,
  rendererOfUrl,
  requestDecision,
  requesterOf,
  type RequestDetails,
  type RequestFrame,
  type WindowsEnvironment,
} from '../../src/main/windows/environment';
import { SANDBOX_DOCUMENT_URL } from '../../src/shared/sandbox';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

const DEV_URL = 'http://localhost:5173';
const OVERLAY_DEV_URL = 'http://localhost:5174';

const PACKAGED: WindowsEnvironment = {
  packaged: true,
  devServers: { panels: undefined, overlay: undefined },
};
const DEV: WindowsEnvironment = {
  packaged: false,
  devServers: {
    panels: { url: DEV_URL, origin: DEV_URL },
    overlay: { url: OVERLAY_DEV_URL, origin: OVERLAY_DEV_URL },
  },
};
/** Not packaged, but Forge defined no dev server. */
const NO_DEV_SERVERS: WindowsEnvironment = {
  packaged: false,
  devServers: { panels: undefined, overlay: undefined },
};

beforeEach(() => {
  fake.resetFakeElectron();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('currentEnvironment', () => {
  it('reports both dev servers under npm start', () => {
    vi.stubGlobal('PANELS_VITE_DEV_SERVER_URL', DEV_URL);
    vi.stubGlobal('OVERLAY_VITE_DEV_SERVER_URL', OVERLAY_DEV_URL);
    expect(currentEnvironment()).toStrictEqual(DEV);
  });

  it('keeps each dev server URL as given and derives its origin', () => {
    vi.stubGlobal('PANELS_VITE_DEV_SERVER_URL', 'http://127.0.0.1:5174/');
    vi.stubGlobal('OVERLAY_VITE_DEV_SERVER_URL', 'http://127.0.0.1:5175/x');
    expect(currentEnvironment()).toStrictEqual({
      packaged: false,
      devServers: {
        panels: {
          url: 'http://127.0.0.1:5174/',
          origin: 'http://127.0.0.1:5174',
        },
        overlay: {
          url: 'http://127.0.0.1:5175/x',
          origin: 'http://127.0.0.1:5175',
        },
      },
    });
  });

  it('ignores the dev servers once packaged', () => {
    fake.app.isPackaged = true;
    vi.stubGlobal('PANELS_VITE_DEV_SERVER_URL', DEV_URL);
    vi.stubGlobal('OVERLAY_VITE_DEV_SERVER_URL', OVERLAY_DEV_URL);
    expect(currentEnvironment()).toStrictEqual(PACKAGED);
  });

  it.each([
    ['not defined', undefined],
    ['empty', ''],
    ['not a URL', 'localhost:5173 nonsense'],
    ['not http(s)', 'file:///tmp/index.html'],
    ['not a string', 5173],
  ])('has no dev server when a constant is %s', (_name, value) => {
    if (value !== undefined) {
      vi.stubGlobal('PANELS_VITE_DEV_SERVER_URL', value);
      vi.stubGlobal('OVERLAY_VITE_DEV_SERVER_URL', value);
    }
    expect(currentEnvironment()).toStrictEqual(NO_DEV_SERVERS);
  });

  it('reads each renderer constant on its own', () => {
    vi.stubGlobal('OVERLAY_VITE_DEV_SERVER_URL', OVERLAY_DEV_URL);
    expect(currentEnvironment()).toStrictEqual({
      packaged: false,
      devServers: {
        panels: undefined,
        overlay: { url: OVERLAY_DEV_URL, origin: OVERLAY_DEV_URL },
      },
    });
  });

  it('is what the URL checks use by default', () => {
    vi.stubGlobal('PANELS_VITE_DEV_SERVER_URL', DEV_URL);
    vi.stubGlobal('OVERLAY_VITE_DEV_SERVER_URL', OVERLAY_DEV_URL);
    expect(rendererOfUrl(`${DEV_URL}/#/packs`)).toBe('panels');
    expect(rendererOfUrl(`${OVERLAY_DEV_URL}/`)).toBe('overlay');
    fake.app.isPackaged = true;
    expect(rendererOfUrl(`${DEV_URL}/#/packs`)).toBeUndefined();
    expect(rendererOfUrl(`${OVERLAY_DEV_URL}/`)).toBeUndefined();
  });
});

describe('devServersOf', () => {
  it('lists the dev servers there are, panels first', () => {
    expect(devServersOf(DEV)).toStrictEqual([
      { url: DEV_URL, origin: DEV_URL },
      { url: OVERLAY_DEV_URL, origin: OVERLAY_DEV_URL },
    ]);
    expect(devServersOf(PACKAGED)).toStrictEqual([]);
    expect(devServersOf(NO_DEV_SERVERS)).toStrictEqual([]);
  });
});

describe('rendererOfUrl (IPC senders and push targets)', () => {
  it.each([
    ['app://panels/index.html', 'panels', 'panels'],
    ['app://panels/index.html#/packs', 'panels', 'panels'],
    ['app://panels/', 'panels', 'panels'],
    ['app://overlay/index.html', 'overlay', 'overlay'],
    [`${DEV_URL}/`, undefined, 'panels'],
    [`${DEV_URL}/index.html#/sessions`, undefined, 'panels'],
    [`${OVERLAY_DEV_URL}/`, undefined, 'overlay'],
    [`${OVERLAY_DEV_URL}/index.html`, undefined, 'overlay'],
    ['app://secret/index.html', undefined, undefined],
    ['app://panels:8080/index.html', undefined, undefined],
    ['app://overlayx/index.html', undefined, undefined],
    ['pack://some-pack/1.0.0/index.html', undefined, undefined],
    ['pack://panels/index.html', undefined, undefined],
    ['http://localhost:5175/', undefined, undefined],
    ['http://127.0.0.1:5173/', undefined, undefined],
    ['https://localhost:5173/', undefined, undefined],
    ['ws://localhost:5173/', undefined, undefined],
    ['https://example.com/', undefined, undefined],
    ['file:///tmp/index.html', undefined, undefined],
    ['devtools://devtools/bundled/inspector.html', undefined, undefined],
    ['about:blank', undefined, undefined],
    ['not a url', undefined, undefined],
    ['', undefined, undefined],
  ])('%s: packaged %s, dev %s', (url, packaged, dev) => {
    expect(rendererOfUrl(url, PACKAGED)).toBe(packaged);
    expect(rendererOfUrl(url, DEV)).toBe(dev);
  });
});

describe('isAllowedNavigationUrl (will-frame-navigate)', () => {
  it.each([
    ['app://panels/index.html', true, true],
    ['pack://_stage/sandbox.html', true, true],
    ['pack://some-pack/1.0.0/sprite.png', true, true],
    [`${DEV_URL}/`, false, true],
    [`${DEV_URL}/index.html`, false, true],
    [`${OVERLAY_DEV_URL}/`, false, true],
    ['ws://localhost:5173/', false, false],
    ['http://localhost:5175/', false, false],
    ['https://localhost:5173/', false, false],
    ['https://example.com/', false, false],
    ['http://example.com/', false, false],
    ['file:///etc/passwd', false, false],
    ['data:text/html,<p>hi</p>', false, false],
    ['javascript:alert(1)', false, false],
    ['devtools://devtools/bundled/inspector.html', false, false],
    ['about:blank', false, false],
    ['not a url', false, false],
  ])('%s: packaged %s, dev %s', (url, packaged, dev) => {
    expect(isAllowedNavigationUrl(url, PACKAGED)).toBe(packaged);
    expect(isAllowedNavigationUrl(url, DEV)).toBe(dev);
  });
});

describe('isAllowedRequestUrl (webRequest)', () => {
  it.each([
    ['app://panels/assets/index.js', true, true],
    ['pack://some-pack/1.0.0/sprite.png', true, true],
    ['devtools://devtools/bundled/inspector.html', false, true],
    [`${DEV_URL}/@vite/client`, false, true],
    [`${DEV_URL}/node_modules/.vite/deps/react.js?v=1`, false, true],
    ['ws://localhost:5173/?token=abc', false, true],
    [`${OVERLAY_DEV_URL}/@vite/client`, false, true],
    [`${OVERLAY_DEV_URL}/node_modules/.vite/deps/pixi__js.js`, false, true],
    ['ws://localhost:5174/?token=abc', false, true],
    ['wss://localhost:5173/', false, false],
    ['ws://localhost:5175/', false, false],
    ['ws://127.0.0.1:5173/', false, false],
    ['http://localhost:5175/', false, false],
    ['https://example.com/x.js', false, false],
    ['http://example.com/', false, false],
    ['wss://example.com/socket', false, false],
    ['ftp://example.com/', false, false],
    ['file:///etc/passwd', false, false],
    ['not a url', false, false],
  ])('%s: packaged %s, dev %s', (url, packaged, dev) => {
    expect(isAllowedRequestUrl(url, PACKAGED)).toBe(packaged);
    expect(isAllowedRequestUrl(url, DEV)).toBe(dev);
  });

  it('allows wss for an https dev server', () => {
    const https: WindowsEnvironment = {
      packaged: false,
      devServers: {
        panels: {
          url: 'https://localhost:5173',
          origin: 'https://localhost:5173',
        },
        overlay: undefined,
      },
    };
    expect(isAllowedRequestUrl('wss://localhost:5173/', https)).toBe(true);
    expect(isAllowedRequestUrl('ws://localhost:5173/', https)).toBe(false);
  });

  it('allows devtools: only while there is a dev server (development needs DevTools)', () => {
    const devtools = 'devtools://devtools/bundled/inspector.html';
    expect(isAllowedRequestUrl(devtools, PACKAGED)).toBe(false);
    expect(isAllowedRequestUrl(devtools, NO_DEV_SERVERS)).toBe(false);
    expect(isAllowedRequestUrl(devtools, DEV)).toBe(true);
  });
});

// Requesting frames, shaped as Electron 45.2.1 gives them (measured, Story
// 3.5): see RequestDetails in environment.ts.
const OVERLAY_TOP: RequestFrame = {
  url: 'app://overlay/index.html',
  parent: null,
};
const PANELS_TOP: RequestFrame = {
  url: 'app://panels/index.html#/packs',
  parent: null,
};
const DEV_OVERLAY_TOP: RequestFrame = {
  url: `${OVERLAY_DEV_URL}/`,
  parent: null,
};
const DEV_PANELS_TOP: RequestFrame = {
  url: `${DEV_URL}/#/packs`,
  parent: null,
};
const DEVTOOLS_TOP: RequestFrame = {
  url: 'devtools://devtools/bundled/devtools_app.html',
  parent: null,
};
/** A window's top frame before its first page: what its navigation carries. */
const BLANK_TOP: RequestFrame = { url: '', parent: null };
/** A pack sandbox iframe in the overlay `top`; its Workers' requests carry it too. */
function sandboxIn(top: RequestFrame): RequestFrame {
  return { url: SANDBOX_DOCUMENT_URL, parent: top };
}
/** A new iframe in `parent`, not showing anything yet. */
function newFrameIn(parent: RequestFrame): RequestFrame {
  return { url: '', parent };
}
/** A frame that is gone: reading it throws, as WebFrameMain does. */
const GONE_FRAME = {
  get url(): string {
    throw new Error(
      'Render frame was disposed before WebFrameMain could be accessed',
    );
  },
  get parent(): RequestFrame | null {
    throw new Error(
      'Render frame was disposed before WebFrameMain could be accessed',
    );
  },
} as RequestFrame;

/** The overlay loading the sandbox document into a new iframe. */
function sandboxDocumentLoad(
  top: RequestFrame,
  initiatorOrigin: string | undefined,
): RequestDetails {
  return {
    url: SANDBOX_DOCUMENT_URL,
    resourceType: 'subFrame',
    frame: newFrameIn(top),
    webContentsId: 1,
    ...(initiatorOrigin === undefined ? {} : { initiatorOrigin }),
  };
}

/** A request the sandbox of `top` (its iframe or one of its Workers) makes. */
function fromSandbox(
  top: RequestFrame,
  url: string,
  resourceType = 'xhr',
): RequestDetails {
  return {
    url,
    resourceType,
    frame: sandboxIn(top),
    webContentsId: 1,
    initiatorOrigin: 'null',
  };
}

/** A request the top frame `top` makes, with its own origin as initiator. */
function fromTop(
  top: RequestFrame,
  url: string,
  resourceType = 'script',
): RequestDetails {
  return {
    url,
    resourceType,
    frame: top,
    webContentsId: 1,
    initiatorOrigin: describeUrlOrigin(top.url),
  };
}

describe('isDevelopment', () => {
  it('is true only with a dev server (npm start), not merely unpackaged', () => {
    expect(isDevelopment(DEV)).toBe(true);
    expect(isDevelopment(PACKAGED)).toBe(false);
    expect(isDevelopment(NO_DEV_SERVERS)).toBe(false);
  });
});

describe('requestDecision', () => {
  it('answers who made the request with the decision', () => {
    expect(
      requestDecision(
        fromSandbox(OVERLAY_TOP, 'pack://some-pack/1.0.0/a.png'),
        PACKAGED,
      ),
    ).toStrictEqual({ allowed: false, requester: 'sandbox' });
    expect(
      requestDecision(fromTop(DEV_OVERLAY_TOP, `${OVERLAY_DEV_URL}/a.ts`), DEV),
    ).toStrictEqual({ allowed: true, requester: 'stage-page' });
    expect(requestDecision({ url: `${DEV_URL}/a.ts` }, DEV)).toStrictEqual({
      allowed: false,
      requester: 'unknown',
    });
  });
});

describe('requesterOf (who made a request)', () => {
  it.each<[string, RequestDetails, WindowsEnvironment, string]>([
    [
      'the overlay',
      fromTop(OVERLAY_TOP, 'app://overlay/a.js'),
      PACKAGED,
      'stage-page',
    ],
    [
      'the panels',
      fromTop(PANELS_TOP, 'app://panels/a.js'),
      PACKAGED,
      'stage-page',
    ],
    [
      'the dev overlay',
      fromTop(DEV_OVERLAY_TOP, `${OVERLAY_DEV_URL}/a.ts`),
      DEV,
      'stage-page',
    ],
    [
      "a window's first navigation to a renderer",
      {
        url: 'app://panels/index.html',
        resourceType: 'mainFrame',
        frame: BLANK_TOP,
      },
      PACKAGED,
      'stage-page',
    ],
    [
      "a window's first navigation elsewhere",
      {
        url: 'https://example.com/',
        resourceType: 'mainFrame',
        frame: BLANK_TOP,
      },
      PACKAGED,
      'page',
    ],
    [
      'DevTools',
      fromTop(DEVTOOLS_TOP, 'devtools://devtools/x.js'),
      DEV,
      'page',
    ],
    [
      'the sandbox iframe',
      fromSandbox(OVERLAY_TOP, 'pack://_stage/x'),
      PACKAGED,
      'sandbox',
    ],
    [
      'an opaque initiator with no frame',
      { url: 'app://overlay/a.js', initiatorOrigin: 'null' },
      PACKAGED,
      'sandbox',
    ],
    [
      'an iframe of the panels',
      fromTop(newFrameIn(PANELS_TOP), 'app://panels/a.js'),
      PACKAGED,
      'sandbox',
    ],
    [
      'a top frame showing a pack: URL',
      fromTop({ url: SANDBOX_DOCUMENT_URL, parent: null }, 'pack://_stage/x'),
      PACKAGED,
      'sandbox',
    ],
    [
      'the overlay loading the sandbox document',
      sandboxDocumentLoad(OVERLAY_TOP, 'app://overlay'),
      PACKAGED,
      'sandbox-document',
    ],
    [
      'no frame and no initiator',
      { url: 'app://overlay/a.js' },
      PACKAGED,
      'unknown',
    ],
    [
      'a frame that is gone',
      { url: 'app://overlay/a.js', frame: GONE_FRAME },
      PACKAGED,
      'unknown',
    ],
  ])('%s', (_label, details, env, expected) => {
    expect(requesterOf(details, env)).toBe(expected);
  });
});

describe('I/O matrix', () => {
  it.each<[string, RequestDetails]>([
    [
      'the overlay requesting app://',
      fromTop(OVERLAY_TOP, 'app://overlay/assets/index.js'),
    ],
    [
      'the overlay requesting pack://',
      fromTop(OVERLAY_TOP, 'pack://some-pack/1.0.0/sprite.png', 'image'),
    ],
    [
      'the panels requesting app://',
      fromTop(PANELS_TOP, 'app://panels/assets/index.css', 'stylesheet'),
    ],
    [
      "a window's first navigation",
      {
        url: 'app://overlay/index.html',
        resourceType: 'mainFrame',
        frame: BLANK_TOP,
        webContentsId: 1,
      },
    ],
    [
      'no requester at all, for pack://',
      { url: 'pack://some-pack/1.0.0/sprite.png' },
    ],
  ])('正式版放行: %s: allowed', (_label, details) => {
    expect(isAllowedRequest(details, PACKAGED)).toBe(true);
  });

  it.each<[string]>([
    ['http://localhost:5173/'],
    ['http://127.0.0.1:5173/'],
    ['https://example.com/x.js'],
    ['ws://localhost:5173/'],
    ['wss://example.com/socket'],
    ['file:///etc/passwd'],
    ['devtools://devtools/bundled/inspector.html'],
    ['data:text/plain,x'],
  ])(
    '正式版放行: %s is cancelled, from the overlay, DevTools or no requester',
    (url) => {
      expect(isAllowedRequest(fromTop(OVERLAY_TOP, url), PACKAGED)).toBe(false);
      expect(isAllowedRequest(fromTop(DEVTOOLS_TOP, url), PACKAGED)).toBe(
        false,
      );
      expect(isAllowedRequest({ url }, PACKAGED)).toBe(false);
    },
  );

  it.each<[string, RequestDetails]>([
    [
      'the overlay: a module',
      fromTop(DEV_OVERLAY_TOP, `${OVERLAY_DEV_URL}/@vite/client`),
    ],
    [
      'the overlay: its HMR socket',
      fromTop(DEV_OVERLAY_TOP, 'ws://localhost:5174/?token=abc', 'webSocket'),
    ],
    [
      'the panels: a module',
      fromTop(DEV_PANELS_TOP, `${DEV_URL}/src/panels/main.tsx`),
    ],
    [
      'the panels: its HMR socket',
      fromTop(DEV_PANELS_TOP, 'ws://localhost:5173/?token=abc', 'webSocket'),
    ],
    [
      'a Worker the overlay started from the dev server (its requests carry the overlay frame)',
      fromTop(DEV_OVERLAY_TOP, `${OVERLAY_DEV_URL}/ping`, 'xhr'),
    ],
    [
      "a window's first navigation to its dev server",
      {
        url: `${DEV_URL}/`,
        resourceType: 'mainFrame',
        frame: BLANK_TOP,
        webContentsId: 1,
      },
    ],
    [
      'a reload of the overlay page',
      {
        url: `${OVERLAY_DEV_URL}/`,
        resourceType: 'mainFrame',
        frame: DEV_OVERLAY_TOP,
        webContentsId: 1,
      },
    ],
  ])('開發版 dev server: %s: allowed', (_label, details) => {
    expect(isAllowedRequest(details, DEV)).toBe(true);
  });

  it('開發版 dev server: DevTools itself still loads, but not from the dev server', () => {
    expect(
      isAllowedRequest(
        fromTop(DEVTOOLS_TOP, 'devtools://devtools/bundled/x.js'),
        DEV,
      ),
    ).toBe(true);
    expect(
      isAllowedRequest(
        fromTop(DEVTOOLS_TOP, `${DEV_URL}/src/main.tsx.map`),
        DEV,
      ),
    ).toBe(false);
  });

  it.each<[string]>([
    [`${DEV_URL}/@vite/client`],
    ['ws://localhost:5173/?token=abc'],
    [`${OVERLAY_DEV_URL}/@vite/client`],
    ['ws://localhost:5174/?token=abc'],
    ['pack://some-pack/1.0.0/sprite.png'],
    [SANDBOX_DOCUMENT_URL],
    ['app://overlay/index.html'],
    ['devtools://devtools/bundled/inspector.html'],
    ['http://127.0.0.1:9/'],
    ['https://example.com/'],
  ])(
    '沙盒發出: a request for %s from a sandbox iframe or its Workers is cancelled',
    (url) => {
      for (const [env, top] of [
        [PACKAGED, OVERLAY_TOP],
        [DEV, DEV_OVERLAY_TOP],
      ] as const) {
        expect(isAllowedRequest(fromSandbox(top, url), env)).toBe(false);
        expect(isAllowedRequest(fromSandbox(top, url, 'script'), env)).toBe(
          false,
        );
        expect(isAllowedRequest(fromSandbox(top, url, 'webSocket'), env)).toBe(
          false,
        );
      }
    },
  );

  it.each<[string, RequestDetails]>([
    [
      'an opaque initiator with no frame',
      { url: 'pack://some-pack/1.0.0/a.png', initiatorOrigin: 'null' },
    ],
    [
      'an opaque initiator from a frame that is gone',
      { url: 'app://overlay/a.js', frame: GONE_FRAME, initiatorOrigin: 'null' },
    ],
    [
      'an iframe in the sandbox',
      fromTop(
        newFrameIn(sandboxIn(OVERLAY_TOP)),
        'pack://some-pack/1.0.0/a.png',
      ),
    ],
    [
      'an iframe of the panels, even with its own origin',
      fromTop(newFrameIn(PANELS_TOP), 'app://panels/a.js'),
    ],
    [
      'a top frame showing a pack: URL',
      fromTop(
        { url: SANDBOX_DOCUMENT_URL, parent: null },
        'pack://some-pack/1.0.0/a.png',
      ),
    ],
    [
      'the sandbox reloading its own document',
      {
        ...sandboxDocumentLoad(OVERLAY_TOP, 'null'),
        frame: sandboxIn(OVERLAY_TOP),
      },
    ],
  ])('沙盒發出: %s is cancelled', (_label, details) => {
    expect(isAllowedRequest(details, PACKAGED)).toBe(false);
    expect(isAllowedRequest(details, DEV)).toBe(false);
  });

  it('沙盒文件: the overlay loading pack://_stage/sandbox.html into its iframe is allowed', () => {
    expect(
      isAllowedRequest(
        sandboxDocumentLoad(OVERLAY_TOP, 'app://overlay'),
        PACKAGED,
      ),
    ).toBe(true);
    expect(
      isAllowedRequest(
        sandboxDocumentLoad(DEV_OVERLAY_TOP, OVERLAY_DEV_URL),
        DEV,
      ),
    ).toBe(true);
    // Setting `src` again on an iframe that already shows it.
    expect(
      isAllowedRequest(
        {
          ...sandboxDocumentLoad(OVERLAY_TOP, 'app://overlay'),
          frame: sandboxIn(OVERLAY_TOP),
        },
        PACKAGED,
      ),
    ).toBe(true);
  });

  it.each<[string, RequestDetails]>([
    ['by the panels', sandboxDocumentLoad(PANELS_TOP, 'app://panels')],
    ['with an opaque initiator', sandboxDocumentLoad(OVERLAY_TOP, 'null')],
    ['with no initiator', sandboxDocumentLoad(OVERLAY_TOP, undefined)],
    [
      "with another page's origin as initiator",
      sandboxDocumentLoad(OVERLAY_TOP, 'app://panels'),
    ],
    [
      'into an iframe of the sandbox',
      {
        ...sandboxDocumentLoad(OVERLAY_TOP, 'app://overlay'),
        frame: newFrameIn(sandboxIn(OVERLAY_TOP)),
      },
    ],
    [
      'as anything but a subframe',
      {
        ...sandboxDocumentLoad(OVERLAY_TOP, 'app://overlay'),
        resourceType: 'xhr',
      },
    ],
    [
      'with a query',
      {
        ...sandboxDocumentLoad(OVERLAY_TOP, 'app://overlay'),
        url: `${SANDBOX_DOCUMENT_URL}?x=1`,
      },
    ],
    [
      "a pack's file instead",
      {
        ...sandboxDocumentLoad(OVERLAY_TOP, 'app://overlay'),
        url: 'pack://some-pack/1.0.0/a.html',
      },
    ],
  ])(
    '沙盒文件: loading it %s is cancelled (it is a non-top frame)',
    (_label, details) => {
      expect(isAllowedRequest(details, PACKAGED)).toBe(false);
    },
  );

  it.each<[string, RequestDetails]>([
    ['no frame, no initiator', { url: '' }],
    ['a null frame', { url: '', frame: null, resourceType: 'other' }],
    [
      'a frame that is gone',
      { url: '', frame: GONE_FRAME, resourceType: 'xhr' },
    ],
  ])(
    '不明發起者 (%s): the dev servers are cancelled; app:// and pack:// go through as before',
    (_label, base) => {
      for (const url of [
        `${DEV_URL}/@vite/client`,
        'ws://localhost:5173/?token=abc',
        `${OVERLAY_DEV_URL}/`,
        'ws://localhost:5174/',
      ]) {
        expect(isAllowedRequest({ ...base, url }, DEV)).toBe(false);
      }
      for (const env of [PACKAGED, DEV]) {
        expect(
          isAllowedRequest({ ...base, url: 'app://panels/index.html' }, env),
        ).toBe(true);
        expect(
          isAllowedRequest(
            { ...base, url: 'pack://some-pack/1.0.0/a.png' },
            env,
          ),
        ).toBe(true);
        expect(
          isAllowedRequest({ ...base, url: SANDBOX_DOCUMENT_URL }, env),
        ).toBe(true);
        expect(
          isAllowedRequest({ ...base, url: 'https://example.com/' }, env),
        ).toBe(false);
      }
    },
  );

  it('never throws, whatever the details', () => {
    expect(isAllowedRequest({ url: 'not a url', frame: GONE_FRAME }, DEV)).toBe(
      false,
    );
    expect(isAllowedRequest({ url: 'not a url' }, PACKAGED)).toBe(false);
  });
});

describe('describeUrlOrigin', () => {
  it.each([
    ['https://example.com/path?token=secret#x', 'https://example.com'],
    ['http://localhost:5173/a/b', 'http://localhost:5173'],
    ['ws://localhost:5173/?token=1', 'ws://localhost:5173'],
    ['app://panels/index.html#/packs', 'app://panels'],
    ['pack://some-pack/1.0.0/a.png', 'pack://some-pack'],
    ['data:text/html,<p>secret</p>', 'data:'],
    ['javascript:alert(1)', 'javascript:'],
    ['file:///Users/someone/file.txt', 'file:'],
    ['not a url', '(invalid URL)'],
  ])('%s -> %s', (url, expected) => {
    expect(describeUrlOrigin(url)).toBe(expected);
  });
});
