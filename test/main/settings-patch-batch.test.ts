/**
 * One `settings:patch`, one StageView delta (Story 3.6, Epic 1 retro R10),
 * one install or removal of a pack, one delta, and (Story 3.9) the sandbox
 * failure that marks a pack failed, one delta: main wired as main.ts wires
 * it (real settings, detection on a fake clock with a fake codex adapter,
 * pool store, packs store, the packs' importer with its install in a
 * StageView batch, the pool's assigner, main/settings' characters, the
 * windows source laid out by watchDisplays on a fake screen, StageView, the
 * settings IPC handlers, `packs:remove` and `packs:runtime-failed` each in
 * a batch), driven through the panels' and the overlay's channels over
 * fake electron. This is also the settings → StageView → watchDisplays →
 * canvas chain R10 found untested.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext } from '../../src/main/detection/adapter';
import { createDetection } from '../../src/main/detection/detection';
import { createPackImporter } from '../../src/main/packs/importer';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import {
  registerPackHandlers,
  registerPackSandboxHandlers,
} from '../../src/main/packs/ipc';
import { readInstalledManifest } from '../../src/main/packs/manifest';
import { removePack } from '../../src/main/packs/remove';
import { createRuntimeFailures } from '../../src/main/packs/runtime-failures';
import { loadPacks, type PacksStore } from '../../src/main/packs/store';
import { createAssigner } from '../../src/main/pool/assign';
import { loadPool } from '../../src/main/pool/store';
import { createCharacters } from '../../src/main/settings/characters';
import { registerSettingsHandlers } from '../../src/main/settings/ipc';
import { loadSettings } from '../../src/main/settings/store';
import { createStageView } from '../../src/main/stage-view/stage-view';
import type { CanvasPlacement } from '../../src/main/windows/canvas-window';
import type { ScreenDisplay } from '../../src/main/windows/displays';
import {
  createWindowsStageSource,
  watchDisplays,
  type ScreenEvent,
} from '../../src/main/windows/stage-sources';
import { PACK_RESTART_LIMIT } from '../../src/shared/constants';
import {
  confidenceFor,
  detectionEventSchema,
  type DetectionEvent,
} from '../../src/shared/detection-events';
import {
  packsRemove,
  packsRuntimeFailed,
  settingsPatch,
} from '../../src/shared/ipc';
import type { PackRuntimeFailure } from '../../src/shared/sandbox';
import type { SettingsOp } from '../../src/shared/settings';
import {
  stageViewDeltaSchema,
  type StageViewDelta,
} from '../../src/shared/stage-view';
import {
  CONTRACT_PACK_ID,
  contractPackFiles,
  itemsOf,
  zipBuffer,
} from '../helpers/awpet';
import { fakeClock } from '../helpers/fake-clock';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

const BUILT_IN: ScreenDisplay = {
  id: 1,
  label: 'Built-in Retina Display',
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
};
const EXTERNAL: ScreenDisplay = {
  id: 69733632,
  label: 'DELL U2720Q',
  bounds: { x: 1512, y: 0, width: 2560, height: 1440 },
  scaleFactor: 1.5,
};
const ONE = `${CONTRACT_PACK_ID}/probe-one`;
const TWO = `${CONTRACT_PACK_ID}/probe-two`;

let dir: string;

beforeEach(() => {
  fake.resetFakeElectron();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-patch-batch-'));
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The contract pack as a .awpet in the temp folder. */
async function contractAwpet(): Promise<string> {
  const awpet = path.join(dir, 'contract.awpet');
  fs.writeFileSync(awpet, await zipBuffer(itemsOf(contractPackFiles())));
  return awpet;
}

/** Installs the contract pack into `packs` before StageView exists. */
async function installContractPack(packs: PacksStore): Promise<void> {
  const awpet = await contractAwpet();
  const inspection = await inspectPack(awpet, packs);
  if (!inspection.ok) {
    throw new Error(JSON.stringify(inspection.rejection));
  }
  expect(installPack(packs, inspection.plan).ok).toBe(true);
}

/**
 * Main as main.ts wires it, once ready, with the contract pack installed
 * (unless `installed` is false).
 */
