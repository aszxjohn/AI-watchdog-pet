/**
 * main/packs' `pack://` handler (Story 3.2), registered through fake
 * electron's protocol, serving the contract test pack after a real inspect
 * and install into a temp folder, and the sandbox document (Story 3.5)
 * from a stand-in build folder.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import {
  createPackProtocolHandler,
  handlePackProtocol,
  isSandboxDocumentUrl,
  resolvePackFile,
  sandboxDocumentFrom,
  STAGE_HOST,
  type PackProtocolFs,
  type SandboxDocumentFs,
} from '../../src/main/packs/protocol';
import { loadPacks, type PacksStore } from '../../src/main/packs/store';
import { sandboxCsp } from '../../src/sandbox/csp';
import {
  SANDBOX_CSP_FILE,
  SANDBOX_DOCUMENT_FILE,
} from '../../src/shared/constants';
import {
  CONTRACT_PACK_ID,
  contractManifest,
  contractPackFiles,
  itemsOf,
  manifestBytes,
  zipBuffer,
} from '../helpers/awpet';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

const BASE = `pack://${CONTRACT_PACK_ID}/1.0.0`;

/** The stand-in sandbox document and its CSP in the build folder. */
const SANDBOX_HTML = '<!doctype html>\n<body><script>void 0;</script></body>\n';
const SANDBOX_SHA256 = createHash('sha256')
  .update('void 0;', 'utf8')
  .digest('base64');
const SANDBOX_CSP = sandboxCsp(SANDBOX_SHA256);

let root: string;
let dir: string;
let buildDir: string;
let store: PacksStore;

/**
 * Inspects and installs the contract pack at `version` into `into`, with
 * notes/readme.txt added: on disk in the pack folder, but not declared by
 * the manifest.
 */
async function installContract(into: PacksStore, version: string) {
  const files: Map<string, Buffer | string> = contractPackFiles();
  const manifest = contractManifest();
  manifest.version = version;
  files.set('manifest.json', manifestBytes(manifest));
  files.set('notes/readme.txt', 'not declared');
  const awpet = path.join(root, `contract-${version}.awpet`);
  fs.writeFileSync(awpet, await zipBuffer(itemsOf(files)));
  const inspection = await inspectPack(awpet, into);
  if (!inspection.ok) {
    throw new Error(JSON.stringify(inspection.rejection));
  }
  expect(installPack(into, inspection.plan).ok).toBe(true);
}

