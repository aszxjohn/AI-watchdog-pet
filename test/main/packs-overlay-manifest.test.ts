/**
 * main/packs for the overlay's drawing (Story 3.6): what it draws an
 * installed pack with (`packs:get-manifest`: the version's manifest and its
 * spritesheets, checked), the run log lines about drawing, and the channel
 * as the IPC layer registers it (overlay only, arguments checked), over
 * fake electron. The contract test pack is really inspected and installed
 * into a temp folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import { registerPackSandboxHandlers } from '../../src/main/packs/ipc';
import { readPackManifest } from '../../src/main/packs/overlay-manifest';
import { packLogLine } from '../../src/main/packs/sandbox-log';
import { loadPacks, type PacksStore } from '../../src/main/packs/store';
import { packsGetManifest } from '../../src/shared/ipc';
import { manifestSchema } from '../../src/shared/pack-api';
import {
  packManifestResultSchema,
  type PackIndexEntry,
} from '../../src/shared/packs';
import type { PackLogEntry } from '../../src/shared/sandbox';
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

const OVERLAY_URL = 'app://overlay/index.html';

let root: string;
let store: PacksStore;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

/** Installs `files` (the contract pack's, changed) into the store. */
async function install(files: Map<string, Buffer | string>): Promise<void> {
  const awpet = path.join(root, `pack-${Math.random()}.awpet`);
  fs.writeFileSync(awpet, await zipBuffer(itemsOf(files)));
  const inspection = await inspectPack(awpet, store);
  if (!inspection.ok) {
    throw new Error(JSON.stringify(inspection.rejection));
  }
  expect(installPack(store, inspection.plan).ok).toBe(true);
}

/** The installed contract pack's folder. */
function installedFolder(): string {
  return path.join(store.dir, CONTRACT_PACK_ID, '1.0.0');
}

beforeEach(async () => {
  fake.resetFakeElectron();
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-packs-manifest-'));
  store = loadPacks({ dir: path.join(root, 'packs') });
  await install(contractPackFiles());
  info.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

describe('readPackManifest', () => {
  it("answers the installed version's manifest and its spritesheet, the sheet's image resolved against it", () => {
    const result = readPackManifest(store, CONTRACT_PACK_ID, '1.0.0');

    expect(packManifestResultSchema.safeParse(result).success).toBe(true);
    expect(result).toStrictEqual({
      ok: true,
      packId: CONTRACT_PACK_ID,
      version: '1.0.0',
      manifest: manifestSchema.parse(contractManifest()),
      spritesheets: {
        'probe-two-sheet': {
          image: 'img/probe-two-sheet.png',
          data: {
            frames: {
              'eyes-open': { frame: { x: 0, y: 0, w: 2, h: 2 } },
              'eyes-shut': { frame: { x: 2, y: 0, w: 2, h: 2 } },
            },
            meta: {
              image: 'probe-two-sheet.png',
              size: { w: 4, h: 2 },
              scale: 1,
            },
          },
        },
      },
    });
    expect(lines(warn)).toStrictEqual([]);
    expect(lines(error)).toStrictEqual([]);
  });

  it('a spritesheet JSON starting with a UTF-8 BOM (EF BB BF) is read as without one', () => {
    const before = readPackManifest(store, CONTRACT_PACK_ID, '1.0.0');
    const sheet = path.join(installedFolder(), 'img', 'probe-two-sheet.json');
    fs.writeFileSync(
      sheet,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(sheet)]),
    );

    expect(readPackManifest(store, CONTRACT_PACK_ID, '1.0.0')).toStrictEqual(
      before,
    );
    expect(before.ok).toBe(true);
    expect(lines(error)).toStrictEqual([]);
  });

  it('a version not installed (another one is) is not-installed; so is a pack not installed', () => {
    expect(readPackManifest(store, CONTRACT_PACK_ID, '1.0.1')).toStrictEqual({
      ok: false,
      code: 'not-installed',
    });
    expect(readPackManifest(store, 'other-pack', '1.0.0')).toStrictEqual({
      ok: false,
      code: 'not-installed',
    });
    expect(lines(info)).toStrictEqual([
      `[packs] pack ${CONTRACT_PACK_ID} 1.0.1: manifest not handed to the overlay (not-installed)`,
      '[packs] pack other-pack 1.0.0: manifest not handed to the overlay (not-installed)',
    ]);
  });

  it('a pack that does not fit the stage API is api-incompatible, and nothing is read', () => {
    const entry: PackIndexEntry = {
      id: 'sample-pack',
      name: '樣本包',
      version: '2.1.0',
      apiVersion: '1.9',
      characters: [{ id: 'probe-a', name: '探針甲', height: 110 }],
      servedPaths: ['main.js'],
    };
    const readFileSync = vi.fn(() => '');

    expect(
      readPackManifest(
        { dir: root, find: (id) => (id === entry.id ? entry : undefined) },
        'sample-pack',
        '2.1.0',
        { readFileSync },
      ),
    ).toStrictEqual({ ok: false, code: 'api-incompatible' });
    expect(readFileSync).not.toHaveBeenCalled();
    expect(lines(warn)).toStrictEqual([
      '[packs] pack sample-pack 2.1.0: manifest not handed to the overlay (api-incompatible: pack-newer, needs API 1.9)',
    ]);
  });

  it.each<[string, () => void, string]>([
    [
      'the manifest is gone',
      () => {
        fs.rmSync(path.join(installedFolder(), 'manifest.json'));
      },
      'manifest unreadable ENOENT',
    ],
    [
      'the spritesheet is gone',
      () => {
        fs.rmSync(path.join(installedFolder(), 'img', 'probe-two-sheet.json'));
      },
      'spritesheet probe-two-sheet ENOENT',
    ],
    [
      'the spritesheet is not JSON',
      () => {
        fs.writeFileSync(
          path.join(installedFolder(), 'img', 'probe-two-sheet.json'),
          '{ nope',
        );
      },
      'spritesheet probe-two-sheet not-json',
    ],
    [
      'the spritesheet has a meta.scale other than 1',
      () => {
        fs.writeFileSync(
          path.join(installedFolder(), 'img', 'probe-two-sheet.json'),
          JSON.stringify({
            frames: { a: { frame: { x: 0, y: 0, w: 2, h: 2 } } },
            meta: { image: 'probe-two-sheet.png', scale: 2 },
          }),
        );
      },
      'spritesheet probe-two-sheet invalid',
    ],
    [
      "the spritesheet's image is not a file the pack serves",
      () => {
        fs.writeFileSync(
          path.join(installedFolder(), 'img', 'probe-two-sheet.json'),
          JSON.stringify({
            frames: { a: { frame: { x: 0, y: 0, w: 1, h: 1 } } },
            meta: { image: 'other.png' },
          }),
        );
      },
      'spritesheet probe-two-sheet image is not a served path',
    ],
  ])(
    'read-failed when %s, with one error line naming the pack and version',
    (_label, breakIt, why) => {
      breakIt();

      expect(readPackManifest(store, CONTRACT_PACK_ID, '1.0.0')).toStrictEqual({
        ok: false,
        code: 'read-failed',
      });
      expect(lines(error)).toStrictEqual([
        `[packs] pack ${CONTRACT_PACK_ID} 1.0.0: manifest not handed to the overlay (read-failed: ${why})`,
      ]);
    },
  );

  it('a new version is read from its own folder', async () => {
    const files: Map<string, Buffer | string> = contractPackFiles();
    const manifest = contractManifest();
    manifest.version = '1.1.0';
    files.set('manifest.json', manifestBytes(manifest));
    await install(files);

    const result = readPackManifest(store, CONTRACT_PACK_ID, '1.1.0');
    expect(result.ok && result.version).toBe('1.1.0');
    expect(readPackManifest(store, CONTRACT_PACK_ID, '1.0.0')).toStrictEqual({
      ok: false,
      code: 'not-installed',
    });
  });
});