async function startMain({ installed = true }: { installed?: boolean } = {}) {
  const clock = fakeClock();
  let codex: AdapterContext | undefined;
  const settings = loadSettings({ file: path.join(dir, 'settings.json') });
  const windows = createWindowsStageSource();
  const detection = createDetection({
    settings,
    monotonic: clock.monotonic,
    wall: clock.wall,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    adapters: [
      {
        source: 'codex',
        start(context: AdapterContext) {
          codex = context;
        },
        stop() {},
      },
    ],
  });
  const pool = loadPool({ file: path.join(dir, 'assignments.json') });
  const packs = loadPacks({ dir: path.join(dir, 'packs') });
  if (installed) {
    await installContractPack(packs);
  }
  let made = 0;
  const assigner = createAssigner({
    detection,
    store: pool,
    settings,
    packs,
    token: () => {
      made += 1;
      return `actor-${made}`;
    },
  });
  detection.onSynced((reported, unconfirmed) => {
    assigner.sync(reported, unconfirmed);
  });
  const characters = createCharacters({
    settings,
    packs,
    readManifest: (packId, version) =>
      readInstalledManifest(packs.dir, packId, version),
  });
  // As main.ts: the importer's install runs in a StageView batch, the hub
  // reached when an install comes.
  const importer = createPackImporter({
    store: packs,
    inspect: inspectPack,
    install: (store, plan) => hub.batch(() => installPack(store, plan)),
    chooseFile: async () => null,
  });
  const hub = createStageView({
    settings,
    windows,
    assigner,
    packs,
    packImport: importer,
    packExport: {
      get: () => ({ packExport: { phase: 'idle' } }),
      onChange: () => () => {},
    },
    characters,
  });
  characters.watch();
  assigner.watchPool();
  registerSettingsHandlers(settings, hub);
  registerPackHandlers(importer, { start: async () => {} }, (packId) =>
    hub.batch(() => removePack(packs, packId)),
  );
  // As main.ts: each sandbox failure the overlay reports runs in a batch.
  const runtimeFailures = createRuntimeFailures(packs);
  registerPackSandboxHandlers(
    async () => ({ ok: false, code: 'not-installed' }),
    () => {},
    () => ({ ok: false, code: 'not-installed' }),
    (failure) => hub.batch(() => runtimeFailures.report(failure)),
  );

  // Once ready: the canvas follows the displays and settings.
  const placed: CanvasPlacement[] = [];
  const screenListeners = new Map<ScreenEvent, () => void>();
  watchDisplays({
    screen: {
      getAllDisplays: () => [BUILT_IN, EXTERNAL],
      getPrimaryDisplay: () => ({ id: BUILT_IN.id }),
      on(event: ScreenEvent, listener: () => void) {
        screenListeners.set(event, listener);
      },
    },
    settings,
    source: windows,
    canvas: {
      place(placement) {
        placed.push(placement);
      },
    },
  });

  const subscriber = fake.createFakeWebContents(
    9,
    'app://overlay/index.html',
    false,
  );
  hub.subscribe(subscriber);
  const deltas = () =>
    subscriber.sent.map(({ args }) => args[0] as StageViewDelta);

  function emit(...events: DetectionEvent[]): void {
    if (codex === undefined) {
      throw new Error('codex did not start');
    }
    codex.emit(events);
  }
  function event(type: DetectionEvent['type']): DetectionEvent {
    return detectionEventSchema.parse({
      type,
      source: 'codex',
      sessionKey: 'codex:s1',
      ts: clock.wall(),
      via: 'log',
      confidence: confidenceFor('log'),
    });
  }
  /** codex's sync.ready: start-up sync is over. */
  function ready(): void {
    codex?.emit([{ type: 'sync.ready', source: 'codex' }], 'ok');
  }

  /** `ops` through the panels' settings:patch, at the current rev. */
  async function patch(...ops: SettingsOp[]) {
    return fake.ipcRenderer.invoke(settingsPatch.channel, {
      baseRev: settings.get().rev,
      ops,
    });
  }

  /**
   * The contract pack's sandbox failing, through the overlay's
   * packs:runtime-failed, at the version installed.
   */
  async function runtimeFailed(reason: PackRuntimeFailure['reason']) {
    const panelsUrl = fake.sender.mainFrame.url;
    fake.sender.mainFrame.url = 'app://overlay/index.html';
    try {
      return await fake.ipcRenderer.invoke(packsRuntimeFailed.channel, {
        packId: CONTRACT_PACK_ID,
        version: packs.find(CONTRACT_PACK_ID)?.version,
        reason,
      });
    } finally {
      fake.sender.mainFrame.url = panelsUrl;
    }
  }

  return {
    clock,
    settings,
    importer,
    hub,
    placed,
    deltas,
    emit,
    event,
    ready,
    patch,
    runtimeFailed,
  };
}

