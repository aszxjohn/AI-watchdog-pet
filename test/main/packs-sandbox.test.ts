/**
 * main/packs for the overlay's sandboxes (Story 3.5): handing over an
 * installed pack's entry (`packs:get-entry`, with the API version checked
 * again), the run log lines (`packs:log`), and both channels as the IPC
 * layer registers them (overlay only, arguments checked), over fake
 * electron. The contract test pack is really inspected and installed into
 * a temp folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPackEntry, type PackEntryFs } from '../../src/main/packs/entry';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import {
  PACK_SANDBOX_RENDERERS,
  registerPackSandboxHandlers,
} from '../../src/main/packs/ipc';
import { logPackEntry, packLogLine } from '../../src/main/packs/sandbox-log';
import { loadPacks, type PacksStore } from '../../src/main/packs/store';
import {
  SANDBOX_IDLE_MS,
  STAGE_LOG_MAX_LENGTH,
} from '../../src/shared/constants';
import { packsGetEntry, packsLog } from '../../src/shared/ipc';
import type { PackEntryResult, PackIndexEntry } from '../../src/shared/packs';
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

beforeEach(async () => {
  fake.resetFakeElectron();
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-packs-sandbox-'));
  store = loadPacks({ dir: path.join(root, 'packs') });
  const awpet = path.join(root, 'contract.awpet');
  fs.writeFileSync(awpet, await zipBuffer(itemsOf(contractPackFiles())));
  const inspection = await inspectPack(awpet, store);
  if (!inspection.ok) {
    throw new Error(JSON.stringify(inspection.rejection));
  }
  expect(installPack(store, inspection.plan).ok).toBe(true);
  info.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

/** A store with one installed entry, as readPackEntry needs it. */
function storeOf(entry: PackIndexEntry): Pick<PacksStore, 'dir' | 'find'> {
  return {
    dir: path.join(root, 'elsewhere'),
    find: (packId) => (packId === entry.id ? entry : undefined),
  };
}

const ENTRY: PackIndexEntry = {
  id: 'sample-pack',
  name: '樣本包',
  version: '2.1.0',
  apiVersion: '1.0',
  characters: [{ id: 'probe-a', name: '探針甲', height: 110 }],
  servedPaths: ['img/a.png', 'main.js'],
};

/** A fake fs answering each file name under the installed folder. */
function filesOf(files: Readonly<Record<string, string>>) {
  const folder = path.join(root, 'elsewhere', 'sample-pack', '2.1.0');
  return vi.fn(async (file: string) => {
    const name = path.relative(folder, file).split(path.sep).join('/');
    const text = files[name];
    if (text === undefined) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return text;
  });
}