describe('packLogLine (Story 3.6)', () => {
  it.each<[PackLogEntry, string, string]>([
    [
      { kind: 'not-drawn', packId: 'sample-pack', reason: 'character-missing' },
      "pack sample-pack: not drawn: an actor plays a character the stage cannot find (no effective values for it, or not in the pack's manifest)",
      'warn',
    ],
    [
      {
        kind: 'not-drawn',
        packId: 'sample-pack',
        reason: 'manifest-unavailable',
      },
      'pack sample-pack: not drawn: its manifest or spritesheets could not be had for the version installed',
      'warn',
    ],
    [
      {
        kind: 'not-drawn',
        packId: 'sample-pack',
        reason: 'asset-failed',
        asset: 'body-dots',
      },
      'pack sample-pack: not drawn (asset body-dots): an asset could not be loaded or does not fit its image',
      'warn',
    ],
    [
      {
        kind: 'messages-dropped',
        packId: 'sample-pack',
        reason: 'too-many-commands',
        count: 1,
      },
      'pack sample-pack: dropped 1 message from its sandbox (too-many-commands)',
      'warn',
    ],
  ])('%j gives its line', (entry, message, level) => {
    expect(packLogLine(entry)).toStrictEqual({ message, level });
  });
});

describe('packs:get-manifest', () => {
  let reads: string[][];

  beforeEach(() => {
    reads = [];
    registerPackSandboxHandlers(
      async () => ({ ok: false, code: 'not-installed' }),
      () => {},
      (packId, version) => {
        reads.push([packId, version]);
        return readPackManifest(store, packId, version);
      },
      () => ({ restart: false }),
    );
    fake.sender.mainFrame.url = OVERLAY_URL;
  });

  function invoke(...args: unknown[]): Promise<unknown> {
    return fake.ipcRenderer.invoke(packsGetManifest.channel, ...args);
  }

  it('the overlay gets the manifest of a pack at a version', async () => {
    expect(await invoke(CONTRACT_PACK_ID, '1.0.0')).toMatchObject({
      ok: true,
      data: { ok: true, packId: CONTRACT_PACK_ID, version: '1.0.0' },
    });
    expect(reads).toStrictEqual([[CONTRACT_PACK_ID, '1.0.0']]);
  });

  it.each<[string, unknown[]]>([
    ['no argument', []],
    ['no version', [CONTRACT_PACK_ID]],
    ['a version that is not one', [CONTRACT_PACK_ID, '1.0']],
    ['a stage host', ['_stage', '1.0.0']],
    ['three arguments', [CONTRACT_PACK_ID, '1.0.0', 'x']],
  ])('answers invalid-input to %s and reads nothing', async (_label, args) => {
    expect(await invoke(...args)).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(reads).toStrictEqual([]);
  });

  it('answers the panels sender-rejected and reads nothing', async () => {
    fake.sender.mainFrame.url = 'app://panels/index.html';

    expect(await invoke(CONTRACT_PACK_ID, '1.0.0')).toMatchObject({
      ok: false,
      error: { code: 'sender-rejected' },
    });
    expect(reads).toStrictEqual([]);
  });
});