beforeEach(async () => {
  fake.resetFakeElectron();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-packs-protocol-'));
  dir = path.join(root, 'packs');
  buildDir = path.join(root, 'build');
  fs.mkdirSync(buildDir);
  fs.writeFileSync(path.join(buildDir, SANDBOX_DOCUMENT_FILE), SANDBOX_HTML);
  fs.writeFileSync(
    path.join(buildDir, SANDBOX_CSP_FILE),
    JSON.stringify({ csp: SANDBOX_CSP, sha256: SANDBOX_SHA256 }),
  );
  store = loadPacks({ dir });
  await installContract(store, '1.0.0');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * What the handler registered on fake electron answers for `url`;
 * registers it for the shared store when nothing is registered yet.
 */
async function get(url: string) {
  if (!fake.protocolHandlers.has('pack')) {
    handlePackProtocol(store, buildDir);
  }
  const handler = fake.protocolHandlers.get('pack');
  if (handler === undefined) {
    throw new Error('no pack:// handler');
  }
  // Only the URL is read; a plain object also takes URLs Request refuses
  // (a user name), which Chromium may still hand over.
  const response = await handler({ url } as Request);
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    nosniff: response.headers.get('x-content-type-options'),
    csp: response.headers.get('content-security-policy'),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

function packFile(name: string): Buffer {
  return fs.readFileSync(path.join(dir, CONTRACT_PACK_ID, '1.0.0', name));
}

describe('handlePackProtocol', () => {
  it('serves the pack scheme through electron.protocol.handle', () => {
    handlePackProtocol(store, buildDir);

    expect([...fake.protocolHandlers.keys()]).toStrictEqual(['pack']);
  });
});

describe('I/O matrix', () => {
  it.each<[string, string]>([
    ['entry.js', 'text/javascript; charset=utf-8'],
    ['img/probe-two-sheet.json', 'application/json; charset=utf-8'],
    ['img/probe-one-plain.png', 'image/png'],
    // The spritesheet's image: not in assets, but served.
    ['img/probe-two-sheet.png', 'image/png'],
  ])(
    '`pack://`: a declared path (%s) is served, typed by its extension, nosniff',
    async (file, type) => {
      const response = await get(`${BASE}/${file}`);

      expect(response.status).toBe(200);
      expect(response.type).toBe(type);
      expect(response.nosniff).toBe('nosniff');
      expect(response.body.equals(packFile(file))).toBe(true);
    },
  );

  it('`pack://`: a handler registered before an update serves the new version and 404s the old one', async () => {
    handlePackProtocol(store, buildDir);
    expect((await get(`${BASE}/entry.js`)).status).toBe(200);

    await installContract(store, '1.1.0');

    expect(
      (await get(`pack://${CONTRACT_PACK_ID}/1.1.0/entry.js`)).status,
    ).toBe(200);
    expect((await get(`${BASE}/entry.js`)).status).toBe(404);
  });

  it('`pack://`: a pack installed for the first time after the handler was registered is served', async () => {
    const fresh = loadPacks({ dir: path.join(root, 'fresh-packs') });
    handlePackProtocol(fresh, buildDir);
    expect((await get(`${BASE}/entry.js`)).status).toBe(404);

    await installContract(fresh, '1.0.0');

    expect((await get(`${BASE}/entry.js`)).status).toBe(200);
  });

  it('`pack://`: ignores the query and the fragment', async () => {
    const response = await get(`${BASE}/entry.js?v=2#top`);

    expect(response.status).toBe(200);
    expect(response.body.equals(packFile('entry.js'))).toBe(true);
  });

  it('`pack://`: a path the URL parser resolves back into a declared one is that file', async () => {
    expect((await get(`${BASE}/img/../entry.js`)).status).toBe(200);
  });

  it.each<[string, string]>([
    ['a pack that is not installed', 'pack://other-pack/1.0.0/entry.js'],
    [
      'a version that is not installed',
      `pack://${CONTRACT_PACK_ID}/0.9.0/entry.js`,
    ],
    ['no version', `pack://${CONTRACT_PACK_ID}/entry.js`],
    ['the manifest, which is not served', `${BASE}/manifest.json`],
    [
      'a file in the folder the manifest did not declare',
      `${BASE}/notes/readme.txt`,
    ],
    [
      'a .. that leaves the version folder',
      `${BASE}/../1.0.0/entry.js/../../index.json`,
    ],
    ['a percent-encoded ..', `${BASE}/img/%2e%2e/manifest.json`],
    ['a percent-encoded slash', `${BASE}/img%2fspark.png`],
    ['a percent-encoded name', `${BASE}/entry%2ejs`],
    ['another case', `${BASE}/IMG/spark.png`],
    ['a folder', `${BASE}/img`],
    ['a trailing slash', `${BASE}/img/`],
    ['the version folder', `${BASE}/`],
    ['another path of the stage host', `pack://${STAGE_HOST}/other.html`],
    ['the stage host with a pack path', `pack://${STAGE_HOST}/1.0.0/entry.js`],
    ['a user name', `pack://someone@${CONTRACT_PACK_ID}/1.0.0/entry.js`],
    ['a port', `pack://${CONTRACT_PACK_ID}:8080/1.0.0/entry.js`],
    ['another scheme', `app://${CONTRACT_PACK_ID}/1.0.0/entry.js`],
  ])('`pack://` 拒絕: %s is 404', async (_label, url) => {
    const response = await get(url);

    expect(response.status).toBe(404);
    expect(response.body.toString('utf8')).toBe('not found');
  });

  it('`pack://` 拒絕: a declared file missing on disk is 404', async () => {
    fs.rmSync(path.join(dir, CONTRACT_PACK_ID, '1.0.0', 'img', 'spark.png'));

    expect((await get(`${BASE}/img/spark.png`)).status).toBe(404);
  });

  it('`pack://` 拒絕: a URL that does not parse is 404', async () => {
    const handler = createPackProtocolHandler({
      store,
      sandbox: async () => undefined,
    });

    expect((await handler({ url: 'not a url' })).status).toBe(404);
  });

  it('`pack://` 拒絕: reads nothing for a URL it refuses, and 404s when reading fails', async () => {
    const stat = vi.fn(async () => ({ isFile: () => true }));
    const readFile = vi.fn(async () => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    const handler = createPackProtocolHandler({
      store,
      sandbox: async () => undefined,
      fs: { stat, readFile } as PackProtocolFs,
    });

    expect((await handler({ url: `${BASE}/manifest.json` })).status).toBe(404);
    expect(stat).not.toHaveBeenCalled();
    expect((await handler({ url: `${BASE}/entry.js` })).status).toBe(404);
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});

describe('I/O matrix', () => {
  it('沙盒文件: pack://_stage/sandbox.html is the built document, text/html with its CSP header and nosniff', async () => {
    const response = await get(`pack://${STAGE_HOST}/sandbox.html`);

    expect(response.status).toBe(200);
    expect(response.type).toBe('text/html; charset=utf-8');
    expect(response.csp).toBe(SANDBOX_CSP);
    expect(response.nosniff).toBe('nosniff');
    expect(response.body.toString('utf8')).toBe(SANDBOX_HTML);
  });

  it('沙盒文件: the query and the fragment are ignored', async () => {
    const response = await get(`pack://${STAGE_HOST}/sandbox.html?x=1#y`);

    expect(response.status).toBe(200);
    expect(response.csp).toBe(SANDBOX_CSP);
  });

  it.each<[string, string]>([
    ['the stage root', `pack://${STAGE_HOST}/`],
    ['the stage host alone', `pack://${STAGE_HOST}`],
    ['another case', `pack://${STAGE_HOST}/SANDBOX.html`],
    ['a longer path', `pack://${STAGE_HOST}/sandbox.html/x`],
    ['a nested path', `pack://${STAGE_HOST}/x/sandbox.html`],
    ['the CSP file', `pack://${STAGE_HOST}/${SANDBOX_CSP_FILE}`],
    ['main.cjs', `pack://${STAGE_HOST}/main.cjs`],
    ['a percent-encoded name', `pack://${STAGE_HOST}/sandbox%2ehtml`],
    ['a user name', `pack://someone@${STAGE_HOST}/sandbox.html`],
    ['a port', `pack://${STAGE_HOST}:8080/sandbox.html`],
    ['the document under a pack id', `pack://${CONTRACT_PACK_ID}/sandbox.html`],
  ])('沙盒文件: %s is 404', async (_label, url) => {
    const response = await get(url);

    expect(response.status).toBe(404);
    expect(response.csp).toBeNull();
    expect(response.body.toString('utf8')).toBe('not found');
  });

  it('沙盒文件: the build files are read once and kept', async () => {
    const readFile = vi.fn(async (file: string) =>
      fs.readFileSync(file, 'utf8'),
    );
    const handler = createPackProtocolHandler({
      store,
      sandbox: sandboxDocumentFrom(buildDir, { readFile } as SandboxDocumentFs),
    });
    const url = `pack://${STAGE_HOST}/sandbox.html`;

    expect((await handler({ url })).status).toBe(200);
    expect((await handler({ url })).status).toBe(200);
    expect(
      readFile.mock.calls.map(([file]) => path.basename(file)),
    ).toStrictEqual([SANDBOX_DOCUMENT_FILE, SANDBOX_CSP_FILE]);
  });

  it.each<[string, () => void]>([
    [
      'the document is missing',
      () => {
        fs.rmSync(path.join(buildDir, SANDBOX_DOCUMENT_FILE));
      },
    ],
    [
      'the CSP file is missing',
      () => {
        fs.rmSync(path.join(buildDir, SANDBOX_CSP_FILE));
      },
    ],
    [
      'the CSP file is not JSON',
      () => {
        fs.writeFileSync(path.join(buildDir, SANDBOX_CSP_FILE), '{');
      },
    ],
    [
      'the CSP file does not fit its schema',
      () => {
        fs.writeFileSync(
          path.join(buildDir, SANDBOX_CSP_FILE),
          JSON.stringify({ csp: "default-src 'self'", sha256: 'x' }),
        );
      },
    ],
    [
      'the CSP does not sandbox the document (no sandbox allow-scripts)',
      () => {
        fs.writeFileSync(
          path.join(buildDir, SANDBOX_CSP_FILE),
          JSON.stringify({
            csp: SANDBOX_CSP.replace('; sandbox allow-scripts', ''),
            sha256: SANDBOX_SHA256,
          }),
        );
      },
    ],
    [
      'the CSP sandboxes the document with more than scripts',
      () => {
        fs.writeFileSync(
          path.join(buildDir, SANDBOX_CSP_FILE),
          JSON.stringify({
            csp: SANDBOX_CSP.replace(
              'sandbox allow-scripts',
              'sandbox allow-scripts allow-same-origin',
            ),
            sha256: SANDBOX_SHA256,
          }),
        );
      },
    ],
    [
      'the CSP has frame-ancestors (the overlay could not frame it)',
      () => {
        fs.writeFileSync(
          path.join(buildDir, SANDBOX_CSP_FILE),
          JSON.stringify({
            csp: `${SANDBOX_CSP}; frame-ancestors 'none'`,
            sha256: SANDBOX_SHA256,
          }),
        );
      },
    ],
    [
      'an upper-case Sandbox directive with more than scripts comes first (the one a browser uses)',
      () => {
        fs.writeFileSync(
          path.join(buildDir, SANDBOX_CSP_FILE),
          JSON.stringify({
            csp: SANDBOX_CSP.replace(
              "default-src 'none'; ",
              "default-src 'none'; Sandbox allow-scripts allow-same-origin; ",
            ),
            sha256: SANDBOX_SHA256,
          }),
        );
      },
    ],
    [
      'the CSP has sandbox allow-scripts twice',
      () => {
        fs.writeFileSync(
          path.join(buildDir, SANDBOX_CSP_FILE),
          JSON.stringify({
            csp: `${SANDBOX_CSP}; sandbox allow-scripts`,
            sha256: SANDBOX_SHA256,
          }),
        );
      },
    ],
    [
      'the CSP has an upper-case Frame-Ancestors',
      () => {
        fs.writeFileSync(
          path.join(buildDir, SANDBOX_CSP_FILE),
          JSON.stringify({
            csp: `${SANDBOX_CSP}; Frame-Ancestors 'none'`,
            sha256: SANDBOX_SHA256,
          }),
        );
      },
    ],
    [
      "the document's inline script is from another build (its hash differs)",
      () => {
        fs.writeFileSync(
          path.join(buildDir, SANDBOX_DOCUMENT_FILE),
          SANDBOX_HTML.replace('void 0;', 'void 1;'),
        );
      },
    ],
    [
      "the CSP file's sha256 is not the one in its CSP",
      () => {
        const other = Buffer.alloc(32, 9).toString('base64');
        fs.writeFileSync(
          path.join(buildDir, SANDBOX_CSP_FILE),
          JSON.stringify({ csp: sandboxCsp(other), sha256: SANDBOX_SHA256 }),
        );
      },
    ],
    [
      'the document has two inline scripts',
      () => {
        fs.writeFileSync(
          path.join(buildDir, SANDBOX_DOCUMENT_FILE),
          `${SANDBOX_HTML}<script>void 0;</script>`,
        );
      },
    ],
  ])(
    '沙盒文件: when %s, the document is 404, with one error line',
    async (_label, spoil) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      spoil();

      expect((await get(`pack://${STAGE_HOST}/sandbox.html`)).status).toBe(404);
      expect((await get(`pack://${STAGE_HOST}/sandbox.html`)).status).toBe(404);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toMatch(/^\[packs\] /);
    },
  );
});

describe('isSandboxDocumentUrl', () => {
  it('is true for pack://_stage/sandbox.html only', () => {
    expect(isSandboxDocumentUrl('pack://_stage/sandbox.html')).toBe(true);
    expect(isSandboxDocumentUrl('pack://_stage/sandbox.html?a#b')).toBe(true);
    expect(isSandboxDocumentUrl('app://_stage/sandbox.html')).toBe(false);
    expect(isSandboxDocumentUrl('not a url')).toBe(false);
  });
});

describe('resolvePackFile', () => {
  it('maps a declared path into the installed version folder', () => {
    expect(resolvePackFile(`${BASE}/img/spark.png`, store)).toBe(
      path.join(dir, CONTRACT_PACK_ID, '1.0.0', 'img', 'spark.png'),
    );
  });

  it('follows the installed version, not one asked for', () => {
    expect(
      resolvePackFile(`pack://${CONTRACT_PACK_ID}/1.0.1/entry.js`, store),
    ).toBeUndefined();
  });
});
