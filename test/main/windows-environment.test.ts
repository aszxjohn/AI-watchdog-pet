import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentEnvironment,
  describeUrlOrigin,
  devServersOf,
  isAllowedNavigationUrl,
  isAllowedRequestUrl,
  rendererOfUrl,
  type WindowsEnvironment,
} from '../../src/main/windows/environment';
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
    ['devtools://devtools/bundled/inspector.html', true, true],
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
