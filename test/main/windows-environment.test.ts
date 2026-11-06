import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentEnvironment,
  describeUrlOrigin,
  isAllowedFrameUrl,
  isAllowedNavigationUrl,
  isAllowedRequestUrl,
  type WindowsEnvironment,
} from '../../src/main/windows/environment';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

const DEV_URL = 'http://localhost:5173';

const PACKAGED: WindowsEnvironment = {
  packaged: true,
  devServerUrl: undefined,
  devServerOrigin: undefined,
};
const DEV: WindowsEnvironment = {
  packaged: false,
  devServerUrl: DEV_URL,
  devServerOrigin: DEV_URL,
};

beforeEach(() => {
  fake.resetFakeElectron();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('currentEnvironment', () => {
  it('reports the dev server under npm start', () => {
    vi.stubGlobal('PANELS_VITE_DEV_SERVER_URL', DEV_URL);
    expect(currentEnvironment()).toStrictEqual(DEV);
  });

  it('keeps the dev server URL as given and derives its origin', () => {
    vi.stubGlobal('PANELS_VITE_DEV_SERVER_URL', 'http://127.0.0.1:5174/');
    expect(currentEnvironment()).toStrictEqual({
      packaged: false,
      devServerUrl: 'http://127.0.0.1:5174/',
      devServerOrigin: 'http://127.0.0.1:5174',
    });
  });

  it('ignores the dev server once packaged', () => {
    fake.app.isPackaged = true;
    vi.stubGlobal('PANELS_VITE_DEV_SERVER_URL', DEV_URL);
    expect(currentEnvironment()).toStrictEqual(PACKAGED);
  });

  it.each([
    ['not defined', undefined],
    ['empty', ''],
    ['not a URL', 'localhost:5173 nonsense'],
    ['not http(s)', 'file:///tmp/index.html'],
    ['not a string', 5173],
  ])('has no dev server when the constant is %s', (_name, value) => {
    if (value !== undefined) {
      vi.stubGlobal('PANELS_VITE_DEV_SERVER_URL', value);
    }
    expect(currentEnvironment()).toStrictEqual({
      packaged: false,
      devServerUrl: undefined,
      devServerOrigin: undefined,
    });
  });

  it('is what the URL checks use by default', () => {
    vi.stubGlobal('PANELS_VITE_DEV_SERVER_URL', DEV_URL);
    expect(isAllowedFrameUrl(`${DEV_URL}/#/packs`)).toBe(true);
    fake.app.isPackaged = true;
    expect(isAllowedFrameUrl(`${DEV_URL}/#/packs`)).toBe(false);
  });
});

describe('isAllowedFrameUrl (IPC senders)', () => {
  it.each([
    ['app://panels/index.html', true, true],
    ['app://panels/index.html#/packs', true, true],
    ['app://overlay/index.html', true, true],
    [`${DEV_URL}/`, false, true],
    [`${DEV_URL}/index.html#/sessions`, false, true],
    ['pack://some-pack/1.0.0/index.html', false, false],
    ['http://localhost:5174/', false, false],
    ['http://127.0.0.1:5173/', false, false],
    ['https://example.com/', false, false],
    ['file:///tmp/index.html', false, false],
    ['devtools://devtools/bundled/inspector.html', false, false],
    ['about:blank', false, false],
    ['not a url', false, false],
    ['', false, false],
  ])('%s: packaged %s, dev %s', (url, packaged, dev) => {
    expect(isAllowedFrameUrl(url, PACKAGED)).toBe(packaged);
    expect(isAllowedFrameUrl(url, DEV)).toBe(dev);
  });
});

describe('isAllowedNavigationUrl (will-frame-navigate)', () => {
  it.each([
    ['app://panels/index.html', true, true],
    ['pack://_stage/sandbox.html', true, true],
    ['pack://some-pack/1.0.0/sprite.png', true, true],
    [`${DEV_URL}/`, false, true],
    [`${DEV_URL}/index.html`, false, true],
    ['ws://localhost:5173/', false, false],
    ['http://localhost:5174/', false, false],
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
    ['wss://localhost:5173/', false, false],
    ['ws://localhost:5174/', false, false],
    ['ws://127.0.0.1:5173/', false, false],
    ['http://localhost:5174/', false, false],
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
      devServerUrl: 'https://localhost:5173',
      devServerOrigin: 'https://localhost:5173',
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