/** The section names each delta carried, sorted. */
function sectionsOf(deltas: readonly StageViewDelta[]): string[][] {
  return deltas.map((delta) => Object.keys(delta.sections).sort());
}

describe('I/O matrix', () => {
  it('合併：螢幕: a patch that moves the canvas to another display is exactly one delta, settings and canvas together, rev + 1', async () => {
    const { hub, placed, deltas, patch } = await startMain();
    const rev = hub.snapshot().rev;
    expect(hub.snapshot().view.canvas?.displayId).toBe(BUILT_IN.id);

    const reply = await patch({
      op: 'set',
      field: 'canvasDisplayId',
      value: EXTERNAL.id,
    });

    expect(reply).toMatchObject({ ok: true, data: { rev: 1 } });
    expect(sectionsOf(deltas())).toStrictEqual([['canvas', 'settings']]);
    const [delta] = deltas();
    expect(delta?.rev).toBe(rev + 1);
    expect(delta?.sections.settings?.values.canvasDisplayId).toBe(EXTERNAL.id);
    expect(delta?.sections.canvas).toStrictEqual({
      displayId: EXTERNAL.id,
      bounds: EXTERNAL.bounds,
      scaleFactor: EXTERNAL.scaleFactor,
      fallback: false,
    });
    expect(stageViewDeltaSchema.safeParse(delta).success).toBe(true);
    expect(hub.snapshot().rev).toBe(rev + 1);
    expect(placed.at(-1)?.displayId).toBe(EXTERNAL.id);
  });

  it('合併：計時: a patch of a timing that detection re-evaluates at once: sessions and actors come in the same delta as settings', async () => {
    const { clock, hub, deltas, emit, event, ready, patch } = await startMain();
    ready();
    emit(event('turn.start'));
    emit(event('turn.end'));
    clock.advance(3000);
    expect(hub.snapshot().view.actors).toStrictEqual([
      expect.objectContaining({ sessionKey: 'codex:s1', state: 'done' }),
    ]);
    const before = deltas().length;
    const rev = hub.snapshot().rev;

    await patch({ op: 'set', field: 'doneMs', value: 2000 });

    const after = deltas().slice(before);
    expect(sectionsOf(after)).toStrictEqual([
      ['actors', 'sessions', 'settings'],
    ]);
    expect(after[0]?.rev).toBe(rev + 1);
    expect(after[0]?.sections.sessions).toStrictEqual([
      expect.objectContaining({ sessionKey: 'codex:s1', state: 'waiting' }),
    ]);
    expect(after[0]?.sections.actors).toStrictEqual([
      expect.objectContaining({ sessionKey: 'codex:s1', state: 'waiting' }),
    ]);
  });

  it('合併：換角色: a patch that takes a shown session’s character out of the pool gives the session another one, with a new actor id: settings and actors in the same delta', async () => {
    const { hub, deltas, emit, event, ready, patch } = await startMain();
    ready();
    emit(event('turn.start'));
    const [first] = hub.snapshot().view.actors;
    expect(first).toMatchObject({ sessionKey: 'codex:s1', characterKey: ONE });
    const before = deltas().length;
    const rev = hub.snapshot().rev;

    await patch({
      op: 'setFixed',
      characterKey: ONE,
      param: 'inPool',
      value: false,
    });

    const after = deltas().slice(before);
    // 加入池子 is a fixed parameter: the character's values change too.
    expect(sectionsOf(after)).toStrictEqual([
      ['actors', 'characters', 'settings'],
    ]);
    expect(after[0]?.rev).toBe(rev + 1);
    const [swapped] = hub.snapshot().view.actors;
    expect(swapped).toMatchObject({
      sessionKey: 'codex:s1',
      characterKey: TWO,
    });
    expect(swapped?.actorId).not.toBe(first?.actorId);
  });

  it('合併：收回: a patch that takes the only pack off the stage takes the shown session’s actor back: settings and actors in the same delta', async () => {
    const { hub, deltas, emit, event, ready, patch } = await startMain();
    ready();
    emit(event('turn.start'));
    expect(hub.snapshot().view.actors).toHaveLength(1);
    const before = deltas().length;
    const rev = hub.snapshot().rev;

    await patch({
      op: 'setPackEnabled',
      packId: CONTRACT_PACK_ID,
      value: false,
    });

    const after = deltas().slice(before);
    expect(sectionsOf(after)).toStrictEqual([['actors', 'settings']]);
    expect(after[0]?.rev).toBe(rev + 1);
    expect(hub.snapshot().view.actors).toStrictEqual([]);
    expect(hub.snapshot().view.sessions).toHaveLength(1);
  });

  it('合併：池子: a patch that puts a pack back 上場 and gives a shown session its actor: settings and actors in the same delta', async () => {
    const { hub, deltas, emit, event, ready, patch } = await startMain();
    await patch({
      op: 'setPackEnabled',
      packId: CONTRACT_PACK_ID,
      value: false,
    });
    ready();
    emit(event('turn.start'));
    expect(hub.snapshot().view.sessions).toHaveLength(1);
    expect(hub.snapshot().view.actors).toStrictEqual([]);
    const before = deltas().length;
    const rev = hub.snapshot().rev;

    await patch({
      op: 'setPackEnabled',
      packId: CONTRACT_PACK_ID,
      value: true,
    });

    const after = deltas().slice(before);
    expect(sectionsOf(after)).toStrictEqual([['actors', 'settings']]);
    expect(after[0]?.rev).toBe(rev + 1);
    expect(hub.snapshot().view.actors).toStrictEqual([
      expect.objectContaining({ sessionKey: 'codex:s1', characterKey: ONE }),
    ]);
  });

  it('加入池子覆蓋: a patch turning one character’s 加入池子 off: settings and that character’s inPool in the same delta', async () => {
    const { hub, deltas, patch } = await startMain();
    expect(hub.snapshot().view.characters[TWO]?.fixed.inPool).toBe(true);

    await patch({
      op: 'setFixed',
      characterKey: TWO,
      param: 'inPool',
      value: false,
    });

    expect(sectionsOf(deltas())).toStrictEqual([['characters', 'settings']]);
    const characters = hub.snapshot().view.characters;
    expect(characters[TWO]?.fixed).toStrictEqual({
      scale: 0.9,
      inPool: false,
      badges: true,
      wander: {
        enabled: true,
        areas: [6, 7, 8],
        activity: 'medium',
        speed: 'slow',
      },
    });
    expect(characters[ONE]?.fixed.inPool).toBe(true);
  });

  it('沒有變化: a patch that changes no value sends no delta', async () => {
    const { hub, deltas, patch } = await startMain();
    const rev = hub.snapshot().rev;

    const reply = await patch(
      { op: 'set', field: 'canvasDisplayId', value: null },
      { op: 'setPackEnabled', packId: CONTRACT_PACK_ID, value: true },
    );

    expect(reply).toMatchObject({ ok: true, data: { rev: 0 } });
    expect(deltas()).toStrictEqual([]);
    expect(hub.snapshot().rev).toBe(rev);
  });
});

