import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PACKAGED_CSP } from '../../src/main/windows/csp';
import {
  createAppProtocolHandler,
  panelsRendererDir,
  resolveAppFile,
  type AppProtocolFs,
} from '../../src/main/windows/protocols';

// A stand-in for electron's `protocol`.
const fake = vi.hoisted(() => ({
  registered: [] as unknown[][],
  handled: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: (schemes: unknown[]) => {
      fake.registered.push(schemes);
    },
    handle: (scheme: string, handler: unknown) => {
      fake.handled.set(scheme, handler);
    },
  },
}));

let tempRoot: string;
/** .vite/renderer/panels inside the temp folder. */
let panelsDir: string;
/** A file right next to the panels folder, which must never be served. */
let secretFile: string;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-app-protocol-'));
  panelsDir = path.join(tempRoot, '.vite', 'renderer', 'panels');
  fs.mkdirSync(path.join(panelsDir, 'assets', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(panelsDir, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(panelsDir, 'assets', 'index.js'), 'export {};');
  fs.writeFileSync(path.join(panelsDir, 'assets', 'index.css'), 'body{}');
  fs.writeFileSync(path.join(panelsDir, 'assets', 'Logo.SVG'), '<svg/>');
  fs.writeFileSync(path.join(panelsDir, 'assets', 'data.bin'), 'x');
  fs.writeFileSync(path.join(panelsDir, 'assets', 'sub', 'a b.png'), 'png');
  fs.mkdirSync(path.join(panelsDir, 'folder.js'));
  secretFile = path.join(tempRoot, '.vite', 'renderer', 'secret.txt');
  fs.writeFileSync(secretFile, 'secret');
  fs.writeFileSync(path.join(tempRoot, 'secret.txt'), 'secret');
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function handler(fsImpl?: AppProtocolFs) {
  return createAppProtocolHandler({
    roots: { panels: panelsDir },
    ...(fsImpl === undefined ? {} : { fs: fsImpl }),
  });
}

async function get(url: string, fsImpl?: AppProtocolFs) {
  const response = await handler(fsImpl)({ url });
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    csp: response.headers.get('content-security-policy'),
    body: await response.text(),
  };
}

describe('registerSchemes', () => {
  beforeEach(() => {
    fake.registered.length = 0;
    vi.resetModules();
  });

  it('registers app (standard, secure) and pack (standard, secure, corsEnabled), never bypassCSP', async () => {
    const { registerSchemes } =
      await import('../../src/main/windows/protocols');
    registerSchemes();
    expect(fake.registered).toStrictEqual([
      [
        { scheme: 'app', privileges: { standard: true, secure: true } },
        {
          scheme: 'pack',
          privileges: { standard: true, secure: true, corsEnabled: true },
        },
      ],
    ]);
  });

  it('can be called only once', async () => {
    const { registerSchemes } =
      await import('../../src/main/windows/protocols');
    registerSchemes();
    expect(() => registerSchemes()).toThrow(/only once/);
    expect(fake.registered).toHaveLength(1);
  });
});

describe('handleAppProtocol', () => {
  beforeEach(() => {
    fake.handled.clear();
  });

  it('serves app:// from .vite/renderer/panels next to the main bundle', async () => {
    const { handleAppProtocol } =
      await import('../../src/main/windows/protocols');
    handleAppProtocol(path.join(tempRoot, '.vite', 'build'));
    const serve = fake.handled.get('app') as (r: {
      url: string;
    }) => Promise<Response>;
    expect(serve).toBeTypeOf('function');
    const response = await serve({ url: 'app://panels/index.html' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<!doctype html>');
  });

  it('only handles app (pack:// is main/packs, Story 3.2)', async () => {
    const { handleAppProtocol } =
      await import('../../src/main/windows/protocols');
    handleAppProtocol(path.join(tempRoot, '.vite', 'build'));
    expect([...fake.handled.keys()]).toStrictEqual(['app']);
  });
});

describe('panelsRendererDir', () => {
  it('is ../renderer/panels from the build folder', () => {
    expect(panelsRendererDir(path.join('root', '.vite', 'build'))).toBe(
      path.join('root', '.vite', 'renderer', 'panels'),
    );
  });

  it('follows PANELS_VITE_NAME when Forge defines it', () => {
    vi.stubGlobal('PANELS_VITE_NAME', 'renamed-panels');
    try {
      expect(panelsRendererDir('build')).toBe(
        path.join('build', '..', 'renderer', 'renamed-panels'),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('app:// handler: served files', () => {
  it('serves index.html with the CSP header', async () => {
    const response = await get('app://panels/index.html');
    expect(response).toStrictEqual({
      status: 200,
      type: 'text/html; charset=utf-8',
      csp: PACKAGED_CSP,
      body: '<!doctype html>',
    });
  });

  it.each([['app://panels/'], ['app://panels'], ['app://panels/#/packs']])(
    'serves index.html for %s',
    async (url) => {
      const response = await get(url);
      expect(response.status).toBe(200);
      expect(response.csp).toBe(PACKAGED_CSP);
    },
  );

  // The URL parser resolves `.` and `..` segments (raw or %2e-encoded)
  // before the handler sees the path, and never above the host's root.
  it.each([
    ['app://panels/%2e/index.html'],
    ['app://panels/assets/../index.html'],
    ['app://panels/%2e%2e/%2e%2e/index.html'],
  ])('resolves dot segments in %s inside the folder', async (url) => {
    const response = await get(url);
    expect(response.status).toBe(200);
    expect(response.body).toBe('<!doctype html>');
  });

  it('ignores the query and the fragment', async () => {
    const response = await get('app://panels/index.html?v=1#/settings');
    expect(response.status).toBe(200);
    expect(response.body).toBe('<!doctype html>');
  });

  it.each([
    ['assets/index.js', 'text/javascript; charset=utf-8', 'export {};'],
    ['assets/index.css', 'text/css; charset=utf-8', 'body{}'],
    ['assets/Logo.SVG', 'image/svg+xml', '<svg/>'],
    ['assets/sub/a%20b.png', 'image/png', 'png'],
  ])('serves %s as %s, without a CSP header', async (file, type, body) => {
    const response = await get(`app://panels/${file}`);
    expect(response).toStrictEqual({ status: 200, type, csp: null, body });
  });
});

describe('app:// handler: 404', () => {
  it.each([
    ['a missing file', 'app://panels/missing.js'],
    ['a folder', 'app://panels/folder.js'],
    ['an unknown extension', 'app://panels/assets/data.bin'],
    ['a file with no extension', 'app://panels/assets'],
    ['an unknown host', 'app://overlay/index.html'],
    ['another unknown host', 'app://secret.txt/'],
    ['a raw ..', 'app://panels/../secret.txt'],
    ['a raw .. deeper', 'app://panels/assets/../../secret.txt'],
    ['an encoded ..', 'app://panels/%2e%2e/secret.txt'],
    ['an encoded .. with an encoded slash', 'app://panels/..%2fsecret.txt'],
    ['an encoded ..%2F', 'app://panels/..%2Fsecret.txt'],
    ['an encoded backslash', 'app://panels/..%5csecret.txt'],
    ['an encoded slash', 'app://panels/assets%2findex.js'],
    ['NUL', 'app://panels/index.html%00.js'],
    ['bad percent-encoding', 'app://panels/%E0%A4%A.js'],
    ['another scheme', 'pack://panels/index.html'],
    ['http', 'http://panels/index.html'],
    ['not a URL', 'not a url'],
  ])('%s: %s', async (_name, url) => {
    const response = await get(url);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('secret');
    expect(response.csp).toBeNull();
  });

  it('never touches the disk for a rejected URL', async () => {
    const stat = vi.fn(async () => ({ isFile: () => true }));
    const readFile = vi.fn(async () => new Uint8Array());
    for (const url of [
      'app://panels/..%2fsecret.txt',
      'app://panels/..%5c..%5csecret.txt',
      'app://panels/assets%2findex.js',
      'app://panels/index.html%00.js',
      'app://overlay/index.html',
      'app://panels/assets/data.bin',
      'app://panels/%E0%A4%A.js',
    ]) {
      expect((await get(url, { stat, readFile })).status).toBe(404);
    }
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('answers 404 when reading fails', async () => {
    const response = await get('app://panels/index.html', {
      stat: async () => ({ isFile: () => true }),
      readFile: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    });
    expect(response.status).toBe(404);
  });
});

describe('resolveAppFile', () => {
  const roots = { panels: path.join('root', 'panels') };

  it('maps a path inside the host folder', () => {
    expect(resolveAppFile('app://panels/assets/a.js', roots)).toBe(
      path.join('root', 'panels', 'assets', 'a.js'),
    );
  });

  it('keeps file names that only start with two dots', () => {
    expect(resolveAppFile('app://panels/..a.js', roots)).toBe(
      path.join('root', 'panels', '..a.js'),
    );
  });

  it('does not treat inherited object keys as hosts', () => {
    expect(resolveAppFile('app://constructor/index.html', roots)).toBe(
      undefined,
    );
    expect(resolveAppFile('app://__proto__/index.html', roots)).toBe(undefined);
  });
});
