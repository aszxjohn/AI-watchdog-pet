/**
 * main/packs (Story 3.6): reading an installed version's own manifest.json
 * for main/settings' characters. The contract test pack is really
 * inspected and installed into a temp folder; then its manifest is
 * rewritten or removed in place.
 */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import {
  type InstalledManifestFs,
  readInstalledManifest,
} from '../../src/main/packs/manifest';
import { loadPacks } from '../../src/main/packs/store';
import { manifestSchema } from '../../src/shared/pack-api';
import {
  CONTRACT_PACK_ID,
  contractManifest,
  contractPackFiles,
  itemsOf,
  zipBuffer,
} from '../helpers/awpet';

vi.mock('electron', () => import('../helpers/fake-electron'));

const VERSION = '1.0.0';

let root: string;
let dir: string;
let manifestFile: string;

beforeEach(async () => {
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-packs-manifest-'));
  dir = path.join(root, 'packs');
  const store = loadPacks({ dir });
  const awpet = path.join(root, 'contract.awpet');
  fs.writeFileSync(awpet, await zipBuffer(itemsOf(contractPackFiles())));
  const inspection = await inspectPack(awpet, store);
  if (!inspection.ok) {
    throw new Error(JSON.stringify(inspection.rejection));
  }
  expect(installPack(store, inspection.plan).ok).toBe(true);
  manifestFile = path.join(dir, CONTRACT_PACK_ID, VERSION, 'manifest.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readInstalledManifest', () => {
  it('reads and checks the installed manifest', () => {
    expect(readInstalledManifest(dir, CONTRACT_PACK_ID, VERSION)).toStrictEqual(
      { ok: true, manifest: manifestSchema.parse(contractManifest()) },
    );
  });

  it('takes a manifest with a UTF-8 BOM', () => {
    fs.writeFileSync(
      manifestFile,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(JSON.stringify(contractManifest()), 'utf8'),
      ]),
    );

    const read = readInstalledManifest(dir, CONTRACT_PACK_ID, VERSION);

    expect(read.ok).toBe(true);
  });

  it('reads the file again each time: a manifest rewritten in place (the same version installed again) is what it answers next', () => {
    const changed = contractManifest();
    (changed.characters as { name: string }[])[0]!.name = '改過的名字';
    expect(readInstalledManifest(dir, CONTRACT_PACK_ID, VERSION).ok).toBe(true);
    fs.writeFileSync(manifestFile, JSON.stringify(changed));

    const read = readInstalledManifest(dir, CONTRACT_PACK_ID, VERSION);

    expect(read.ok && read.manifest.characters[0]?.name).toBe('改過的名字');
  });

  it('is unreadable, with the error code, when the file is not there', () => {
    fs.rmSync(manifestFile);

    expect(readInstalledManifest(dir, CONTRACT_PACK_ID, VERSION)).toStrictEqual(
      { ok: false, code: 'unreadable', detail: 'ENOENT' },
    );
  });

  it('is unreadable when the version folder is not there', () => {
    expect(readInstalledManifest(dir, CONTRACT_PACK_ID, '9.9.9')).toStrictEqual(
      { ok: false, code: 'unreadable', detail: 'ENOENT' },
    );
  });

  it('is unreadable, with the code, when reading fails otherwise', () => {
    const fails: InstalledManifestFs = {
      readFileSync() {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    };

    expect(
      readInstalledManifest(dir, CONTRACT_PACK_ID, VERSION, fails),
    ).toStrictEqual({ ok: false, code: 'unreadable', detail: 'EACCES' });
  });

  it('is not-json for a file that is not JSON, and keeps nothing of the file', () => {
    fs.writeFileSync(manifestFile, '{ "id": "contract-pack", ');

    const read = readInstalledManifest(dir, CONTRACT_PACK_ID, VERSION);

    expect(read).toStrictEqual({ ok: false, code: 'not-json' });
  });

  it.each([
    ['a character with no id', { characters: [{ name: 'x' }] }],
    ['an unknown field', { extra: true }],
    ['no characters', { characters: [] }],
  ])(
    'is invalid-manifest for one that fails the schema: %s',
    (_label, change) => {
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({ ...contractManifest(), ...change }),
      );

      expect(
        readInstalledManifest(dir, CONTRACT_PACK_ID, VERSION),
      ).toStrictEqual({ ok: false, code: 'invalid-manifest' });
    },
  );

  it('is invalid-manifest for JSON that is not an object', () => {
    fs.writeFileSync(manifestFile, '[]');

    expect(readInstalledManifest(dir, CONTRACT_PACK_ID, VERSION)).toStrictEqual(
      { ok: false, code: 'invalid-manifest' },
    );
  });

  it.each([
    ['another id', { id: 'other-pack' }],
    ['another version', { version: '1.0.1' }],
  ])(
    "is mismatch for a manifest with %s than its folder's",
    (_label, change) => {
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({ ...contractManifest(), ...change }),
      );

      expect(
        readInstalledManifest(dir, CONTRACT_PACK_ID, VERSION),
      ).toStrictEqual({ ok: false, code: 'mismatch' });
    },
  );
});