describe('a refused patch', () => {
  it('sends no delta: an invalid one never reaches the store, and the batch it would run in sends nothing', async () => {
    const { hub, deltas } = await startMain();
    const rev = hub.snapshot().rev;

    const reply = await fake.ipcRenderer.invoke(settingsPatch.channel, {
      baseRev: 0,
      ops: [{ op: 'set', field: 'canvasDisplayId', value: -1 }],
    });

    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(deltas()).toStrictEqual([]);
    expect(hub.snapshot().rev).toBe(rev);
  });
});

describe('a pack installed or removed in one StageView batch, as main.ts wires the importer and packs:remove', () => {
  it('an install through the importer, with a shown session waiting for a character: one delta carries packs, characters and actors', async () => {
    const { importer, hub, deltas, emit, event, ready } = await startMain({
      installed: false,
    });
    ready();
    emit(event('turn.start'));
    expect(hub.snapshot().view.actors).toStrictEqual([]);
    const before = deltas().length;

    await importer.start(await contractAwpet());

    const after = deltas().slice(before);
    const carrying = after.filter(
      (delta) =>
        delta.sections.packs !== undefined ||
        delta.sections.characters !== undefined ||
        delta.sections.actors !== undefined,
    );
    expect(sectionsOf(carrying)).toStrictEqual([
      ['actors', 'characters', 'packs'],
    ]);
    expect(Object.keys(hub.snapshot().view.characters)).toStrictEqual([
      ONE,
      TWO,
    ]);
    expect(hub.snapshot().view.actors).toStrictEqual([
      expect.objectContaining({ sessionKey: 'codex:s1', characterKey: ONE }),
    ]);
    expect(hub.snapshot().view.packImport).toMatchObject({
      phase: 'result',
      outcome: 'installed',
    });
    for (const delta of after) {
      expect(stageViewDeltaSchema.safeParse(delta).success).toBe(true);
    }
  });

  it('a removal through packs:remove: one delta carries packs, characters and actors (換角色: the pool is empty, the actor is taken back)', async () => {
    const { hub, deltas, emit, event, ready } = await startMain();
    ready();
    emit(event('turn.start'));
    expect(hub.snapshot().view.actors).toHaveLength(1);
    const before = deltas().length;
    const rev = hub.snapshot().rev;

    const reply = await fake.ipcRenderer.invoke(
      packsRemove.channel,
      CONTRACT_PACK_ID,
    );

    expect(reply).toStrictEqual({ ok: true, data: { ok: true } });
    const after = deltas().slice(before);
    expect(sectionsOf(after)).toStrictEqual([
      ['actors', 'characters', 'packs'],
    ]);
    expect(after[0]?.rev).toBe(rev + 1);
    expect(hub.snapshot().view.characters).toStrictEqual({});
    expect(hub.snapshot().view.packs.installed).toStrictEqual([]);
    expect(hub.snapshot().view.actors).toStrictEqual([]);
    expect(hub.snapshot().view.sessions).toHaveLength(1);
  });
});

