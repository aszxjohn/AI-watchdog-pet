/**
 * main/packs' exporter (Story 3.3's second half): the export flow behind
 * each pack's 匯出…, as a state machine over StageView's `packExport`
 * section. The save dialog and the export are fakes (each answering when
 * the test says), except in the last block, where the real store,
 * exportPack and removePack run on the contract test pack in a temp folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportPack as realExportPack,
  type PackExportResult,
} from '../../src/main/packs/export';
import {
  createPackExporter,
  type PackExporter,
} from '../../src/main/packs/exporter';
import { createPackImporter } from '../../src/main/packs/importer';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import { removePack } from '../../src/main/packs/remove';
import { loadPacks } from '../../src/main/packs/store';
import { loadSettings } from '../../src/main/settings/store';
import { createStageView } from '../../src/main/stage-view/stage-view';
import { createWindowsStageSource } from '../../src/main/windows/stage-sources';
import {
  stagePackExportSchema,
  type StagePackExport,
} from '../../src/shared/packs';
import { stageViewDeltaSchema } from '../../src/shared/stage-view';
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

/** A promise and the functions that settle it. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const TARGET = '/Users/someone/Desktop/sample-pack-1.1.0.awpet';
const PACK_ID = 'sample-pack';

/** A store with `sample-pack` 1.1.0 and `other-pack` 2.0.0 installed. */
function fakeStore() {
  const installed = new Map([
    [PACK_ID, { name: '範例包', version: '1.1.0' }],
    ['other-pack', { name: '另一包', version: '2.0.0' }],
  ]);
  return {
    installed,
    find: (packId: string) => installed.get(packId),
  };
}

type Store = ReturnType<typeof fakeStore>;

let store: Store;
let dialogs: Deferred<string | null>[];
let writes: Deferred<PackExportResult>[];
let chooseTarget: ReturnType<
  typeof vi.fn<(defaultName: string) => Promise<string | null>>
>;
let exportPack: ReturnType<
  typeof vi.fn<
    (store: Store, packId: string, target: string) => Promise<PackExportResult>
  >
>;
let exporter: PackExporter;
let states: StagePackExport[];