describe('readPackEntry', () => {
  it("hands over the installed pack's entry file, with its id and version", async () => {
    const result = await readPackEntry(store, CONTRACT_PACK_ID);

    expect(result).toStrictEqual({
      ok: true,
      packId: CONTRACT_PACK_ID,
      version: '1.0.0',
      source: contractPackFiles().get('entry.js')?.toString('utf8'),
    });
    expect(lines(info)).toStrictEqual([
      `[packs] pack ${CONTRACT_PACK_ID}: entry handed to its sandbox (version 1.0.0)`,
    ]);
  });

  it('reads the entry the installed manifest names (not the first served path) from the installed version folder', async () => {
    const readFile = filesOf({
      'manifest.json': '\ufeff{ "entry": "main.js" }',
      'main.js': 'SOURCE',
      'img/a.png': 'PNG',
    });

    const result = await readPackEntry(storeOf(ENTRY), 'sample-pack', {
      readFile,
    } as PackEntryFs);

    expect(result).toMatchObject({ ok: true, source: 'SOURCE' });
    expect(readFile.mock.calls.map(([file]) => file)).toStrictEqual([
      path.join(root, 'elsewhere', 'sample-pack', '2.1.0', 'manifest.json'),
      path.join(root, 'elsewhere', 'sample-pack', '2.1.0', 'main.js'),
    ]);
  });

  it.each<[string, Record<string, string>, string]>([
    ['no manifest', { 'main.js': 'x' }, 'manifest ENOENT'],
    [
      'a manifest that is not JSON',
      { 'manifest.json': '{' },
      'manifest SyntaxError',
    ],
    [
      'an entry that is not a served path',
      { 'manifest.json': '{ "entry": "other.js" }', 'other.js': 'x' },
      'manifest entry is not a served path',
    ],
    [
      'an entry that is not a pack path',
      { 'manifest.json': '{ "entry": "../main.js" }' },
      'manifest entry is not a served path',
    ],
    [
      'no entry in the manifest',
      { 'manifest.json': '[]' },
      'manifest entry is not a served path',
    ],
    [
      'an entry file that is missing',
      { 'manifest.json': '{ "entry": "main.js" }' },
      'ENOENT',
    ],
  ])('%s: read-failed, with one error line', async (_label, files, why) => {
    expect(
      await readPackEntry(storeOf(ENTRY), 'sample-pack', {
        readFile: filesOf(files),
      } as PackEntryFs),
    ).toStrictEqual({ ok: false, code: 'read-failed' });
    expect(lines(error)).toStrictEqual([
      `[packs] pack sample-pack: entry not handed over (read-failed: ${why})`,
    ]);
  });

  it('a pack that is not installed: not-installed, nothing read', async () => {
    const readFile = vi.fn();

    expect(
      await readPackEntry(store, 'other-pack', { readFile } as PackEntryFs),
    ).toStrictEqual({ ok: false, code: 'not-installed' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    ['a newer minor', '1.9', 'pack-newer'],
    ['another major', '2.0', 'major-mismatch'],
  ])(
    'an installed pack written for %s is checked again and its entry never read',
    async (_label, apiVersion, reason) => {
      const readFile = vi.fn();

      expect(
        await readPackEntry(storeOf({ ...ENTRY, apiVersion }), 'sample-pack', {
          readFile,
        } as PackEntryFs),
      ).toStrictEqual({ ok: false, code: 'api-incompatible' });
      expect(readFile).not.toHaveBeenCalled();
      expect(lines(warn)).toStrictEqual([
        `[packs] pack sample-pack: entry not handed over (api-incompatible: ${reason}, needs API ${apiVersion})`,
      ]);
    },
  );

  it('an entry that cannot be read: read-failed, with its error code', async () => {
    fs.rmSync(path.join(root, 'packs', CONTRACT_PACK_ID, '1.0.0', 'entry.js'));

    expect(await readPackEntry(store, CONTRACT_PACK_ID)).toStrictEqual({
      ok: false,
      code: 'read-failed',
    });
    expect(lines(error)).toStrictEqual([
      `[packs] pack ${CONTRACT_PACK_ID}: entry not handed over (read-failed: ENOENT)`,
    ]);
  });
});

describe('packLogLine', () => {
  const REMOVALS = [
    { name: 'fetch', status: 'removed' },
    { name: 'caches', status: 'absent' },
    { name: 'Iterator.prototype.join', status: 'removed' },
  ] as const;

  it.each<[PackLogEntry, string, string]>([
    [
      {
        kind: 'sandbox-ready',
        packId: 'sample-pack',
        version: '1.0.0',
        removals: REMOVALS,
        consoleLines: 0,
      },
      'pack sample-pack: sandbox ready (version 1.0.0; removed: fetch, Iterator.prototype.join; absent: caches; console 0 lines up to the end of lockdown)',
      'info',
    ],
    [
      { kind: 'sandbox-destroyed', packId: 'sample-pack', reason: 'idle' },
      `pack sample-pack: sandbox destroyed (no actor for ${SANDBOX_IDLE_MS} ms)`,
      'info',
    ],
    [
      {
        kind: 'sandbox-destroyed',
        packId: 'sample-pack',
        reason: 'not-installed',
      },
      'pack sample-pack: sandbox destroyed (its pack is no longer installed)',
      'info',
    ],
    [
      {
        kind: 'sandbox-destroyed',
        packId: 'sample-pack',
        reason: 'api-incompatible',
      },
      'pack sample-pack: sandbox destroyed (its pack no longer fits the stage API)',
      'info',
    ],
    [
      {
        kind: 'sandbox-destroyed',
        packId: 'sample-pack',
        reason: 'version-changed',
      },
      'pack sample-pack: sandbox destroyed (its pack is installed at another version now)',
      'info',
    ],
    [
      {
        kind: 'sandbox-failed',
        packId: 'sample-pack',
        reason: 'boot-timeout',
      },
      'pack sample-pack: sandbox failed (boot-timeout); its iframe was removed',
      'error',
    ],
    [
      {
        kind: 'sandbox-failed',
        packId: 'sample-pack',
        reason: 'lockdown-output',
        removals: REMOVALS,
        consoleLines: 3,
      },
      'pack sample-pack: sandbox failed (lockdown-output); its iframe was removed (removed: fetch, Iterator.prototype.join; absent: caches; console 3 lines)',
      'error',
    ],
    [
      { kind: 'sandbox-failed', packId: 'sample-pack', reason: 'worker-error' },
      'pack sample-pack: sandbox failed (worker-error); its iframe was removed',
      'error',
    ],
    [
      {
        kind: 'sandbox-skipped',
        packId: 'sample-pack',
        reason: 'not-installed',
      },
      'pack sample-pack: has an actor but gets no sandbox (not-installed)',
      'info',
    ],
    [
      {
        kind: 'messages-dropped',
        packId: 'sample-pack',
        reason: 'rate-limited',
        count: 1,
      },
      'pack sample-pack: dropped 1 message from its sandbox (rate-limited)',
      'warn',
    ],
    [
      {
        kind: 'messages-dropped',
        packId: 'sample-pack',
        reason: 'not-own-actor',
        count: 7,
      },
      'pack sample-pack: dropped 7 messages from its sandbox (not-own-actor)',
      'warn',
    ],
    [
      { kind: 'stage-log', packId: 'sample-pack', text: 'hello' },
      'pack sample-pack: stage.log: hello',
      'info',
    ],
  ])('%j: one line naming the pack', (entry, message, level) => {
    expect(packLogLine(entry)).toStrictEqual({ message, level });
  });

  it('stage.log: control and bidi characters are escaped, and the text cut', () => {
    expect(
      packLogLine({
        kind: 'stage-log',
        packId: 'sample-pack',
        text: 'a\nb‮c\u0000',
      }).message,
    ).toBe('pack sample-pack: stage.log: a\\u000ab\\u202ec\\u0000');
    const long = packLogLine({
      kind: 'stage-log',
      packId: 'sample-pack',
      text: '\u0001'.repeat(STAGE_LOG_MAX_LENGTH),
    }).message;
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(
      'pack sample-pack: stage.log: '.length + STAGE_LOG_MAX_LENGTH + 1,
    );
  });

  it('logPackEntry writes it under packs at its level', () => {
    logPackEntry({
      kind: 'sandbox-destroyed',
      packId: 'sample-pack',
      reason: 'idle',
    });
    logPackEntry({
      kind: 'sandbox-failed',
      packId: 'sample-pack',
      reason: 'bad-report',
    });

    expect(lines(info)).toStrictEqual([
      `[packs] pack sample-pack: sandbox destroyed (no actor for ${SANDBOX_IDLE_MS} ms)`,
    ]);
    expect(lines(error)).toStrictEqual([
      '[packs] pack sample-pack: sandbox failed (bad-report); its iframe was removed',
    ]);
  });
});

describe('packs:get-entry and packs:log', () => {
  let reads: string[];
  let logged: PackLogEntry[];

  beforeEach(() => {
    reads = [];
    logged = [];
    registerPackSandboxHandlers(
      async (packId): Promise<PackEntryResult> => {
        reads.push(packId);
        return readPackEntry(store, packId);
      },
      (entry) => {
        logged.push(entry);
      },
      // packs:get-manifest (Story 3.6) has its own tests.
      () => ({ ok: false, code: 'not-installed' }),
    );
    fake.sender.mainFrame.url = OVERLAY_URL;
  });

  function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return fake.ipcRenderer.invoke(channel, ...args);
  }

  it('are open to the overlay only', () => {
    expect(PACK_SANDBOX_RENDERERS).toStrictEqual(['overlay']);
  });

  it("the overlay gets an installed pack's entry and writes a line", async () => {
    expect(await invoke(packsGetEntry.channel, CONTRACT_PACK_ID)).toMatchObject(
      {
        ok: true,
        data: { ok: true, packId: CONTRACT_PACK_ID, version: '1.0.0' },
      },
    );
    expect(
      await invoke(packsLog.channel, {
        kind: 'sandbox-destroyed',
        packId: CONTRACT_PACK_ID,
        reason: 'idle',
      }),
    ).toStrictEqual({ ok: true, data: null });
    expect(logged).toStrictEqual([
      { kind: 'sandbox-destroyed', packId: CONTRACT_PACK_ID, reason: 'idle' },
    ]);
  });

  describe('I/O matrix', () => {
    it('第一個 actor: the source handed over is the file the manifest names, even when it sorts after the assets (main.js after img/)', async () => {
      const files: Map<string, Buffer | string> = contractPackFiles();
      const source = files.get('entry.js') as Buffer;
      files.delete('entry.js');
      files.set('main.js', source);
      const manifest = contractManifest();
      manifest.entry = 'main.js';
      manifest.version = '1.1.0';
      files.set('manifest.json', manifestBytes(manifest));
      const awpet = path.join(root, 'moved-entry.awpet');
      fs.writeFileSync(awpet, await zipBuffer(itemsOf(files)));
      const inspection = await inspectPack(awpet, store);
      if (!inspection.ok) {
        throw new Error(JSON.stringify(inspection.rejection));
      }
      expect(installPack(store, inspection.plan).ok).toBe(true);
      const served = store.find(CONTRACT_PACK_ID)?.servedPaths ?? [];
      expect(served.indexOf('main.js')).toBeGreaterThan(0);

      expect(
        await invoke(packsGetEntry.channel, CONTRACT_PACK_ID),
      ).toStrictEqual({
        ok: true,
        data: {
          ok: true,
          packId: CONTRACT_PACK_ID,
          version: '1.1.0',
          source: source.toString('utf8'),
        },
      });
    });

    it.each<[string, unknown[]]>([
      ['no argument', []],
      ['a number', [1]],
      ['an id that is not a pack id', ['_stage']],
      ['a path', ['contract-pack/../x']],
      ['two ids', [CONTRACT_PACK_ID, CONTRACT_PACK_ID]],
    ])(
      '壞輸入: packs:get-entry with %s answers invalid-input and reads nothing',
      async (_label, args) => {
        expect(await invoke(packsGetEntry.channel, ...args)).toMatchObject({
          ok: false,
          error: { code: 'invalid-input' },
        });
        expect(reads).toStrictEqual([]);
      },
    );

    it.each<[string, unknown[]]>([
      ['no argument', []],
      ['an unknown kind', [{ kind: 'shout', packId: CONTRACT_PACK_ID }]],
      [
        'an extra field',
        [
          {
            kind: 'sandbox-destroyed',
            packId: CONTRACT_PACK_ID,
            reason: 'idle',
            sessionKey: 'demo:1',
          },
        ],
      ],
      [
        'a bad pack id',
        [{ kind: 'sandbox-destroyed', packId: 'A B', reason: 'idle' }],
      ],
      [
        'no destroy reason',
        [{ kind: 'sandbox-destroyed', packId: CONTRACT_PACK_ID }],
      ],
      [
        'a stage.log over its length',
        [
          {
            kind: 'stage-log',
            packId: CONTRACT_PACK_ID,
            text: 'x'.repeat(STAGE_LOG_MAX_LENGTH + 1),
          },
        ],
      ],
      [
        'a ready line with a failed removal',
        [
          {
            kind: 'sandbox-ready',
            packId: CONTRACT_PACK_ID,
            version: '1.0.0',
            removals: [{ name: 'fetch', status: 'failed' }],
            consoleLines: 0,
          },
        ],
      ],
      [
        'a removal name that is not a name',
        [
          {
            kind: 'sandbox-failed',
            packId: CONTRACT_PACK_ID,
            reason: 'api-removal-failed',
            removals: [{ name: 'fetch; rm -rf', status: 'failed' }],
          },
        ],
      ],
      [
        'a drop count of 0',
        [
          {
            kind: 'messages-dropped',
            packId: CONTRACT_PACK_ID,
            reason: 'invalid',
            count: 0,
          },
        ],
      ],
      [
        'two entries',
        [{ kind: 'sandbox-destroyed', packId: CONTRACT_PACK_ID }, {}],
      ],
    ])(
      '壞輸入: packs:log with %s answers invalid-input and writes nothing',
      async (_label, args) => {
        expect(await invoke(packsLog.channel, ...args)).toMatchObject({
          ok: false,
          error: { code: 'invalid-input' },
        });
        expect(logged).toStrictEqual([]);
      },
    );

    it.each([
      ['the panels', 'app://panels/index.html'],
      ['a pack:// page', 'pack://_stage/sandbox.html'],
    ])(
      '壞輸入: both answer sender-rejected to %s, reaching nothing',
      async (_label, url) => {
        fake.sender.mainFrame.url = url;

        expect(
          await invoke(packsGetEntry.channel, CONTRACT_PACK_ID),
        ).toMatchObject({ ok: false, error: { code: 'sender-rejected' } });
        expect(
          await invoke(packsLog.channel, {
            kind: 'sandbox-destroyed',
            packId: CONTRACT_PACK_ID,
            reason: 'idle',
          }),
        ).toMatchObject({ ok: false, error: { code: 'sender-rejected' } });
        expect(reads).toStrictEqual([]);
        expect(logged).toStrictEqual([]);
      },
    );

    it('不相容: main does not hand over the entry of an installed pack that does not fit the stage API', async () => {
      const index = path.join(root, 'packs', 'index.json');
      const file = JSON.parse(fs.readFileSync(index, 'utf8')) as {
        packs: { apiVersion: string }[];
      };
      for (const pack of file.packs) {
        pack.apiVersion = '1.9';
      }
      fs.writeFileSync(index, JSON.stringify(file));
      store = loadPacks({ dir: path.join(root, 'packs') });

      expect(
        await invoke(packsGetEntry.channel, CONTRACT_PACK_ID),
      ).toStrictEqual({
        ok: true,
        data: { ok: false, code: 'api-incompatible' },
      });
      expect(
        store.get().packs.installed.map((pack) => pack.compatibility),
      ).toStrictEqual([
        { compatible: false, reason: 'pack-newer', required: '1.9' },
      ]);
    });
  });
});
