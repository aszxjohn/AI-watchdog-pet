/**
 * main/packs' `pack://` handler (Story 3.2), registered through fake
 * electron's protocol, serving the contract test pack after a real inspect
 * and install into a temp folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import {
  createPackProtocolHandler,
  handlePackProtocol,
  resolvePackFile,
  STAGE_HOST,
  type PackProtocolFs,
} from '../../src/main/packs/protocol';
import { loadPacks, type PacksStore } from '../../src/main/packs/store';
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

let root: string;
let dir: string;
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
    handlePackProtocol(store);
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
    body: Buffer.from(await response.arrayBuffer()),
  };
}

function packFile(name: string): Buffer {
  return fs.readFileSync(path.join(dir, CONTRACT_PACK_ID, '1.0.0', name));
}

describe('handlePackProtocol', () => {
  it('serves the pack scheme through electron.protocol.handle', () => {
    handlePackProtocol(store);

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
    handlePackProtocol(store);
    expect((await get(`${BASE}/entry.js`)).status).toBe(200);

    await installContract(store, '1.1.0');

    expect(
      (await get(`pack://${CONTRACT_PACK_ID}/1.1.0/entry.js`)).status,
    ).toBe(200);
    expect((await get(`${BASE}/entry.js`)).status).toBe(404);
  });

  it('`pack://`: a pack installed for the first time after the handler was registered is served', async () => {
    const fresh = loadPacks({ dir: path.join(root, 'fresh-packs') });
    handlePackProtocol(fresh);
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
    ['the stage host', `pack://${STAGE_HOST}/sandbox.html`],
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
    const handler = createPackProtocolHandler({ store });

    expect((await handler({ url: 'not a url' })).status).toBe(404);
  });

  it('`pack://` 拒絕: reads nothing for a URL it refuses, and 404s when reading fails', async () => {
    const stat = vi.fn(async () => ({ isFile: () => true }));
    const readFile = vi.fn(async () => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    const handler = createPackProtocolHandler({
      store,
      fs: { stat, readFile } as PackProtocolFs,
    });

    expect((await handler({ url: `${BASE}/manifest.json` })).status).toBe(404);
    expect(stat).not.toHaveBeenCalled();
    expect((await handler({ url: `${BASE}/entry.js` })).status).toBe(404);
    expect(readFile).toHaveBeenCalledTimes(1);
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