beforeEach(() => {
  fake.resetFakeElectron();
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  store = fakeStore();
  dialogs = [];
  writes = [];
  chooseTarget = vi.fn(() => {
    const next = deferred<string | null>();
    dialogs.push(next);
    return next.promise;
  });
  exportPack = vi.fn(() => {
    const next = deferred<PackExportResult>();
    writes.push(next);
    return next.promise;
  });
  exporter = createPackExporter({ store, chooseTarget, exportPack });
  states = [];
  exporter.onChange(({ packExport }) => {
    states.push(packExport);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function packsLines(level: 'info' | 'warn' | 'error'): string[] {
  return vi
    .mocked(console[level])
    .mock.calls.map((call: unknown[]) => String(call[0]))
    .filter((line) => line.startsWith('[packs] '));
}

function allPacksLines(): string[] {
  return [...packsLines('info'), ...packsLines('warn'), ...packsLines('error')];
}

/** The `packExport` section now. */
function phase(): StagePackExport {
  return exporter.get().packExport;
}

/** Closes the latest save dialog on `target` (null: cancelled). */
async function picked(target: string | null): Promise<void> {
  dialogs.at(-1)?.resolve(target);
  await settle();
}

/** Answers the latest export with `result`. */
async function written(result: PackExportResult): Promise<void> {
  writes.at(-1)?.resolve(result);
  await settle();
}

const SAVING: StagePackExport = { phase: 'saving', packId: PACK_ID };
const EXPORTED: StagePackExport = {
  phase: 'result',
  outcome: 'exported',
  packId: PACK_ID,
  name: '範例包',
  version: '1.1.0',
};

/** One export of PACK_ID all the way through, answering `result`. */
async function exportOnce(
  result: PackExportResult = { ok: true, name: '範例包', version: '1.1.0' },
): Promise<void> {
  const started = exporter.start(PACK_ID);
  await picked(TARGET);
  await written(result);
  await started;
}

describe('the packExport section', () => {
  it('starts idle; get() and onChange() carry it; an unsubscribed listener hears nothing more', () => {
    expect(exporter.get()).toStrictEqual({ packExport: { phase: 'idle' } });
    const later = vi.fn();
    const unsubscribe = exporter.onChange(later);
    unsubscribe();

    void exporter.start(PACK_ID);

    expect(later).not.toHaveBeenCalled();
    expect(states).toStrictEqual([SAVING]);
  });

  it('a listener that throws is logged; the others still hear the change', () => {
    exporter.onChange(() => {
      throw Object.assign(new Error('boom'), { code: 'EBOOM' });
    });
    const after = vi.fn();
    exporter.onChange(after);

    void exporter.start(PACK_ID);

    expect(after).toHaveBeenCalledOnce();
    expect(packsLines('error')).toStrictEqual([
      '[packs] a change listener failed (EBOOM)',
    ]);
  });

  it('every state it publishes passes the shared schema, and no log line names the place picked', async () => {
    await exportOnce();
    await exportOnce({ ok: false, code: 'write-failed' });
    const cancelled = exporter.start(PACK_ID);
    await picked(null);
    await cancelled;
    await exporter.start('gone-pack');

    expect(states.length).toBeGreaterThan(5);
    for (const state of states) {
      expect(
        stagePackExportSchema.safeParse(state).success,
        JSON.stringify(state),
      ).toBe(true);
    }
    for (const line of allPacksLines()) {
      expect(line).not.toContain('/Users/someone');
      expect(line).not.toContain('Desktop');
    }
  });
});

describe('I/O matrix', () => {
  it('匯出: start() is saving at once (before the dialog closes) and opens the save dialog once, named <packId>-<version>.awpet; nothing is written yet', () => {
    void exporter.start(PACK_ID);

    expect(phase()).toStrictEqual(SAVING);
    expect(chooseTarget).toHaveBeenCalledExactlyOnceWith(
      'sample-pack-1.1.0.awpet',
    );
    expect(exportPack).not.toHaveBeenCalled();
  });

  it('取消匯出: a cancelled save dialog goes back to idle, with no error, and writes nothing', async () => {
    const started = exporter.start(PACK_ID);
    await picked(null);
    await started;

    expect(states).toStrictEqual([SAVING, { phase: 'idle' }]);
    expect(exportPack).not.toHaveBeenCalled();
    expect(packsLines('error')).toStrictEqual([]);
    expect(packsLines('info')).toContain(
      '[packs] the save dialog was cancelled',
    );
  });

  it('取消匯出: after an earlier result, a cancelled save dialog goes back to that result', async () => {
    await exportOnce();

    const started = exporter.start('other-pack');
    expect(chooseTarget).toHaveBeenLastCalledWith('other-pack-2.0.0.awpet');
    await picked(null);
    await started;

    expect(phase()).toStrictEqual(EXPORTED);
    expect(states.slice(-2)).toStrictEqual([
      { phase: 'saving', packId: 'other-pack' },
      EXPORTED,
    ]);
  });

  it('取消匯出: a save dialog that fails is logged and goes back to the phase before', async () => {
    const started = exporter.start(PACK_ID);
    dialogs[0]?.reject(Object.assign(new Error('no'), { code: 'EDIALOG' }));
    await started;

    expect(phase()).toStrictEqual({ phase: 'idle' });
    expect(exportPack).not.toHaveBeenCalled();
    expect(packsLines('error')).toStrictEqual([
      '[packs] the save dialog failed (EDIALOG)',
    ]);
  });

  it('匯出完成: the place picked goes to exportPack with the store; then 已匯出 with the name and version written', async () => {
    const started = exporter.start(PACK_ID);
    await picked(TARGET);

    expect(exportPack).toHaveBeenCalledExactlyOnceWith(store, PACK_ID, TARGET);
    expect(phase()).toStrictEqual(SAVING);
    await written({ ok: true, name: '範例包', version: '1.1.0' });
    await started;

    expect(states).toStrictEqual([SAVING, EXPORTED]);
  });

  it.each([['read-failed'], ['write-failed']] as const)(
    '讀不到, 寫不進: exportPack answering %s is a failed result with that code and the pack id',
    async (code) => {
      await exportOnce({ ok: false, code });

      expect(phase()).toStrictEqual({
        phase: 'result',
        outcome: 'failed',
        packId: PACK_ID,
        code,
      });
    },
  );

  it('匯出中再匯出: while saving, another start() is ignored with one line: no second dialog, the section unchanged', async () => {
    const first = exporter.start(PACK_ID);

    await exporter.start('other-pack');
    await exporter.start(PACK_ID);

    expect(chooseTarget).toHaveBeenCalledOnce();
    expect(states).toStrictEqual([SAVING]);
    expect(packsLines('info')).toStrictEqual([
      '[packs] ignored an export of pack other-pack: pack sample-pack is being exported',
      '[packs] ignored an export of pack sample-pack: pack sample-pack is being exported',
    ]);

    await picked(TARGET);
    await written({ ok: true, name: '範例包', version: '1.1.0' });
    await first;
    expect(exportPack).toHaveBeenCalledOnce();
    expect(phase()).toStrictEqual(EXPORTED);
  });

  it('匯出中再匯出: while the file is written (after the dialog), another start() is ignored too', async () => {
    const first = exporter.start(PACK_ID);
    await picked(TARGET);

    await exporter.start('other-pack');

    expect(chooseTarget).toHaveBeenCalledOnce();
    await written({ ok: true, name: '範例包', version: '1.1.0' });
    await first;
    expect(phase()).toStrictEqual(EXPORTED);
  });

  it('匯出時被移除: exportPack answering not-installed (removed while the dialog was open) is a failed result', async () => {
    await exportOnce({ ok: false, code: 'not-installed' });

    expect(phase()).toStrictEqual({
      phase: 'result',
      outcome: 'failed',
      packId: PACK_ID,
      code: 'not-installed',
    });
  });

  it('匯出時被移除: a pack not installed when start() comes is a failed not-installed result at once, with no dialog', async () => {
    await exporter.start('gone-pack');

    expect(chooseTarget).not.toHaveBeenCalled();
    expect(states).toStrictEqual([
      {
        phase: 'result',
        outcome: 'failed',
        packId: 'gone-pack',
        code: 'not-installed',
      },
    ]);
    expect(packsLines('warn')).toStrictEqual([
      '[packs] could not export pack gone-pack: not-installed',
    ]);
  });
});

describe('an export that throws (a bug)', () => {
  it('an exportPack that rejects is logged as an error and the export goes back to idle', async () => {
    const started = exporter.start(PACK_ID);
    await picked(TARGET);
    writes[0]?.reject(Object.assign(new Error('bug'), { code: 'EBUG' }));
    await started;

    expect(phase()).toStrictEqual({ phase: 'idle' });
    expect(packsLines('error')).toStrictEqual([
      '[packs] the export failed unexpectedly (EBUG)',
    ]);
  });
});

describe('with the real store, export and removal (the contract test pack)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-packs-exporter-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The contract pack (or a copy of it as `packId`) as a .awpet. */
  async function awpet(name: string, packId = CONTRACT_PACK_ID) {
    const files: Map<string, Buffer | string> = contractPackFiles();
    const manifest = contractManifest();
    manifest.id = packId;
    files.set('manifest.json', manifestBytes(manifest));
    const at = path.join(root, name);
    fs.writeFileSync(at, await zipBuffer(itemsOf(files, packId)));
    return at;
  }

  /** main/packs as main.ts wires it, the save dialog closing when the test says. */
  async function wire() {
    const packs = loadPacks({ dir: path.join(root, 'packs') });
    const importer = createPackImporter({
      store: packs,
      inspect: inspectPack,
      install: installPack,
      chooseFile: async () => null,
    });
    await importer.start(await awpet('first.awpet'));
    await importer.start(await awpet('second.awpet', 'second-pack'));
    const saveDialogs: Deferred<string | null>[] = [];
    const real = createPackExporter({
      store: packs,
      exportPack: realExportPack,
      chooseTarget: () => {
        const next = deferred<string | null>();
        saveDialogs.push(next);
        return next.promise;
      },
    });
    const hub = createStageView({
      settings: loadSettings({ file: path.join(root, 'settings.json') }),
      windows: createWindowsStageSource(),
      detection: {
        get: () => ({ sessions: [], adapters: [] }),
        onChange: () => () => {},
      },
      pool: {
        get: () => ({ pool: { released: [] } }),
        onChange: () => () => {},
      },
      packs,
      packImport: importer,
      packExport: real,
    });
    const subscriber = fake.createFakeWebContents(
      1,
      'app://panels/index.html',
      false,
    );
    hub.subscribe(subscriber);
    const deltas = () => subscriber.sent.map(({ args }) => args[0]);
    return { packs, importer, real, hub, deltas, saveDialogs };
  }

  it('匯出完成: StageView gets saving, then 已匯出; the file is at the place picked; every delta passes the schema', async () => {
    const { real, hub, deltas, saveDialogs } = await wire();
    const target = path.join(root, 'exported.awpet');

    const started = real.start(CONTRACT_PACK_ID);
    expect(hub.snapshot().view.packExport).toStrictEqual({
      phase: 'saving',
      packId: CONTRACT_PACK_ID,
    });
    saveDialogs[0]?.resolve(target);
    await started;

    expect(hub.snapshot().view.packExport).toStrictEqual({
      phase: 'result',
      outcome: 'exported',
      packId: CONTRACT_PACK_ID,
      name: '契約測試包',
      version: '1.0.0',
    });
    expect(fs.existsSync(target)).toBe(true);
    expect(
      deltas().map((delta) =>
        Object.keys((delta as { sections: object }).sections),
      ),
    ).toStrictEqual([['packExport'], ['packExport']]);
    for (const delta of deltas()) {
      expect(stageViewDeltaSchema.safeParse(delta).success).toBe(true);
    }
  });

  it('匯出時被移除: the pack removed while the save dialog is open is a failed not-installed result; nothing is written', async () => {
    const { packs, real, hub, saveDialogs } = await wire();
    const target = path.join(root, 'exported.awpet');

    const started = real.start(CONTRACT_PACK_ID);
    expect(removePack(packs, CONTRACT_PACK_ID)).toStrictEqual({ ok: true });
    saveDialogs[0]?.resolve(target);
    await started;

    expect(hub.snapshot().view.packExport).toStrictEqual({
      phase: 'result',
      outcome: 'failed',
      packId: CONTRACT_PACK_ID,
      code: 'not-installed',
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('移除與匯入不受匯出影響: while the save dialog is open, another pack is removed and a pack is imported', async () => {
    const { packs, importer, real, hub, saveDialogs } = await wire();

    const started = real.start(CONTRACT_PACK_ID);
    expect(removePack(packs, 'second-pack')).toStrictEqual({ ok: true });
    await importer.start(await awpet('third.awpet', 'third-pack'));

    expect(hub.snapshot().view.packs.installed.map((p) => p.id)).toStrictEqual([
      CONTRACT_PACK_ID,
      'third-pack',
    ]);
    expect(hub.snapshot().view.packExport).toMatchObject({ phase: 'saving' });
    saveDialogs[0]?.resolve(null);
    await started;
    expect(hub.snapshot().view.packExport).toStrictEqual({ phase: 'idle' });
  });
});
