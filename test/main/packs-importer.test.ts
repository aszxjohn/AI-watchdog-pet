/**
 * main/packs' importer (Story 3.2's second half): the one import flow, as a
 * state machine over StageView's `packImport` section. The file dialog,
 * the check and the install are fakes (each answering when the test says),
 * except in the last block, where the real inspectPack and installPack
 * run on the contract test pack in a temp folder.
 */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPackImporter,
  type PackImporter,
} from '../../src/main/packs/importer';
import {
  inspectPack,
  type PackInspection,
  type PackInstallPlan,
} from '../../src/main/packs/inspect';
import {
  installPack,
  type PackInstallResult,
} from '../../src/main/packs/install';
import { loadPacks } from '../../src/main/packs/store';
import { loadSettings } from '../../src/main/settings/store';
import { createStageView } from '../../src/main/stage-view/stage-view';
import { createWindowsStageSource } from '../../src/main/windows/stage-sources';
import { PACK_IMPORT_REPORTED_ISSUES_MAX } from '../../src/shared/constants';
import {
  stagePackImportSchema,
  type PackManifestIssue,
  type PackRejection,
  type StagePackImport,
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

const STORE = { fake: 'store' } as const;
const FILE = '/Users/someone/Downloads/sample.awpet';
const OTHER_FILE = '/Users/someone/Downloads/other.awpet';

function planOf(over: Partial<PackInstallPlan> = {}): PackInstallPlan {
  return {
    packId: 'sample-pack',
    name: '範例包',
    version: '1.1.0',
    previous: null,
    downgrade: false,
    index: {
      id: 'sample-pack',
      name: '範例包',
      version: '1.1.0',
      apiVersion: '1.0',
      characters: [{ id: 'probe-a', name: '探針甲', height: 110 }],
      servedPaths: ['entry.js'],
    },
    files: new Map([['manifest.json', Buffer.from('{}')]]),
    ...over,
  };
}

const REPLACING = planOf({
  previous: { name: '舊範例包', version: '1.0.0' },
});

let inspections: Deferred<PackInspection>[];
let dialogs: Deferred<string | null>[];
let deferredRuns: (() => void)[];
let inspect: ReturnType<
  typeof vi.fn<(file: string, store: typeof STORE) => Promise<PackInspection>>
>;
let install: ReturnType<
  typeof vi.fn<
    (store: typeof STORE, plan: PackInstallPlan) => PackInstallResult
  >
>;
let chooseFile: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
let importer: PackImporter;
let states: StagePackImport[];

beforeEach(() => {
  fake.resetFakeElectron();
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  inspections = [];
  dialogs = [];
  deferredRuns = [];
  inspect = vi.fn(() => {
    const next = deferred<PackInspection>();
    inspections.push(next);
    return next.promise;
  });
  install = vi.fn((_store, plan) => ({
    ok: true as const,
    packId: plan.packId,
    version: plan.version,
  }));
  chooseFile = vi.fn(() => {
    const next = deferred<string | null>();
    dialogs.push(next);
    return next.promise;
  });
  importer = createPackImporter({
    store: STORE,
    inspect,
    install,
    chooseFile,
    defer: (run) => {
      deferredRuns.push(run);
    },
  });
  states = [];
  importer.onChange(({ packImport }) => {
    states.push(packImport);
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

/** The `packImport` section now. */
function phase(): StagePackImport {
  return importer.get().packImport;
}

/** Answers the latest check with `inspection` and lets the importer go on. */
async function inspected(inspection: PackInspection): Promise<void> {
  inspections.at(-1)?.resolve(inspection);
  await settle();
}

/** Runs the installs the importer put off to a later task. */
function runDeferred(): void {
  for (const run of deferredRuns.splice(0)) {
    run();
  }
}

/** Brings the importer to `confirm` for REPLACING (or `plan`). */
async function waitingForConfirmation(plan = REPLACING): Promise<void> {
  const started = importer.start(FILE);
  await inspected({ ok: true, plan });
  await started;
  expect(phase().phase).toBe('confirm');
}

const INSTALLED_SAMPLE: StagePackImport = {
  phase: 'result',
  outcome: 'installed',
  packId: 'sample-pack',
  name: '範例包',
  version: '1.1.0',
};

describe('the packImport section', () => {
  it('starts idle; get() and onChange() carry it; an unsubscribed listener hears nothing more', async () => {
    expect(importer.get()).toStrictEqual({ packImport: { phase: 'idle' } });
    const later = vi.fn();
    const unsubscribe = importer.onChange(later);
    unsubscribe();

    void importer.start(FILE);

    expect(later).not.toHaveBeenCalled();
    expect(states).toStrictEqual([{ phase: 'reading' }]);
  });

  it('a listener that throws is logged; the others still hear the change', () => {
    importer.onChange(() => {
      throw Object.assign(new Error('boom'), { code: 'EBOOM' });
    });
    const after = vi.fn();
    importer.onChange(after);

    void importer.start(FILE);

    expect(after).toHaveBeenCalledOnce();
    expect(packsLines('error')).toStrictEqual([
      '[packs] a change listener failed (EBOOM)',
    ]);
  });

  it('every state it publishes passes the shared schema, and no log line names the file', async () => {
    await waitingForConfirmation();
    importer.confirm(true);
    runDeferred();
    const rejected = importer.start(OTHER_FILE);
    await inspected({
      ok: false,
      rejection: { code: 'missing-file', path: 'entry.js' },
    });
    await rejected;

    for (const state of states) {
      expect(
        stagePackImportSchema.safeParse(state).success,
        JSON.stringify(state),
      ).toBe(true);
    }
    for (const line of allPacksLines()) {
      expect(line).not.toContain('/Users/someone');
      expect(line).not.toContain('.awpet');
    }
  });
});

describe('I/O matrix', () => {
  it('選檔: choose() is reading at once (before the dialog closes), opens the dialog once, then checks the file picked against the store', async () => {
    const chosen = importer.choose();

    expect(phase()).toStrictEqual({ phase: 'reading' });
    expect(chooseFile).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalled();

    dialogs[0]?.resolve(FILE);
    await settle();
    expect(inspect).toHaveBeenCalledExactlyOnceWith(FILE, STORE);
    await inspected({ ok: true, plan: planOf() });
    await chosen;
    expect(phase()).toStrictEqual(INSTALLED_SAMPLE);
  });

  it('取消選檔: a cancelled dialog goes back to idle, with no error', async () => {
    const chosen = importer.choose();
    dialogs[0]?.resolve(null);
    await chosen;

    expect(states).toStrictEqual([{ phase: 'reading' }, { phase: 'idle' }]);
    expect(inspect).not.toHaveBeenCalled();
    expect(packsLines('error')).toStrictEqual([]);
    expect(packsLines('info')).toContain(
      '[packs] the file dialog was cancelled',
    );
  });

  it('取消選檔: after an earlier result, a cancelled dialog goes back to that result', async () => {
    const started = importer.start(FILE);
    await inspected({ ok: true, plan: planOf() });
    await started;

    const chosen = importer.choose();
    dialogs[0]?.resolve(null);
    await chosen;

    expect(phase()).toStrictEqual(INSTALLED_SAMPLE);
    expect(states.slice(-2)).toStrictEqual([
      { phase: 'reading' },
      INSTALLED_SAMPLE,
    ]);
  });

  it('取消選檔: a dialog that fails is logged and goes back to the phase before', async () => {
    const chosen = importer.choose();
    dialogs[0]?.reject(Object.assign(new Error('no'), { code: 'EDIALOG' }));
    await chosen;

    expect(phase()).toStrictEqual({ phase: 'idle' });
    expect(packsLines('error')).toStrictEqual([
      '[packs] the file dialog failed (EDIALOG)',
    ]);
  });

  it('新包: a pack of an id not installed is installed at once, with no confirmation: 已安裝 with its name and version', async () => {
    const plan = planOf();
    const started = importer.start(FILE);
    await inspected({ ok: true, plan });
    await started;

    expect(install).toHaveBeenCalledExactlyOnceWith(STORE, plan);
    expect(states).toStrictEqual([{ phase: 'reading' }, INSTALLED_SAMPLE]);
  });

  it('拒絕: a refused pack is a rejected result carrying the code and what its message needs', async () => {
    const rejection: PackRejection = {
      code: 'api-incompatible',
      reason: 'pack-newer',
      required: '1.3',
    };
    const started = importer.start(FILE);
    await inspected({ ok: false, rejection });
    await started;

    expect(install).not.toHaveBeenCalled();
    expect(phase()).toStrictEqual({
      phase: 'result',
      outcome: 'rejected',
      rejection,
      moreIssues: 0,
    });
  });

  it.each<[string, PackRejection, PackRejection]>([
    [
      'a long quoted name is cut',
      { code: 'missing-file', path: `${'a/'.repeat(150)}entry.js` },
      { code: 'missing-file', path: `${'a/'.repeat(100)}…` },
    ],
    [
      'a bidi character is escaped',
      { code: 'unsafe-path', path: 'x‮gnp.js' },
      { code: 'unsafe-path', path: 'x\\u202egnp.js' },
    ],
    [
      'the root folder is quoted too',
      {
        code: 'root-folder-mismatch',
        folder: 'f'.repeat(250),
        packId: 'sample-pack',
      },
      {
        code: 'root-folder-mismatch',
        folder: `${'f'.repeat(200)}…`,
        packId: 'sample-pack',
      },
    ],
    [
      'an image over the total has no path',
      { code: 'image-too-large', limit: 'total-pixels' },
      { code: 'image-too-large', limit: 'total-pixels' },
    ],
  ])('拒絕: %s before it is published', async (_label, given, published) => {
    const started = importer.start(FILE);
    await inspected({ ok: false, rejection: given });
    await started;

    expect(phase()).toStrictEqual({
      phase: 'result',
      outcome: 'rejected',
      rejection: published,
      moreIssues: 0,
    });
    expect(stagePackImportSchema.safeParse(phase()).success).toBe(true);
  });

  it(`manifest 錯: an invalid-manifest keeps its first ${PACK_IMPORT_REPORTED_ISSUES_MAX} issues and counts the rest; named path segments are quoted`, async () => {
    const issues: PackManifestIssue[] = [
      { code: 'unrecognized_keys', path: ['k'.repeat(300)] },
      {
        code: 'custom',
        rule: 'hitbox-outside-bounds',
        path: ['characters', 0, 'hitbox'],
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        code: 'invalid_type',
        path: ['characters', i, 'name\u0007'],
      })),
    ];
    const started = importer.start(FILE);
    await inspected({
      ok: false,
      rejection: { code: 'invalid-manifest', issues },
    });
    await started;

    expect(phase()).toStrictEqual({
      phase: 'result',
      outcome: 'rejected',
      rejection: {
        code: 'invalid-manifest',
        issues: [
          { code: 'unrecognized_keys', path: [`${'k'.repeat(200)}…`] },
          {
            code: 'custom',
            rule: 'hitbox-outside-bounds',
            path: ['characters', 0, 'hitbox'],
          },
          { code: 'invalid_type', path: ['characters', 0, 'name\\u0007'] },
          { code: 'invalid_type', path: ['characters', 1, 'name\\u0007'] },
          { code: 'invalid_type', path: ['characters', 2, 'name\\u0007'] },
        ],
      },
      moreIssues: 3,
    });
    expect(stagePackImportSchema.safeParse(phase()).success).toBe(true);
  });

  it('需要確認: a pack of an installed id waits for confirmation, showing the new and the installed name and version; nothing is installed yet', async () => {
    await waitingForConfirmation();

    expect(install).not.toHaveBeenCalled();
    expect(phase()).toStrictEqual({
      phase: 'confirm',
      packId: 'sample-pack',
      name: '範例包',
      version: '1.1.0',
      previous: { name: '舊範例包', version: '1.0.0' },
      downgrade: false,
    });
  });

  it('需要確認: the same version again also waits for confirmation', async () => {
    await waitingForConfirmation(
      planOf({ previous: { name: '範例包', version: '1.1.0' } }),
    );

    expect(install).not.toHaveBeenCalled();
    expect(phase()).toMatchObject({
      phase: 'confirm',
      version: '1.1.0',
      previous: { version: '1.1.0' },
      downgrade: false,
    });
  });

  it('需要確認: 取代 installs the waiting plan on a later task (reading meanwhile), then 已安裝', async () => {
    await waitingForConfirmation();

    importer.confirm(true);

    expect(phase()).toStrictEqual({ phase: 'reading' });
    expect(install).not.toHaveBeenCalled();
    runDeferred();
    expect(install).toHaveBeenCalledExactlyOnceWith(STORE, REPLACING);
    expect(phase()).toStrictEqual(INSTALLED_SAMPLE);
  });

  it('降版: an older version waits for confirmation with downgrade set', async () => {
    await waitingForConfirmation(
      planOf({
        version: '0.9.0',
        previous: { name: '範例包', version: '1.0.0' },
        downgrade: true,
      }),
    );

    expect(phase()).toMatchObject({
      phase: 'confirm',
      version: '0.9.0',
      previous: { version: '1.0.0' },
      downgrade: true,
    });
  });

  it('取消取代: 取消 installs nothing, the result is cancelled, and the plan is let go', async () => {
    await waitingForConfirmation();

    importer.confirm(false);
    importer.confirm(true);
    runDeferred();

    expect(install).not.toHaveBeenCalled();
    expect(deferredRuns).toStrictEqual([]);
    expect(phase()).toStrictEqual({ phase: 'result', outcome: 'cancelled' });
    expect(packsLines('info')).toContain(
      '[packs] ignored a confirmation: no pack waits for one',
    );
  });

  it('計畫過期: an install that answers stale-plan is a failed result with that code', async () => {
    install.mockReturnValue({ ok: false, code: 'stale-plan' });
    await waitingForConfirmation();

    importer.confirm(true);
    runDeferred();

    expect(phase()).toStrictEqual({
      phase: 'result',
      outcome: 'failed',
      code: 'stale-plan',
    });
  });

  it.each([
    ['index-unwritable'],
    ['extract-failed'],
    ['replace-failed'],
    ['index-write-failed'],
  ] as const)(
    '安裝失敗: an install that answers %s is a failed result with that code',
    async (code) => {
      install.mockReturnValue({ ok: false, code });
      const started = importer.start(FILE);
      await inspected({ ok: true, plan: planOf() });
      await started;

      expect(phase()).toStrictEqual({
        phase: 'result',
        outcome: 'failed',
        code,
      });
    },
  );

  it('讀取中再匯入: while a pack is checked, another start() is ignored with one line, and choose() opens no dialog', async () => {
    const first = importer.start(FILE);

    await importer.start(OTHER_FILE);
    await importer.choose();

    expect(inspect).toHaveBeenCalledOnce();
    expect(chooseFile).not.toHaveBeenCalled();
    expect(states).toStrictEqual([{ phase: 'reading' }]);
    expect(packsLines('info')).toStrictEqual([
      '[packs] ignored a .awpet to import: another import is being read',
      '[packs] the file dialog was not opened: an import is reading',
    ]);

    await inspected({ ok: true, plan: planOf() });
    await first;
    expect(phase()).toStrictEqual(INSTALLED_SAMPLE);
  });

  it('讀取中再匯入: while the dialog is open, a start() is ignored', async () => {
    const chosen = importer.choose();

    await importer.start(OTHER_FILE);

    expect(inspect).not.toHaveBeenCalled();
    dialogs[0]?.resolve(null);
    await chosen;
    expect(phase()).toStrictEqual({ phase: 'idle' });
  });

  it('讀取中再匯入: while a confirmed pack installs, a start() is ignored', async () => {
    await waitingForConfirmation();
    importer.confirm(true);

    await importer.start(OTHER_FILE);
    runDeferred();

    expect(inspect).toHaveBeenCalledOnce();
    expect(phase()).toStrictEqual(INSTALLED_SAMPLE);
  });

  it('確認中再匯入: a start() while waiting for confirmation cancels the waiting pack and begins the new one', async () => {
    await waitingForConfirmation();

    const second = importer.start(OTHER_FILE);

    expect(phase()).toStrictEqual({ phase: 'reading' });
    expect(inspect).toHaveBeenLastCalledWith(OTHER_FILE, STORE);
    expect(packsLines('info')).toContain(
      '[packs] pack sample-pack: no longer waiting for confirmation; a new import came in',
    );
    const fresh = planOf({ packId: 'fresh-pack', name: '新包' });
    await inspected({ ok: true, plan: fresh });
    await second;

    // Only the new pack went in; the cancelled plan cannot be confirmed.
    expect(install).toHaveBeenCalledExactlyOnceWith(STORE, fresh);
    importer.confirm(true);
    runDeferred();
    expect(install).toHaveBeenCalledOnce();
  });

  it('確認中再匯入: choose() while waiting for confirmation opens no dialog and changes nothing', async () => {
    await waitingForConfirmation();
    const before = phase();

    await importer.choose();

    expect(chooseFile).not.toHaveBeenCalled();
    expect(phase()).toBe(before);
  });

  it.each([
    ['idle', async () => {}],
    [
      'reading',
      async () => {
        void importer.start(FILE);
      },
    ],
    [
      'a result',
      async () => {
        const started = importer.start(FILE);
        await inspected({ ok: true, plan: planOf() });
        await started;
      },
    ],
  ])(
    '壞輸入: confirm() while %s is ignored with one line and changes nothing',
    async (_label, arrange) => {
      await arrange();
      const before = phase();
      const heard = states.length;

      importer.confirm(true);
      importer.confirm(false);
      runDeferred();

      expect(phase()).toBe(before);
      expect(states).toHaveLength(heard);
      expect(install).toHaveBeenCalledTimes(before.phase === 'result' ? 1 : 0);
      expect(
        packsLines('info').filter((line) => line.includes('confirmation')),
      ).toStrictEqual([
        '[packs] ignored a confirmation: no pack waits for one',
        '[packs] ignored a confirmation: no pack waits for one',
      ]);
    },
  );
});

describe('a check or install that throws (a bug)', () => {
  it('a check that rejects is logged as an error and the import goes back to idle', async () => {
    const started = importer.start(FILE);
    inspections[0]?.reject(Object.assign(new Error('bug'), { code: 'EBUG' }));
    await started;

    expect(phase()).toStrictEqual({ phase: 'idle' });
    expect(packsLines('error')).toStrictEqual([
      '[packs] the import failed unexpectedly while checking the file (EBUG)',
    ]);
  });

  it('an install that throws is logged as an error and the import goes back to idle', async () => {
    install.mockImplementation(() => {
      throw Object.assign(new Error('bug'), { code: 'EBUG' });
    });
    await waitingForConfirmation();

    importer.confirm(true);
    runDeferred();

    expect(phase()).toStrictEqual({ phase: 'idle' });
    expect(packsLines('error')).toStrictEqual([
      '[packs] the import failed unexpectedly while installing (EBUG)',
    ]);
  });

  it('the default defer runs the confirmed install on a later task', async () => {
    const real = createPackImporter({
      store: STORE,
      inspect: async () => ({ ok: true, plan: REPLACING }),
      install,
      chooseFile,
    });
    await real.start(FILE);

    real.confirm(true);
    expect(install).not.toHaveBeenCalled();
    await settle();

    expect(install).toHaveBeenCalledExactlyOnceWith(STORE, REPLACING);
    expect(real.get().packImport).toStrictEqual(INSTALLED_SAMPLE);
  });
});

describe('with the real check and install (the contract test pack)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-packs-importer-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The contract pack at `version` (manifest changed by `edit`) as a .awpet. */
  async function awpet(
    name: string,
    version = '1.0.0',
    edit: (manifest: Record<string, unknown>) => void = () => {},
  ): Promise<string> {
    const files: Map<string, Buffer | string> = contractPackFiles();
    const manifest = contractManifest();
    manifest.version = version;
    edit(manifest);
    files.set('manifest.json', manifestBytes(manifest));
    const at = path.join(root, name);
    fs.writeFileSync(at, await zipBuffer(itemsOf(files)));
    return at;
  }

  function wire() {
    const store = loadPacks({ dir: path.join(root, 'packs') });
    const real = createPackImporter({
      store,
      inspect: inspectPack,
      install: installPack,
      chooseFile: async () => null,
    });
    const hub = createStageView({
      settings: loadSettings({ file: path.join(root, 'settings.json') }),
      windows: createWindowsStageSource(),
      assigner: {
        get: () => ({
          sessions: [],
          adapters: [],
          pool: { released: [] },
          actors: [],
        }),
        onChange: () => () => {},
      },
      packs: store,
      packImport: real,
      packExport: {
        get: () => ({ packExport: { phase: 'idle' } }),
        onChange: () => () => {},
      },
      characters: {
        get: () => ({ characters: {} }),
        onChange: () => () => {},
      },
    });
    const subscriber = fake.createFakeWebContents(
      1,
      'app://panels/index.html',
      false,
    );
    hub.subscribe(subscriber);
    const deltas = () => subscriber.sent.map(({ args }) => args[0]);
    return { store, real, hub, deltas };
  }

  it('新包: installs it; StageView gets reading, then one more pack in packs, then 已安裝; every delta passes the schema', async () => {
    const { real, hub, deltas } = wire();

    await real.start(await awpet('first.awpet'));

    expect(hub.snapshot().view.packs.installed.map((p) => p.id)).toStrictEqual([
      CONTRACT_PACK_ID,
    ]);
    expect(hub.snapshot().view.packImport).toStrictEqual({
      phase: 'result',
      outcome: 'installed',
      packId: CONTRACT_PACK_ID,
      name: '契約測試包',
      version: '1.0.0',
    });
    expect(
      deltas().map((delta) =>
        Object.keys((delta as { sections: object }).sections),
      ),
    ).toStrictEqual([['packImport'], ['packs'], ['packImport']]);
    for (const delta of deltas()) {
      expect(stageViewDeltaSchema.safeParse(delta).success).toBe(true);
    }
  });

  it('需要確認, 降版: the same pack at an older version waits for confirmation with the downgrade, and 取代 installs it', async () => {
    const { real, hub } = wire();
    await real.start(await awpet('first.awpet', '1.2.0'));

    await real.start(await awpet('older.awpet', '1.1.0'));
    expect(hub.snapshot().view.packImport).toStrictEqual({
      phase: 'confirm',
      packId: CONTRACT_PACK_ID,
      name: '契約測試包',
      version: '1.1.0',
      previous: { name: '契約測試包', version: '1.2.0' },
      downgrade: true,
    });

    real.confirm(true);
    await settle();

    expect(hub.snapshot().view.packs.installed[0]?.version).toBe('1.1.0');
    expect(hub.snapshot().view.packImport).toMatchObject({
      phase: 'result',
      outcome: 'installed',
      version: '1.1.0',
    });
  });

  it('manifest 錯: a manifest with many unknown keys is rejected with a short, valid section', async () => {
    const { real, hub, deltas } = wire();

    await real.start(
      await awpet('broken.awpet', '1.0.0', (manifest) => {
        for (let i = 0; i < 40; i += 1) {
          manifest[`extra-${i}`] = i;
        }
      }),
    );

    const section = hub.snapshot().view.packImport;
    expect(section).toMatchObject({
      phase: 'result',
      outcome: 'rejected',
      rejection: { code: 'invalid-manifest' },
      moreIssues: 40 - PACK_IMPORT_REPORTED_ISSUES_MAX,
    });
    for (const delta of deltas()) {
      expect(stageViewDeltaSchema.safeParse(delta).success).toBe(true);
    }
    expect(hub.snapshot().view.packs.installed).toStrictEqual([]);
  });

  it('拒絕: a file that is not a zip is rejected as invalid-archive', async () => {
    const { real, hub } = wire();
    const notZip = path.join(root, 'text.awpet');
    fs.writeFileSync(notZip, 'not a zip');

    await real.start(notZip);

    expect(hub.snapshot().view.packImport).toStrictEqual({
      phase: 'result',
      outcome: 'rejected',
      rejection: { code: 'invalid-archive' },
      moreIssues: 0,
    });
  });
});