// Story 3.9: packs:runtime-failed in a StageView batch, as main.ts wires it.
describe('I/O matrix', () => {
  it('第 4 次 / 池子只剩它: the failures within the restarts send no delta; the 4th, of the only pack, is one delta carrying packs (with the mark) and actors (the actor taken back, the session still listed)', async () => {
    const { hub, deltas, emit, event, ready, runtimeFailed } =
      await startMain();
    ready();
    emit(event('turn.start'));
    expect(hub.snapshot().view.actors).toHaveLength(1);
    const before = deltas().length;
    const rev = hub.snapshot().rev;

    for (let n = 0; n < PACK_RESTART_LIMIT; n += 1) {
      expect(await runtimeFailed('heartbeat-timeout')).toStrictEqual({
        ok: true,
        data: { restart: true },
      });
    }
    expect(deltas()).toHaveLength(before);

    expect(await runtimeFailed('draw-timeout')).toStrictEqual({
      ok: true,
      data: { restart: false },
    });

    const after = deltas().slice(before);
    expect(sectionsOf(after)).toStrictEqual([['actors', 'packs']]);
    expect(after[0]?.rev).toBe(rev + 1);
    expect(stageViewDeltaSchema.safeParse(after[0]).success).toBe(true);
    expect(after[0]?.sections.packs?.installed).toStrictEqual([
      expect.objectContaining({
        id: CONTRACT_PACK_ID,
        runtimeFailed: 'draw-timeout',
      }),
    ]);
    expect(hub.snapshot().view.actors).toStrictEqual([]);
    expect(hub.snapshot().view.sessions).toHaveLength(1);
  });

  it('同版本重新匯入: importing the marked pack again at the same version clears the mark in one delta with the actor it gives back; it restarts from 0', async () => {
    const { importer, hub, deltas, emit, event, ready, runtimeFailed } =
      await startMain();
    ready();
    emit(event('turn.start'));
    const [first] = hub.snapshot().view.actors;
    for (let n = 0; n <= PACK_RESTART_LIMIT; n += 1) {
      await runtimeFailed('worker-error');
    }
    expect(hub.snapshot().view.packs.installed[0]?.runtimeFailed).toBe(
      'worker-error',
    );
    expect(hub.snapshot().view.actors).toStrictEqual([]);
    const before = deltas().length;

    await importer.start(await contractAwpet());
    expect(hub.snapshot().view.packImport).toMatchObject({ phase: 'confirm' });
    importer.confirm(true);
    vi.advanceTimersByTime(0);

    const carrying = deltas()
      .slice(before)
      .filter(
        (delta) =>
          delta.sections.packs !== undefined ||
          delta.sections.characters !== undefined ||
          delta.sections.actors !== undefined,
      );
    expect(sectionsOf(carrying)).toStrictEqual([['actors', 'packs']]);
    const [pack] = hub.snapshot().view.packs.installed;
    expect(pack).toBeDefined();
    expect(pack).not.toHaveProperty('runtimeFailed');
    const [back] = hub.snapshot().view.actors;
    // The usual pick: ONE appeared once this run already, TWO not yet.
    expect(back).toMatchObject({ sessionKey: 'codex:s1', characterKey: TWO });
    expect(back?.actorId).not.toBe(first?.actorId);
    expect(await runtimeFailed('worker-error')).toStrictEqual({
      ok: true,
      data: { restart: true },
    });
  });
});
