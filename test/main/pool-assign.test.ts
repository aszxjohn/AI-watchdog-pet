/**
 * main/pool's assigner (Story 3.4): the pool, picking a character, and the
 * assigner wired as main.ts wires it: main/detection on a fake clock,
 * main/pool's store on a real assignments.json in a temp folder, and fake
 * settings and packs. Actor ids come from an injected counter.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext } from '../../src/main/detection/adapter';
import { createDetection } from '../../src/main/detection/detection';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import { loadPacks, type PacksStore } from '../../src/main/packs/store';
import {
  actorsOf,
  createAssigner,
  pickCharacter,
  poolOf,
  type Assignment,
} from '../../src/main/pool/assign';
import { demoCharactersOf } from '../../src/main/pool/demo-mode';
import { loadPool } from '../../src/main/pool/store';
import { loadSettings } from '../../src/main/settings/store';
import { createStageView } from '../../src/main/stage-view/stage-view';
import { createWindowsStageSource } from '../../src/main/windows/stage-sources';
import { POOL_FLUSH_DEBOUNCE_MS } from '../../src/shared/constants';
import {
  confidenceFor,
  detectionEventSchema,
  type DetectionEvent,
  type SessionKey,
  splitSessionKey,
} from '../../src/shared/detection-events';
import type { CharacterKey, StagePack } from '../../src/shared/packs';
import { poolFileSchema, type PoolAssignment } from '../../src/shared/pool';
import {
  SETTINGS_DEFAULTS,
  type SettingsState,
  type SettingsValues,
} from '../../src/shared/settings';
import type { SourceCode } from '../../src/shared/sources';
import {
  stageViewDeltaSchema,
  stageViewSectionsSchema,
  type StageSession,
  type StageViewAssignerSections,
  type StageViewDelta,
  type StageViewPacksSections,
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

const SAMPLE: StagePack = {
  id: 'sample-pack',
  name: '範例包',
  version: '1.0.0',
  apiVersion: '1.0',
  compatibility: { compatible: true },
  characters: [
    { id: 'probe-one', name: '探針一', height: 110 },
    { id: 'probe-two', name: '探針二', height: 96 },
  ],
};
const ANOTHER: StagePack = {
  id: 'another-pack',
  name: '另一包',
  version: '2.0.0',
  apiVersion: '1.0',
  compatibility: { compatible: true },
  characters: [{ id: 'probe-three', name: '探針三', height: 110 }],
};
const ONE: CharacterKey = 'sample-pack/probe-one';
const TWO: CharacterKey = 'sample-pack/probe-two';
const THREE: CharacterKey = 'another-pack/probe-three';

/** Settings values with only 上場 and 加入池子 set. */
function values(
  changed: Partial<Pick<SettingsValues, 'packEnabled' | 'fixedOverrides'>> = {},
): Pick<SettingsValues, 'packEnabled' | 'fixedOverrides'> {
  return { packEnabled: {}, fixedOverrides: {}, ...changed };
}

describe('poolOf', () => {
  it('is each 上場 pack by id × each of its characters in manifest order', () => {
    expect(poolOf([SAMPLE, ANOTHER], values())).toStrictEqual([
      THREE,
      ONE,
      TWO,
    ]);
  });

  it('leaves out a pack that is not 上場 and a character that does not join the pool', () => {
    expect(
      poolOf(
        [SAMPLE, ANOTHER],
        values({
          packEnabled: { 'another-pack': false },
          fixedOverrides: { [ONE]: { inPool: false } },
        }),
      ),
    ).toStrictEqual([TWO]);
  });

  it('is empty with no pack installed, or none 上場', () => {
    expect(poolOf([], values())).toStrictEqual([]);
    expect(
      poolOf([SAMPLE], values({ packEnabled: { 'sample-pack': false } })),
    ).toStrictEqual([]);
  });

  it('leaves the installed list as it was', () => {
    const installed = Object.freeze([SAMPLE, ANOTHER]);
    poolOf(installed, values());
    expect(installed.map((pack) => pack.id)).toStrictEqual([
      'sample-pack',
      'another-pack',
    ]);
  });
});

describe('pickCharacter', () => {
  const POOL = [THREE, ONE, TWO];

  it('takes the first in pool order when none has appeared', () => {
    expect(pickCharacter(POOL, new Set(), new Map())).toBe(THREE);
  });

  it('takes one that is not on stage, the fewest appearances first', () => {
    expect(
      pickCharacter(
        POOL,
        new Set([THREE]),
        new Map([
          [THREE, 1],
          [ONE, 2],
          [TWO, 1],
        ]),
      ),
    ).toBe(TWO);
  });

  it('takes one that is not on stage even when it has appeared more than those on stage', () => {
    expect(
      pickCharacter(
        POOL,
        new Set([THREE, ONE]),
        new Map([
          [THREE, 1],
          [ONE, 1],
          [TWO, 5],
        ]),
      ),
    ).toBe(TWO);
  });

  it('takes from the whole pool once every one is on stage: the fewest appearances, then pool order', () => {
    const onStage = new Set(POOL);
    expect(
      pickCharacter(
        POOL,
        onStage,
        new Map([
          [THREE, 2],
          [ONE, 1],
          [TWO, 1],
        ]),
      ),
    ).toBe(ONE);
  });

  it('is null for an empty pool', () => {
    expect(pickCharacter([], new Set(), new Map())).toBeNull();
  });
});

describe('actorsOf', () => {
  const SESSIONS: StageSession[] = [
    {
      sessionKey: 'codex:b',
      source: 'codex',
      displayName: 'b',
      state: 'working',
      confidence: 'exact',
    },
    {
      sessionKey: 'demo:1',
      source: 'demo',
      displayName: null,
      state: 'approval',
      confidence: 'inferred',
    },
    {
      sessionKey: 'codex:a',
      source: 'codex',
      displayName: null,
      state: 'idle',
      confidence: 'exact',
    },
  ];

  it('is one actor per session with an assignment, in the order of the sessions, with its state, confidence and display name', () => {
    const assignments = new Map<SessionKey, Assignment>([
      ['codex:a', { actorId: 'x1', characterKey: ONE }],
      ['demo:1', { actorId: 'x2', characterKey: ONE }],
      ['codex:gone', { actorId: 'x3', characterKey: TWO }],
    ]);

    expect(actorsOf(SESSIONS, assignments)).toStrictEqual([
      {
        actorId: 'x2',
        sessionKey: 'demo:1',
        characterKey: ONE,
        state: 'approval',
        confidence: 'inferred',
        displayName: null,
      },
      {
        actorId: 'x1',
        sessionKey: 'codex:a',
        characterKey: ONE,
        state: 'idle',
        confidence: 'exact',
        displayName: null,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Wired as main.ts wires it.

/** Local time, so the backup suffix is the same in every time zone. */
const NOW = new Date(2026, 10, 16, 9, 30, 5).getTime();
const MINUTE = 60_000;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-assign-'));
  file = path.join(dir, 'assignments.json');
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

/** Every `[pool]` console line logged so far, all levels. */
function poolLines(): string[] {
  return (['info', 'warn', 'error'] as const)
    .flatMap((level) =>
      vi
        .mocked(console[level])
        .mock.calls.map((call: unknown[]) => String(call[0])),
    )
    .filter((line) => line.startsWith('[pool] '));
}

/** main/settings with only what the assigner and detection read. */
function fakeSettings(
  initial: Partial<Pick<SettingsValues, 'packEnabled' | 'fixedOverrides'>>,
) {
  let state: SettingsState = {
    rev: 0,
    values: { ...SETTINGS_DEFAULTS, ...initial },
  };
  const listeners = new Set<(next: SettingsState) => void>();
  return {
    get: () => state,
    onChange(listener: (next: SettingsState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(
      changed: Partial<Pick<SettingsValues, 'packEnabled' | 'fixedOverrides'>>,
    ) {
      state = { rev: state.rev + 1, values: { ...state.values, ...changed } };
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

/** main/packs' store: the installed packs, sorted by id. */
function fakePacks(initial: readonly StagePack[]) {
  const sorted = (list: readonly StagePack[]) =>
    [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let sections: StageViewPacksSections = {
    packs: { installed: sorted(initial) },
  };
  const listeners = new Set<(next: StageViewPacksSections) => void>();
  return {
    get: () => sections,
    onChange(listener: (next: StageViewPacksSections) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(installed: readonly StagePack[]) {
      sections = { packs: { installed: sorted(installed) } };
      for (const listener of listeners) {
        listener(sections);
      }
    },
  };
}

function event(
  sessionKey: SessionKey,
  type: DetectionEvent['type'],
  ts: number,
  extra: Record<string, unknown> = {},
): DetectionEvent {
  return detectionEventSchema.parse({
    type,
    source: splitSessionKey(sessionKey).source,
    sessionKey,
    ts,
    via: 'log',
    confidence: confidenceFor('log'),
    ...extra,
  });
}

interface WireOptions {
  /** assignments.json before start; none when omitted. */
  readonly saved?: unknown;
  /** The source adapters (default: codex only). */
  readonly sources?: readonly SourceCode[];
  readonly installed?: readonly StagePack[];
  readonly settings?: Partial<
    Pick<SettingsValues, 'packEnabled' | 'fixedOverrides'>
  >;
}

/**
 * The assigner as main.ts wires it. `heard` records each change it tells
 * (each one becomes one StageView delta); `cast()` reads the actors as
 * [session key, character, actor id].
 */
function wire({
  saved,
  sources = ['codex'],
  installed = [SAMPLE],
  settings: initial = {},
}: WireOptions = {}) {
  if (saved !== undefined) {
    fs.writeFileSync(file, JSON.stringify(saved));
  }
  const clock = fakeClock();
  const contexts = new Map<SourceCode, AdapterContext>();
  const settings = fakeSettings(initial);
  const detection = createDetection({
    settings,
    monotonic: clock.monotonic,
    wall: clock.wall,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    adapters: sources.map((source) => ({
      source,
      start(given: AdapterContext) {
        contexts.set(source, given);
      },
      stop() {},
    })),
  });
  const store = loadPool({ file, now: () => NOW });
  const packs = fakePacks(installed);
  let made = 0;
  const assigner = createAssigner({
    detection,
    store,
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
  // main.ts calls it right after createStageView; there is none here.
  assigner.watchPool();
  const heard: Partial<StageViewAssignerSections>[] = [];
  assigner.onChange((changed) => {
    heard.push(changed);
  });

  const ctx = (source: SourceCode = 'codex'): AdapterContext => {
    const context = contexts.get(source);
    if (context === undefined) {
      throw new Error(`${source} did not start`);
    }
    return context;
  };
  /** The source's `sync.ready` (codex unless named). */
  const ready = (source: SourceCode = 'codex') => {
    ctx(source).emit([{ type: 'sync.ready', source }], 'ok');
  };
  /** A live session.start of `sessionKey` (any source but demo). */
  const start = (sessionKey: SessionKey) => {
    ctx(splitSessionKey(sessionKey).source).emit([
      event(sessionKey, 'session.start', clock.wall()),
    ]);
  };
  const end = (sessionKey: SessionKey) => {
    ctx(splitSessionKey(sessionKey).source).emit([
      event(sessionKey, 'session.end', clock.wall()),
    ]);
  };
  /** A session.start replayed from a minute before start. */
  const replay = (sessionKey: SessionKey) => {
    ctx(splitSessionKey(sessionKey).source).emit([
      event(sessionKey, 'session.start', clock.wall() - MINUTE, {
        replay: true,
      }),
    ]);
  };
  /** Events of one source, as one read of its adapter. */
  const emit = (...events: DetectionEvent[]) => {
    const [first] = events;
    if (first !== undefined) {
      ctx(first.source).emit(events);
    }
  };
  const cast = () =>
    assigner
      .get()
      .actors.map((actor) => [
        actor.sessionKey,
        actor.characterKey,
        actor.actorId,
      ]);
  const sessionKeys = () =>
    assigner.get().sessions.map((session) => session.sessionKey);
  const savedAssignments = (): readonly PoolAssignment[] => store.assignments();
  return {
    clock,
    detection,
    store,
    settings,
    packs,
    assigner,
    heard,
    ready,
    start,
    end,
    replay,
    emit,
    ctx,
    cast,
    sessionKeys,
    savedAssignments,
  };
}

/** Every change heard passes StageView's delta check (no empty one). */
function expectValidChanges(
  heard: readonly Partial<StageViewAssignerSections>[],
): void {
  for (const changed of heard) {
    const checked = stageViewSectionsSchema.safeParse(changed);
    expect(checked.success, JSON.stringify(checked.error?.issues)).toBe(true);
  }
}

describe('I/O matrix', () => {
  it('不相容: leaves out a 上場 pack whose apiVersion does not fit this stage, whatever its 加入池子', () => {
    const newer: StagePack = {
      ...ANOTHER,
      apiVersion: '1.9',
      compatibility: {
        compatible: false,
        reason: 'pack-newer',
        required: '1.9',
      },
    };

    expect(poolOf([SAMPLE, newer], values())).toStrictEqual([ONE, TWO]);
    expect(
      poolOf(
        [newer],
        values({
          packEnabled: { 'another-pack': true },
          fixedOverrides: { [THREE]: { inPool: true } },
        }),
      ),
    ).toStrictEqual([]);
  });

  it('第 4 次: leaves out a pack marked failed this run (runtimeFailed), 上場 and 加入池子 set or not', () => {
    const failed: StagePack = { ...ANOTHER, runtimeFailed: 'draw-timeout' };

    expect(poolOf([SAMPLE, ANOTHER], values())).toStrictEqual([
      THREE,
      ONE,
      TWO,
    ]);
    expect(poolOf([SAMPLE, failed], values())).toStrictEqual([ONE, TWO]);
    expect(
      poolOf(
        [failed],
        values({
          packEnabled: { 'another-pack': true },
          fixedOverrides: { [THREE]: { inPool: true } },
        }),
      ),
    ).toStrictEqual([]);
  });

  it('新 session: synced, the pool has characters, a new session: it gets a character and a new actorId; its actor and its first state come in one change', () => {
    const { heard, ready, start, cast, detection } = wire();
    ready();
    heard.length = 0;

    start('codex:a');

    expect(cast()).toStrictEqual([['codex:a', ONE, 'actor-1']]);
    expect(heard).toHaveLength(1);
    const [changed] = heard;
    expect(Object.keys(changed ?? {}).sort()).toStrictEqual([
      'actors',
      'sessions',
    ]);
    const [session] = detection.get().sessions;
    expect(changed?.sessions).toStrictEqual([session]);
    expect(changed?.actors).toStrictEqual([
      {
        actorId: 'actor-1',
        sessionKey: 'codex:a',
        characterKey: ONE,
        state: session?.state,
        confidence: session?.confidence,
        displayName: session?.displayName,
      },
    ]);
    expectValidChanges(heard);
  });

  it('不重複: as many sessions as the pool has characters: each a different one, in pool order', () => {
    const { ready, start, cast } = wire({ installed: [SAMPLE, ANOTHER] });
    ready();

    start('codex:a');
    start('codex:b');
    start('codex:c');

    expect(cast()).toStrictEqual([
      ['codex:a', THREE, 'actor-1'],
      ['codex:b', ONE, 'actor-2'],
      ['codex:c', TWO, 'actor-3'],
    ]);
  });

  it('用完重複: more sessions than characters: the extra ones take the fewest appearances this run, pool order among equals', () => {
    const { ready, start, cast } = wire();
    ready();

    start('codex:a');
    start('codex:b');
    start('codex:c');
    start('codex:d');

    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-1'],
      ['codex:b', TWO, 'actor-2'],
      // Both on stage, both once: pool order.
      ['codex:c', ONE, 'actor-3'],
      // Both on stage, ONE twice: TWO.
      ['codex:d', TWO, 'actor-4'],
    ]);
  });

  it('輪替: after a session with a character ends, a new one takes a character that is not on stage, the fewest appearances first', () => {
    const { ready, start, end, cast } = wire({ installed: [SAMPLE, ANOTHER] });
    ready();
    start('codex:a');
    start('codex:b');
    expect(cast()).toStrictEqual([
      ['codex:a', THREE, 'actor-1'],
      ['codex:b', ONE, 'actor-2'],
    ]);

    end('codex:a');
    start('codex:c');

    // Off stage: THREE (once) and TWO (never): TWO.
    expect(cast()).toStrictEqual([
      ['codex:b', ONE, 'actor-2'],
      ['codex:c', TWO, 'actor-3'],
    ]);

    end('codex:b');
    start('codex:d');

    // Off stage: THREE and ONE, once each: pool order.
    expect(cast()).toStrictEqual([
      ['codex:c', TWO, 'actor-3'],
      ['codex:d', THREE, 'actor-4'],
    ]);
  });

  it('結束: a session that ends takes its assignment and actor with it, in the change that removes the session; its character goes back to the pool', () => {
    const { heard, ready, start, end, cast, savedAssignments, sessionKeys } =
      wire();
    ready();
    start('codex:a');
    start('codex:b');
    heard.length = 0;

    end('codex:a');

    expect(sessionKeys()).toStrictEqual(['codex:b']);
    expect(cast()).toStrictEqual([['codex:b', TWO, 'actor-2']]);
    expect(heard).toHaveLength(1);
    expect(Object.keys(heard[0] ?? {}).sort()).toStrictEqual([
      'actors',
      'sessions',
    ]);
    expect(savedAssignments().map((a) => a.sessionKey)).toStrictEqual([
      'codex:b',
    ]);

    start('codex:c');

    expect(cast()).toContainEqual(['codex:c', ONE, 'actor-3']);
    expectValidChanges(heard);
  });

  it(`結束: a session that expires (sessionExpireMs, ${SETTINGS_DEFAULTS.sessionExpireMs} ms) loses its actor in the same change`, () => {
    const { clock, heard, ready, start, cast } = wire();
    ready();
    start('codex:a');
    heard.length = 0;

    clock.advance(SETTINGS_DEFAULTS.sessionExpireMs);

    expect(cast()).toStrictEqual([]);
    // It went idle first (one change, its actor's state too), then expired.
    const removal = heard.at(-1);
    expect(removal?.sessions).toStrictEqual([]);
    expect(removal?.actors).toStrictEqual([]);
  });

  it('釋放: releasing a session with a character takes its actor away; the session stays; pool and actors come in one change', () => {
    const { heard, ready, start, store, cast, sessionKeys, savedAssignments } =
      wire();
    ready();
    start('codex:a');
    start('codex:b');
    heard.length = 0;

    store.setReleased('codex:a', true);

    expect(sessionKeys()).toStrictEqual(['codex:a', 'codex:b']);
    expect(cast()).toStrictEqual([['codex:b', TWO, 'actor-2']]);
    expect(heard).toStrictEqual([
      {
        pool: { released: ['codex:a'], locked: [], lockOn: false },
        actors: [expect.objectContaining({ sessionKey: 'codex:b' })],
      },
    ]);
    expect(savedAssignments().map((a) => a.sessionKey)).toStrictEqual([
      'codex:b',
    ]);
    expectValidChanges(heard);
  });

  it('釋放: a released session that ends and comes back with the same key is still released: it gets no character', () => {
    const { ready, start, end, store, cast, sessionKeys } = wire();
    ready();
    start('codex:a');
    store.setReleased('codex:a', true);
    end('codex:a');

    start('codex:a');

    expect(sessionKeys()).toStrictEqual(['codex:a']);
    expect(cast()).toStrictEqual([]);
  });

  it('取消釋放: showing it again gives it a character and a new actorId', () => {
    const { heard, ready, start, store, cast } = wire();
    ready();
    start('codex:a');
    store.setReleased('codex:a', true);
    heard.length = 0;

    store.setReleased('codex:a', false);

    // Nothing on stage; ONE has appeared once, TWO never: TWO.
    expect(cast()).toStrictEqual([['codex:a', TWO, 'actor-2']]);
    expect(heard).toHaveLength(1);
    expect(Object.keys(heard[0] ?? {}).sort()).toStrictEqual([
      'actors',
      'pool',
    ]);
  });

  it('同步前: before every source synced, sessions are listed with no actor; at sync they all get theirs, in one change', () => {
    const { heard, detection, replay, ready, cast } = wire();
    detection.setDemo('approval');
    replay('codex:a');

    expect(cast()).toStrictEqual([]);
    expect(heard.every((changed) => changed.actors === undefined)).toBe(true);
    expect(heard.at(-1)?.sessions?.map((s) => s.sessionKey)).toStrictEqual([
      'demo:1',
    ]);
    heard.length = 0;

    ready();

    expect(cast()).toStrictEqual([
      ['demo:1', ONE, 'actor-1'],
      ['codex:a', TWO, 'actor-2'],
    ]);
    const withActors = heard.filter((changed) => changed.actors !== undefined);
    expect(withActors).toHaveLength(1);
    expect(withActors[0]?.actors).toHaveLength(2);
    expectValidChanges(heard);
  });

  it(`同步前: a source that never sends sync.ready: sessions get their characters once syncTimeoutMs (${SETTINGS_DEFAULTS.syncTimeoutMs} ms) has passed`, () => {
    const { clock, detection, cast } = wire();
    detection.setDemo('working');

    clock.advance(SETTINGS_DEFAULTS.syncTimeoutMs - 1);
    expect(cast()).toStrictEqual([]);
    clock.advance(1);

    expect(cast()).toStrictEqual([['demo:1', ONE, 'actor-1']]);
  });

  it.each<[string, WireOptions]>([
    ['no pack installed', { installed: [] }],
    [
      'no pack 上場',
      {
        installed: [SAMPLE, ANOTHER],
        settings: {
          packEnabled: { 'sample-pack': false, 'another-pack': false },
        },
      },
    ],
    [
      'no character joins the pool',
      {
        settings: {
          fixedOverrides: {
            [ONE]: { inPool: false },
            [TWO]: { inPool: false },
          },
        },
      },
    ],
  ])(
    '池子空: %s: the sessions are listed as usual, with no actor',
    (_label, options) => {
      const { heard, ready, start, cast, sessionKeys, savedAssignments } =
        wire(options);
      ready();

      start('codex:a');

      expect(sessionKeys()).toStrictEqual(['codex:a']);
      expect(cast()).toStrictEqual([]);
      expect(heard.every((changed) => changed.actors === undefined)).toBe(true);
      expect(savedAssignments()).toStrictEqual([]);
    },
  );

  it('池子變大: from empty: installing a pack gives each shown session without a character one, at once, in one change', () => {
    const { heard, packs, ready, start, store, cast } = wire({ installed: [] });
    ready();
    start('codex:a');
    start('codex:b');
    start('codex:c');
    store.setReleased('codex:c', true);
    heard.length = 0;

    packs.update([SAMPLE]);

    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-1'],
      ['codex:b', TWO, 'actor-2'],
    ]);
    expect(heard).toStrictEqual([{ actors: expect.any(Array) }]);
  });

  it('池子變大: a pack going 上場 again, or a character joining the pool, gives the sessions still without one theirs', () => {
    const { settings, ready, start, cast } = wire({
      settings: {
        packEnabled: { 'sample-pack': false },
        fixedOverrides: { [ONE]: { inPool: false } },
      },
    });
    ready();
    start('codex:a');
    start('codex:b');
    expect(cast()).toStrictEqual([]);

    settings.set({ packEnabled: {} });

    // Only TWO is in the pool: both get it.
    expect(cast()).toStrictEqual([
      ['codex:a', TWO, 'actor-1'],
      ['codex:b', TWO, 'actor-2'],
    ]);

    settings.set({ fixedOverrides: {} });

    // Everyone has a character already: nothing moves.
    expect(cast()).toStrictEqual([
      ['codex:a', TWO, 'actor-1'],
      ['codex:b', TWO, 'actor-2'],
    ]);
    start('codex:c');
    expect(cast()).toContainEqual(['codex:c', ONE, 'actor-3']);
  });

  it('換角色: a pack no longer 上場: its actor ends and the session gets a pool character off stage, with a new actor id and an appearance, in one change; 上場 again swaps no one back', () => {
    const { heard, settings, ready, start, cast, savedAssignments } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    start('codex:a');
    start('codex:b');
    expect(cast()).toStrictEqual([
      ['codex:a', THREE, 'actor-1'],
      ['codex:b', ONE, 'actor-2'],
    ]);
    heard.length = 0;

    settings.set({ packEnabled: { 'another-pack': false } });

    expect(cast()).toStrictEqual([
      ['codex:a', TWO, 'actor-3'],
      ['codex:b', ONE, 'actor-2'],
    ]);
    expect(heard).toStrictEqual([{ actors: expect.any(Array) }]);
    expect(savedAssignments()).toHaveLength(2);
    expect(savedAssignments()).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionKey: 'codex:a',
          characterKey: TWO,
          actorId: 'actor-3',
        }),
        expect.objectContaining({
          sessionKey: 'codex:b',
          characterKey: ONE,
          actorId: 'actor-2',
        }),
      ]),
    );
    expect(poolLines()).toContain(
      '[pool] assignments: 1 new, 0 kept from the last run, 1 ended (1 out of the pool), 0 dropped (2 actors, 2 characters in the pool)',
    );
    // TWO's swap counted: ONE and TWO both appeared once, ONE comes first.
    start('codex:c');
    expect(cast()).toContainEqual(['codex:c', ONE, 'actor-4']);
    heard.length = 0;

    settings.set({ packEnabled: {} });

    expect(cast()).toStrictEqual([
      ['codex:a', TWO, 'actor-3'],
      ['codex:b', ONE, 'actor-2'],
      ['codex:c', ONE, 'actor-4'],
    ]);
    expect(heard).toStrictEqual([]);
  });

  it('換角色: a character out of the pool, with no other pool character off stage: the session takes one on stage already', () => {
    const { settings, ready, start, cast } = wire();
    ready();
    start('codex:a');
    start('codex:b');
    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-1'],
      ['codex:b', TWO, 'actor-2'],
    ]);

    settings.set({ fixedOverrides: { [TWO]: { inPool: false } } });

    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-1'],
      ['codex:b', ONE, 'actor-3'],
    ]);
  });

  it('換角色: a pack removed and a new version without a character, in one update: every affected actor swaps in one change; the rest stay', () => {
    const { heard, packs, ready, start, cast } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    start('codex:a');
    start('codex:b');
    start('codex:c');
    expect(cast()).toStrictEqual([
      ['codex:a', THREE, 'actor-1'],
      ['codex:b', ONE, 'actor-2'],
      ['codex:c', TWO, 'actor-3'],
    ]);
    heard.length = 0;

    packs.update([
      { ...SAMPLE, version: '1.1.0', characters: SAMPLE.characters.slice(1) },
    ]);

    // Only TWO is left, on stage already: the whole pool, TWO.
    expect(cast()).toStrictEqual([
      ['codex:a', TWO, 'actor-4'],
      ['codex:b', TWO, 'actor-5'],
      ['codex:c', TWO, 'actor-3'],
    ]);
    expect(heard).toStrictEqual([{ actors: expect.any(Array) }]);
  });

  it('換角色: a pack that no longer fits this stage: its actors swap', () => {
    const { packs, ready, start, cast } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    start('codex:a');
    expect(cast()).toStrictEqual([['codex:a', THREE, 'actor-1']]);

    packs.update([
      SAMPLE,
      {
        ...ANOTHER,
        apiVersion: '1.9',
        compatibility: {
          compatible: false,
          reason: 'pack-newer',
          required: '1.9',
        },
      },
    ]);

    expect(cast()).toStrictEqual([['codex:a', ONE, 'actor-2']]);
  });

  it('池子空了: every actor is taken back, each session stays listed with none; the pool growing again gives them characters', () => {
    const { heard, packs, ready, start, cast, sessionKeys, savedAssignments } =
      wire();
    ready();
    start('codex:a');
    start('codex:b');
    expect(cast()).toHaveLength(2);
    heard.length = 0;

    packs.update([]);

    expect(cast()).toStrictEqual([]);
    expect(sessionKeys()).toStrictEqual(['codex:a', 'codex:b']);
    expect(heard).toStrictEqual([{ actors: [] }]);
    expect(savedAssignments()).toStrictEqual([]);
    start('codex:c');
    expect(cast()).toStrictEqual([]);

    packs.update([SAMPLE]);

    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-3'],
      ['codex:b', TWO, 'actor-4'],
      ['codex:c', ONE, 'actor-5'],
    ]);
  });

  it('第 4 次: a pack marked failed: its actors swap to the rest of the pool in one change, with new actor ids; the others stay; 上場 is not touched', () => {
    const { heard, packs, settings, ready, start, cast } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    start('codex:a');
    start('codex:b');
    expect(cast()).toStrictEqual([
      ['codex:a', THREE, 'actor-1'],
      ['codex:b', ONE, 'actor-2'],
    ]);
    heard.length = 0;

    packs.update([SAMPLE, { ...ANOTHER, runtimeFailed: 'heartbeat-timeout' }]);

    expect(cast()).toStrictEqual([
      ['codex:a', TWO, 'actor-3'],
      ['codex:b', ONE, 'actor-2'],
    ]);
    expect(heard).toStrictEqual([{ actors: expect.any(Array) }]);
    expect(settings.get().values.packEnabled).toStrictEqual({});
    expectValidChanges(heard);
  });

  it('池子只剩它 / 同版本重新匯入: the only pack marked failed takes every actor back, each session stays listed; the mark gone (imported again), they get characters again', () => {
    const { heard, packs, ready, start, cast, sessionKeys } = wire();
    ready();
    start('codex:a');
    start('codex:b');
    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-1'],
      ['codex:b', TWO, 'actor-2'],
    ]);
    heard.length = 0;

    packs.update([{ ...SAMPLE, runtimeFailed: 'draw-timeout' }]);

    expect(cast()).toStrictEqual([]);
    expect(sessionKeys()).toStrictEqual(['codex:a', 'codex:b']);
    expect(heard).toStrictEqual([{ actors: [] }]);

    packs.update([SAMPLE]);

    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-3'],
      ['codex:b', TWO, 'actor-4'],
    ]);
  });

  it('狀態變: a session with a character changes state or name: sessions and actors in one change', () => {
    const { clock, heard, ready, start, emit } = wire();
    ready();
    start('codex:a');
    heard.length = 0;

    emit(event('codex:a', 'turn.start', clock.wall()));

    expect(heard).toHaveLength(1);
    expect(heard[0]?.sessions?.[0]?.state).toBe('thinking');
    expect(heard[0]?.actors?.[0]).toMatchObject({
      actorId: 'actor-1',
      state: 'thinking',
    });
    heard.length = 0;

    emit(
      event('codex:a', 'session.meta', clock.wall(), {
        displayName: 'parser 修正',
      }),
    );

    expect(heard).toHaveLength(1);
    expect(heard[0]?.sessions?.[0]?.displayName).toBe('parser 修正');
    expect(heard[0]?.actors?.[0]).toMatchObject({
      actorId: 'actor-1',
      displayName: 'parser 修正',
    });
    expectValidChanges(heard);
  });

  it('狀態變: a change of the adapters only is passed on as it is, with no actors', () => {
    const { heard, ready, start, ctx, cast } = wire();
    ready();
    start('codex:a');
    heard.length = 0;

    ctx('codex').emit([], 'degraded');

    expect(heard).toStrictEqual([
      { adapters: [{ source: 'codex', health: 'degraded' }] },
    ]);
    expect(cast()).toStrictEqual([['codex:a', ONE, 'actor-1']]);
  });

  it('示範: demo mode’s session gets a character by the same rules, in the change that shows it; its state follows; turning demo mode off ends it', () => {
    const { heard, detection, ready, start, cast } = wire();
    ready();
    start('codex:a');
    heard.length = 0;

    detection.setDemo('approval');

    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-1'],
      ['demo:1', TWO, 'actor-2'],
    ]);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.actors?.[1]).toMatchObject({
      sessionKey: 'demo:1',
      state: 'approval',
    });
    heard.length = 0;

    detection.setDemo('done');

    expect(heard).toHaveLength(1);
    expect(heard[0]?.actors?.[1]).toMatchObject({
      actorId: 'actor-2',
      state: 'done',
    });

    detection.setDemo(null);

    expect(cast()).toStrictEqual([['codex:a', ONE, 'actor-1']]);
    expectValidChanges(heard);
  });

  it('重新啟動: an assignment saved last run whose session is still there and whose character is still in the pool keeps its character and actorId at sync', () => {
    const { ready, replay, start, cast, savedAssignments } = wire({
      saved: {
        schemaVersion: 2,
        released: [],
        assignments: [
          { sessionKey: 'codex:a', actorId: 'saved-a', characterKey: TWO },
        ],
      },
    });
    replay('codex:a');
    expect(cast()).toStrictEqual([]);

    ready();

    expect(cast()).toStrictEqual([['codex:a', TWO, 'saved-a']]);
    expect(savedAssignments()).toStrictEqual([
      { sessionKey: 'codex:a', actorId: 'saved-a', characterKey: TWO },
    ]);
    // The kept one counts once: ONE is off stage (never), then both once.
    start('codex:b');
    start('codex:c');
    expect(cast()).toStrictEqual([
      ['codex:a', TWO, 'saved-a'],
      ['codex:b', ONE, 'actor-1'],
      ['codex:c', ONE, 'actor-2'],
    ]);
  });

  it('重啟後換掉: a saved assignment whose session did not come back, or whose character left the pool, is dropped; a session still there gets a new one', () => {
    const { ready, replay, cast, savedAssignments } = wire({
      saved: {
        schemaVersion: 2,
        released: [],
        assignments: [
          { sessionKey: 'codex:gone', actorId: 'saved-g', characterKey: ONE },
          {
            sessionKey: 'codex:a',
            actorId: 'saved-a',
            characterKey: 'retired-pack/probe-one',
          },
          { sessionKey: 'codex:b', actorId: 'saved-b', characterKey: TWO },
        ],
      },
      settings: { fixedOverrides: { [TWO]: { inPool: false } } },
    });
    replay('codex:a');
    replay('codex:b');

    ready();

    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-1'],
      ['codex:b', ONE, 'actor-2'],
    ]);
    expect(savedAssignments().map((a) => a.actorId)).toStrictEqual([
      'actor-1',
      'actor-2',
    ]);
    expect(poolLines()).toContain(
      '[pool] start-up sync: kept 0 saved assignments, dropped 3 (1 not reported, 2 not in the pool)',
    );
  });

  it('重啟後換掉: the saved assignment of a session released last run is dropped, and the session gets no character', () => {
    const { ready, replay, cast, savedAssignments } = wire({
      saved: {
        schemaVersion: 2,
        released: ['codex:a'],
        assignments: [
          { sessionKey: 'codex:a', actorId: 'saved-a', characterKey: ONE },
        ],
      },
    });
    replay('codex:a');

    ready();

    expect(cast()).toStrictEqual([]);
    expect(savedAssignments()).toStrictEqual([]);
  });

  it('重新啟動: a source still syncing at the deadline keeps its saved assignments; its session takes its own back when it shows up', () => {
    const { clock, ready, replay, cast, savedAssignments } = wire({
      sources: ['codex', 'cursor'],
      saved: {
        schemaVersion: 2,
        released: [],
        assignments: [
          { sessionKey: 'cursor:c', actorId: 'saved-c', characterKey: TWO },
          { sessionKey: 'codex:gone', actorId: 'saved-g', characterKey: ONE },
        ],
      },
    });
    ready('codex');

    clock.advance(SETTINGS_DEFAULTS.syncTimeoutMs);

    // Synced without cursor, which has not read its records yet: its
    // assignment is kept, codex's unreported one dropped.
    expect(cast()).toStrictEqual([]);
    expect(savedAssignments().map((a) => a.sessionKey)).toStrictEqual([
      'cursor:c',
    ]);

    replay('cursor:c');

    expect(cast()).toStrictEqual([['cursor:c', TWO, 'saved-c']]);
  });

  it('重新啟動: what was assigned is written to assignments.json, and read back as saved at the next start', () => {
    const first = wire();
    first.ready();
    first.start('codex:a');
    first.start('codex:b');
    vi.advanceTimersByTime(POOL_FLUSH_DEBOUNCE_MS);

    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    expect(poolFileSchema.safeParse(written).success).toBe(true);
    expect(written).toStrictEqual({
      schemaVersion: 3,
      released: [],
      locked: [],
      lockOn: false,
      assignments: [
        { sessionKey: 'codex:a', actorId: 'actor-1', characterKey: ONE },
        { sessionKey: 'codex:b', actorId: 'actor-2', characterKey: TWO },
      ],
    });

    const second = wire();
    second.replay('codex:b');
    second.ready();

    expect(second.cast()).toStrictEqual([['codex:b', TWO, 'actor-2']]);
  });
});

describe('I/O matrix', () => {
  it('重新啟動: saved assignments that repeat a character (the pool ran out last run) are all kept while every pool character is on stage', () => {
    const { ready, replay, cast } = wire({
      saved: {
        schemaVersion: 2,
        released: [],
        assignments: [
          { sessionKey: 'codex:a', actorId: 'saved-a', characterKey: ONE },
          { sessionKey: 'codex:b', actorId: 'saved-b', characterKey: TWO },
          { sessionKey: 'codex:c', actorId: 'saved-c', characterKey: ONE },
        ],
      },
    });
    replay('codex:a');
    replay('codex:b');
    replay('codex:c');

    ready();

    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'saved-a'],
      ['codex:b', TWO, 'saved-b'],
      ['codex:c', ONE, 'saved-c'],
    ]);
  });

  it('重啟後換掉: a saved assignment whose character another session already plays is dropped while a pool character is free; the session gets that one', () => {
    const { ready, replay, cast, savedAssignments } = wire({
      saved: {
        schemaVersion: 2,
        released: [],
        assignments: [
          { sessionKey: 'codex:a', actorId: 'saved-a', characterKey: ONE },
          { sessionKey: 'codex:c', actorId: 'saved-c', characterKey: ONE },
        ],
      },
    });
    replay('codex:a');
    replay('codex:c');

    ready();

    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'saved-a'],
      ['codex:c', TWO, 'actor-1'],
    ]);
    expect(savedAssignments().map((a) => a.actorId)).toStrictEqual([
      'saved-a',
      'actor-1',
    ]);
  });

  it('重啟後換掉: a late session whose saved character went to another session meanwhile gets a new one while a pool character is free', () => {
    const { clock, ready, start, replay, cast } = wire({
      sources: ['codex', 'cursor'],
      saved: {
        schemaVersion: 2,
        released: [],
        assignments: [
          { sessionKey: 'cursor:c', actorId: 'saved-c', characterKey: ONE },
        ],
      },
    });
    ready('codex');
    clock.advance(SETTINGS_DEFAULTS.syncTimeoutMs);
    start('codex:a');
    expect(cast()).toStrictEqual([['codex:a', ONE, 'actor-1']]);

    replay('cursor:c');

    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-1'],
      ['cursor:c', TWO, 'actor-2'],
    ]);
  });

  it('重新啟動: a late session keeps its saved character, played by another session meanwhile, when no pool character is free', () => {
    const { clock, ready, start, replay, cast } = wire({
      sources: ['codex', 'cursor'],
      saved: {
        schemaVersion: 2,
        released: [],
        assignments: [
          { sessionKey: 'cursor:c', actorId: 'saved-c', characterKey: ONE },
        ],
      },
    });
    ready('codex');
    clock.advance(SETTINGS_DEFAULTS.syncTimeoutMs);
    start('codex:a');
    start('codex:b');

    replay('cursor:c');

    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-1'],
      ['codex:b', TWO, 'actor-2'],
      ['cursor:c', ONE, 'saved-c'],
    ]);
  });

  it('重啟後換掉: a late session whose saved character left the pool before it showed gets a new assignment', () => {
    const { clock, settings, ready, replay, cast, savedAssignments } = wire({
      sources: ['codex', 'cursor'],
      saved: {
        schemaVersion: 2,
        released: [],
        assignments: [
          { sessionKey: 'cursor:c', actorId: 'saved-c', characterKey: ONE },
        ],
      },
    });
    ready('codex');
    clock.advance(SETTINGS_DEFAULTS.syncTimeoutMs);
    expect(savedAssignments().map((a) => a.actorId)).toStrictEqual(['saved-c']);

    settings.set({ fixedOverrides: { [ONE]: { inPool: false } } });
    replay('cursor:c');

    expect(cast()).toStrictEqual([['cursor:c', TWO, 'actor-1']]);
    expect(savedAssignments().map((a) => a.actorId)).toStrictEqual(['actor-1']);
  });

  it('重新啟動: the start-up sweep of the saved releases runs through the assigner: a reported one stays, an unreported one of a confirmed source goes, one of an unconfirmed source stays; pool and actors in one change', () => {
    const { clock, heard, store, ready, replay, cast } = wire({
      sources: ['codex', 'cursor'],
      saved: {
        schemaVersion: 2,
        released: ['codex:a', 'codex:gone', 'cursor:x'],
        assignments: [],
      },
    });
    replay('codex:a');
    replay('codex:b');
    ready('codex');
    expect(store.get().pool.released).toStrictEqual([
      'codex:a',
      'codex:gone',
      'cursor:x',
    ]);
    heard.length = 0;

    clock.advance(SETTINGS_DEFAULTS.syncTimeoutMs);

    expect(store.get().pool.released).toStrictEqual(['codex:a', 'cursor:x']);
    expect(poolLines()).toContain(
      '[pool] start-up sweep: kept 2, dropped 1 (2 sessions reported; 1 kept unreported from unconfirmed sources: cursor)',
    );
    expect(cast()).toStrictEqual([['codex:b', ONE, 'actor-1']]);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toStrictEqual({
      pool: { released: ['codex:a', 'cursor:x'], locked: [], lockOn: false },
      actors: [expect.objectContaining({ sessionKey: 'codex:b' })],
    });
    expectValidChanges(heard);
  });

  it('同步前: a settings or packs change before sync makes no assignment', () => {
    const { heard, detection, settings, packs, ready, cast } = wire({
      installed: [],
    });
    detection.setDemo('working');

    packs.update([SAMPLE]);
    settings.set({ fixedOverrides: { [TWO]: { inPool: false } } });

    expect(cast()).toStrictEqual([]);
    expect(heard.every((changed) => changed.actors === undefined)).toBe(true);

    ready();

    expect(cast()).toStrictEqual([['demo:1', ONE, 'actor-1']]);
  });

  it('同步前: a start-up sweep that throws still ends the wait: sessions get their characters, and the failure is logged', () => {
    const clock = fakeClock();
    const settings = fakeSettings({});
    const detection = createDetection({
      settings,
      monotonic: clock.monotonic,
      wall: clock.wall,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const real = loadPool({ file, now: () => NOW });
    const assigner = createAssigner({
      detection,
      store: {
        ...real,
        sweep: () => {
          throw new Error('sweep bug');
        },
      },
      settings,
      packs: fakePacks([SAMPLE]),
      token: () => 'actor-1',
    });
    // No source adapter: synced at once, so this sync is the one that throws.
    detection.onSynced((reported, unconfirmed) => {
      assigner.sync(reported, unconfirmed);
    });

    detection.setDemo('working');

    expect(assigner.get().actors.map((a) => a.actorId)).toStrictEqual([
      'actor-1',
    ]);
    expect(poolLines()).toContain(
      '[pool] updating the assignments failed (Error)',
    );
  });
});

describe('the assigner', () => {
  it('starts with detection’s sections, the store’s pool and no actor', () => {
    const { assigner, detection, store } = wire();

    expect(assigner.get()).toStrictEqual({
      ...detection.get(),
      pool: store.get().pool,
      actors: [],
    });
  });

  it('syncs once: a second sync does nothing', () => {
    const { assigner, ready, start, cast } = wire();
    ready();
    start('codex:a');

    assigner.sync(new Set(), new Set());

    expect(cast()).toStrictEqual([['codex:a', ONE, 'actor-1']]);
  });

  it('never uses an actor id twice in a run: one the token repeats, or one saved last run, is drawn again', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        released: [],
        assignments: [
          { sessionKey: 'codex:gone', actorId: 'id-1', characterKey: ONE },
        ],
      }),
    );
    const clock = fakeClock();
    let context: AdapterContext | undefined;
    const settings = fakeSettings({});
    const detection = createDetection({
      settings,
      monotonic: clock.monotonic,
      wall: clock.wall,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      adapters: [
        {
          source: 'codex',
          start(given) {
            context = given;
          },
          stop() {},
        },
      ],
    });
    const tokens = ['id-1', 'id-2', 'id-2', '__proto__', '', 'id-3'];
    const assigner = createAssigner({
      detection,
      store: loadPool({ file, now: () => NOW }),
      settings,
      packs: fakePacks([SAMPLE]),
      token: () => tokens.shift() ?? 'spare',
    });
    detection.onSynced((reported, unconfirmed) => {
      assigner.sync(reported, unconfirmed);
    });
    context?.emit([{ type: 'sync.ready', source: 'codex' }], 'ok');

    context?.emit([event('codex:a', 'session.start', clock.wall())]);
    context?.emit([event('codex:b', 'session.start', clock.wall())]);

    expect(assigner.get().actors.map((actor) => actor.actorId)).toStrictEqual([
      'id-2',
      'id-3',
    ]);
  });

  it('leaves a session without a character, and says so, when no fresh actor id comes', () => {
    const clock = fakeClock();
    const settings = fakeSettings({});
    const detection = createDetection({
      settings,
      monotonic: clock.monotonic,
      wall: clock.wall,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const assigner = createAssigner({
      detection,
      store: loadPool({ file, now: () => NOW }),
      settings,
      packs: fakePacks([SAMPLE]),
      token: () => 'same',
    });
    detection.onSynced((reported, unconfirmed) => {
      assigner.sync(reported, unconfirmed);
    });

    detection.setDemo('working');
    expect(assigner.get().actors.map((a) => a.actorId)).toStrictEqual(['same']);
    detection.setDemo(null);
    detection.setDemo('working');

    expect(assigner.get().actors).toStrictEqual([]);
    expect(poolLines()).toContain(
      '[pool] no fresh actor id after 16 tries; the session stays without a character',
    );
  });

  it('logs counts only: never a session key, a character or an actor id', () => {
    const { ready, start, end, store } = wire({
      saved: {
        schemaVersion: 2,
        released: [],
        assignments: [
          { sessionKey: 'codex:gone', actorId: 'saved-g', characterKey: ONE },
        ],
      },
    });
    ready();
    start('codex:a');
    store.setReleased('codex:a', true);
    store.setReleased('codex:a', false);
    end('codex:a');

    const text = poolLines().join('\n');
    expect(text).toContain('[pool] assignments: 1 new');
    expect(text).not.toMatch(/codex:|sample-pack|probe-|actor-|saved-g/);
  });

  it('stops calling a listener once unsubscribed, and survives one that throws', () => {
    const { assigner, detection, ready } = wire();
    ready();
    const throwing = vi.fn(() => {
      throw new Error('listener bug');
    });
    const later = vi.fn();
    const stop = assigner.onChange(throwing);
    assigner.onChange(later);

    detection.setDemo('working');
    stop();
    detection.setDemo('done');

    expect(throwing).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledTimes(2);
    expect(poolLines()).toContain('[pool] a change listener failed (Error)');
  });
});

describe('with StageView, as main.ts wires them', () => {
  /** The contract pack's first character, the first in its pool. */
  const FIRST = `${CONTRACT_PACK_ID}/probe-one`;

  /** Installs the contract pack into `packs`, as the import does. */
  async function installContractPack(packs: PacksStore): Promise<void> {
    const awpet = path.join(dir, 'contract.awpet');
    fs.writeFileSync(awpet, await zipBuffer(itemsOf(contractPackFiles())));
    const inspection = await inspectPack(awpet, packs);
    if (!inspection.ok) {
      throw new Error(JSON.stringify(inspection.rejection));
    }
    const installed = installPack(packs, inspection.plan, {
      token: () => 't1',
    });
    if (!installed.ok) {
      throw new Error(JSON.stringify(installed));
    }
  }

  /**
   * Real settings, packs store, pool store and StageView, wired in
   * main.ts's order (watchPool right after createStageView); detection has
   * no source adapter, so it is synced from the start.
   */
  function wireStage() {
    fake.resetFakeElectron();
    const settings = loadSettings({ file: path.join(dir, 'settings.json') });
    const detection = createDetection({ settings });
    const store = loadPool({ file, now: () => NOW });
    const packs = loadPacks({ dir: path.join(dir, 'packs') });
    let made = 0;
    const assigner = createAssigner({
      detection,
      store,
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
    const hub = createStageView({
      settings,
      windows: createWindowsStageSource(),
      assigner,
      packs,
      packImport: {
        get: () => ({ packImport: { phase: 'idle' } }),
        onChange: () => () => {},
      },
      packExport: {
        get: () => ({ packExport: { phase: 'idle' } }),
        onChange: () => () => {},
      },
      characters: {
        get: () => ({ characters: {} }),
        onChange: () => () => {},
      },
    });
    assigner.watchPool();
    const subscriber = fake.createFakeWebContents(
      1,
      'app://panels/index.html',
      false,
    );
    hub.subscribe(subscriber);
    const deltas = () =>
      subscriber.sent.map(({ args }) => args[0] as StageViewDelta);
    return { settings, detection, packs, hub, deltas };
  }

  /** The rev of the first delta in `deltas` that carries `section`. */
  function revOf(
    deltas: readonly StageViewDelta[],
    section: 'packs' | 'settings' | 'actors',
  ): number | undefined {
    return deltas.find((delta) => delta.sections[section] !== undefined)?.rev;
  }

  it('池子變大: a pack installed while a shown session has no character: the packs delta reaches the renderer before the actors delta that uses it', async () => {
    const { detection, packs, hub, deltas } = wireStage();
    detection.setDemo('working');
    expect(hub.snapshot().view.actors).toStrictEqual([]);
    const before = deltas().length;

    await installContractPack(packs);

    const after = deltas().slice(before);
    const packsRev = revOf(after, 'packs');
    const actorsRev = revOf(after, 'actors');
    expect(packsRev).toBeDefined();
    expect(actorsRev).toBeDefined();
    expect(packsRev as number).toBeLessThan(actorsRev as number);
    expect(hub.snapshot().view.actors).toStrictEqual([
      expect.objectContaining({ sessionKey: 'demo:1', characterKey: FIRST }),
    ]);
    for (const delta of deltas()) {
      expect(stageViewDeltaSchema.safeParse(delta).success).toBe(true);
    }
  });

  it('池子變大: 上場 turned back on while a shown session has no character: the settings delta reaches the renderer before the actors delta that uses it', async () => {
    const { settings, detection, packs, hub, deltas } = wireStage();
    settings.patch({
      baseRev: settings.get().rev,
      ops: [{ op: 'setPackEnabled', packId: CONTRACT_PACK_ID, value: false }],
    });
    await installContractPack(packs);
    detection.setDemo('working');
    expect(hub.snapshot().view.actors).toStrictEqual([]);
    const before = deltas().length;

    settings.patch({
      baseRev: settings.get().rev,
      ops: [{ op: 'setPackEnabled', packId: CONTRACT_PACK_ID, value: true }],
    });

    const after = deltas().slice(before);
    expect(after.map((delta) => Object.keys(delta.sections))).toStrictEqual([
      ['settings'],
      ['actors'],
    ]);
    expect(revOf(after, 'settings')).toBeLessThan(
      revOf(after, 'actors') as number,
    );
    expect(hub.snapshot().view.actors).toStrictEqual([
      expect.objectContaining({ sessionKey: 'demo:1', characterKey: FIRST }),
    ]);
  });
});

// FR21 as changed on 2026-11-24: demo mode has the stage to itself.
describe("demo mode's stage", () => {
  const PICKED: CharacterKey = TWO;

  it('清場: parks every other shown session’s actor at once, gives new ones none, and the demo session plays the character named (out of the pool too), released or not', () => {
    const { ready, start, cast, settings, assigner, detection, store, heard } =
      wire({ installed: [SAMPLE, ANOTHER] });
    ready();
    start('codex:a');
    start('codex:b');
    expect(cast()).toStrictEqual([
      ['codex:a', THREE, 'actor-1'],
      ['codex:b', ONE, 'actor-2'],
    ]);
    settings.set({ fixedOverrides: { [PICKED]: { inPool: false } } });
    heard.length = 0;

    assigner.setDemo({ characterKey: PICKED });
    expect(cast()).toStrictEqual([]);
    expect(heard).toStrictEqual([{ actors: [] }]);

    detection.setDemo('idle');
    expect(cast()).toStrictEqual([['demo:1', PICKED, 'actor-3']]);

    start('codex:c');
    store.setReleased('demo:1', true);
    expect(cast()).toStrictEqual([['demo:1', PICKED, 'actor-3']]);
    expect(poolLines()).toContain('[pool] demo mode stage on (one character)');
    expect(poolLines()).toContain(
      '[pool] demo mode: 2 actors taken off the stage, 0 back on it with their characters',
    );
  });

  it('saves the parked assignments, never the demo’s', () => {
    const { ready, start, assigner, detection, savedAssignments } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    start('codex:a');

    assigner.setDemo({ characterKey: ONE });
    detection.setDemo('working');

    expect(savedAssignments()).toStrictEqual([
      { sessionKey: 'codex:a', actorId: 'actor-1', characterKey: THREE },
    ]);
  });

  it('回復: off again, the demo’s actor ends and each parked session comes back with its character and a new actor id; one that came meanwhile gets the usual pick', () => {
    const { ready, start, cast, assigner, detection, savedAssignments } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    start('codex:a');
    start('codex:b');
    assigner.setDemo({ characterKey: ONE });
    detection.setDemo('thinking');
    start('codex:c');

    detection.setDemo(null);
    assigner.setDemo(null);

    expect(cast()).toStrictEqual([
      ['codex:a', THREE, 'actor-4'],
      ['codex:b', ONE, 'actor-5'],
      ['codex:c', TWO, 'actor-6'],
    ]);
    expect(savedAssignments()).toHaveLength(3);
    expect(poolLines()).toContain(
      '[pool] demo mode: 0 actors taken off the stage, 2 back on it with their characters',
    );
  });

  it('a parked session whose character left the pool meanwhile comes back with the usual pick', () => {
    const { ready, start, cast, assigner, settings } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    start('codex:a');
    assigner.setDemo({ characterKey: ONE });
    settings.set({ packEnabled: { 'another-pack': false } });

    assigner.setDemo(null);

    expect(cast()).toStrictEqual([['codex:a', ONE, 'actor-2']]);
  });

  it('a parked session that ended, or was released, during demo mode does not come back', () => {
    const { ready, start, end, cast, assigner, store, sessionKeys } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    start('codex:a');
    start('codex:b');
    assigner.setDemo({ characterKey: ONE });
    end('codex:a');
    store.setReleased('codex:b', true);

    assigner.setDemo(null);

    expect(cast()).toStrictEqual([]);
    expect(sessionKeys()).toStrictEqual(['codex:b']);
  });

  it('重新載入: each setDemo with a stage starts the demo’s actor anew, the same character or another', () => {
    const { ready, cast, assigner, detection } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    assigner.setDemo({ characterKey: ONE });
    detection.setDemo('working');
    expect(cast()).toStrictEqual([['demo:1', ONE, 'actor-1']]);

    assigner.setDemo({ characterKey: ONE });
    expect(cast()).toStrictEqual([['demo:1', ONE, 'actor-2']]);

    assigner.setDemo({ characterKey: THREE });
    expect(cast()).toStrictEqual([['demo:1', THREE, 'actor-3']]);
  });

  it('休息中: switching the demo session to idle (it ends and starts again in one change) keeps its actor', () => {
    const { ready, cast, assigner, detection } = wire();
    ready();
    assigner.setDemo({ characterKey: ONE });
    detection.setDemo('working');

    for (const state of ['idle', 'thinking', 'idle', 'error'] as const) {
      detection.setDemo(state);
      expect(cast()).toStrictEqual([['demo:1', ONE, 'actor-1']]);
      expect(detection.get().sessions[0]?.state).toBe(state);
    }
  });

  it('no character: none named, or not installed (any more): the demo session is shown with no actor', () => {
    const { ready, cast, assigner, detection, packs, sessionKeys } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    assigner.setDemo({ characterKey: null });
    detection.setDemo('done');
    expect(cast()).toStrictEqual([]);

    assigner.setDemo({ characterKey: 'gone-pack/probe' });
    expect(cast()).toStrictEqual([]);

    assigner.setDemo({ characterKey: THREE });
    expect(cast()).toStrictEqual([['demo:1', THREE, 'actor-1']]);

    packs.update([SAMPLE]);
    expect(cast()).toStrictEqual([]);
    expect(sessionKeys()).toStrictEqual(['demo:1']);
  });

  it('換角色 leaves the demo alone: its character’s pack no longer 上場, or the character out of the pool, keeps the demo actor', () => {
    const { ready, cast, settings, assigner, detection, heard } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    assigner.setDemo({ characterKey: THREE });
    detection.setDemo('idle');
    expect(cast()).toStrictEqual([['demo:1', THREE, 'actor-1']]);
    heard.length = 0;

    settings.set({ packEnabled: { 'another-pack': false } });
    settings.set({ fixedOverrides: { [THREE]: { inPool: false } } });

    expect(cast()).toStrictEqual([['demo:1', THREE, 'actor-1']]);
    expect(heard).toStrictEqual([]);
  });

  it('示範中: the demo character’s pack marked failed keeps the demo actor, and demo mode still lists the character', () => {
    const { ready, cast, packs, assigner, detection, heard } = wire({
      installed: [SAMPLE, ANOTHER],
    });
    ready();
    assigner.setDemo({ characterKey: THREE });
    detection.setDemo('idle');
    expect(cast()).toStrictEqual([['demo:1', THREE, 'actor-1']]);
    heard.length = 0;

    packs.update([SAMPLE, { ...ANOTHER, runtimeFailed: 'worker-error' }]);

    expect(cast()).toStrictEqual([['demo:1', THREE, 'actor-1']]);
    expect(heard).toStrictEqual([]);
    expect(
      demoCharactersOf(packs.get().packs.installed, null).map(
        (character) => character.key,
      ),
    ).toContain(THREE);
  });

  it('a character of a pack that does not fit this stage is not shown', () => {
    const newer: StagePack = {
      ...ANOTHER,
      apiVersion: '1.9',
      compatibility: {
        compatible: false,
        reason: 'pack-newer',
        required: '1.9',
      },
    };
    const { ready, cast, assigner, detection } = wire({
      installed: [SAMPLE, newer],
    });
    ready();
    assigner.setDemo({ characterKey: THREE });
    detection.setDemo('done');

    expect(cast()).toStrictEqual([]);
  });

  it('before start-up sync: takes effect at sync, in the same change', () => {
    const { ready, start, cast, assigner, detection } = wire();
    start('codex:a');
    assigner.setDemo({ characterKey: TWO });
    detection.setDemo('waiting');
    expect(cast()).toStrictEqual([]);

    ready();
    expect(cast()).toStrictEqual([['demo:1', TWO, 'actor-1']]);

    detection.setDemo(null);
    assigner.setDemo(null);
    expect(cast()).toStrictEqual([['codex:a', ONE, 'actor-2']]);
  });

  it('setDemo(null) while off changes nothing and logs nothing', () => {
    const { ready, start, assigner, heard } = wire();
    ready();
    start('codex:a');
    heard.length = 0;
    const before = poolLines().length;

    assigner.setDemo(null);

    expect(heard).toStrictEqual([]);
    expect(poolLines()).toHaveLength(before);
  });
});

describe('I/O matrix', () => {
  // Session bulk-lock: 全部釋放 / 全部顯示, 鎖定 and 鎖定展示, through the
  // one rule of who gets no character (src/shared/pool heldBackBy).

  /** The store's `pool` section as heard. */
  function pool(
    released: readonly SessionKey[],
    locked: readonly SessionKey[] = [],
    lockOn = false,
  ) {
    return { released, locked, lockOn };
  }

  it('鎖定（關著）: with 鎖定展示 off, locking a row changes no actor: only the pool section is heard', () => {
    const { heard, ready, start, store, cast } = wire();
    ready();
    start('codex:a');
    start('codex:b');
    const before = cast();
    heard.length = 0;

    store.setLocked('codex:a', true);

    expect(cast()).toStrictEqual(before);
    expect(heard).toStrictEqual([{ pool: pool([], ['codex:a']) }]);
    expectValidChanges(heard);
  });

  it('全部釋放: releasing every listed session at once takes every actor away; pool and actors in one change', () => {
    const { heard, ready, start, store, cast, savedAssignments } = wire();
    ready();
    start('codex:a');
    start('codex:b');
    heard.length = 0;

    store.setReleasedMany(['codex:a', 'codex:b'], true);

    expect(cast()).toStrictEqual([]);
    expect(heard).toStrictEqual([
      { pool: pool(['codex:a', 'codex:b']), actors: [] },
    ]);
    expect(savedAssignments()).toStrictEqual([]);
    expectValidChanges(heard);
  });

  it('全部顯示: showing them all again gives each a character by the pool rule, with new actor ids, in one change', () => {
    const { heard, ready, start, store, cast } = wire();
    ready();
    start('codex:a');
    start('codex:b');
    store.setReleasedMany(['codex:a', 'codex:b'], true);
    heard.length = 0;

    store.setReleasedMany(['codex:a', 'codex:b'], false);

    // ONE and TWO have appeared once each: pool order.
    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-3'],
      ['codex:b', TWO, 'actor-4'],
    ]);
    expect(heard).toHaveLength(1);
    expect(Object.keys(heard[0] ?? {}).sort()).toStrictEqual([
      'actors',
      'pool',
    ]);
  });

  it('打開鎖定: A locked (and released), B not: with 鎖定展示 on, A has a character and B none, in one change; a new C gets none', () => {
    const { heard, ready, start, store, cast } = wire();
    ready();
    start('codex:a');
    start('codex:b');
    store.setReleased('codex:a', true);
    store.setLocked('codex:a', true);
    expect(cast()).toStrictEqual([['codex:b', TWO, 'actor-2']]);
    heard.length = 0;

    store.setLockOn(true);

    expect(cast()).toStrictEqual([['codex:a', ONE, 'actor-3']]);
    expect(heard).toStrictEqual([
      {
        pool: pool(['codex:a'], ['codex:a'], true),
        actors: [expect.objectContaining({ sessionKey: 'codex:a' })],
      },
    ]);
    expectValidChanges(heard);

    start('codex:c');

    expect(cast()).toStrictEqual([['codex:a', ONE, 'actor-3']]);
  });

  it('取消最後一勾: unticking A while 鎖定展示 is on turns it off: back to the usual rule, in one change', () => {
    const { heard, ready, start, store, cast } = wire();
    ready();
    start('codex:a');
    start('codex:b');
    store.setLocked('codex:a', true);
    store.setLockOn(true);
    expect(cast()).toStrictEqual([['codex:a', ONE, 'actor-1']]);
    heard.length = 0;

    store.setLocked('codex:a', false);

    expect(store.get().pool.lockOn).toBe(false);
    expect(cast()).toStrictEqual([
      ['codex:a', ONE, 'actor-1'],
      ['codex:b', TWO, 'actor-3'],
    ]);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.pool).toStrictEqual(pool([]));
  });

  it('重啟: A, locked last run with 鎖定展示 on, is not reported: the sweep drops it, 鎖定展示 goes off, and the sessions there get characters as usual', () => {
    const { heard, ready, replay, cast, store } = wire({
      saved: {
        schemaVersion: 3,
        released: [],
        locked: ['codex:a'],
        lockOn: true,
        assignments: [],
      },
    });
    replay('codex:b');
    expect(store.get().pool).toStrictEqual(pool([], ['codex:a'], true));
    heard.length = 0;

    ready();

    expect(cast()).toStrictEqual([['codex:b', ONE, 'actor-1']]);
    expect(heard.at(-1)?.pool).toStrictEqual(pool([]));
    expectValidChanges(heard);
  });

  it('重啟: with 鎖定展示 on, the saved assignment of a session not locked is dropped; it gets no character, and a new actor when the lock goes off', () => {
    const { ready, replay, cast, store, savedAssignments } = wire({
      saved: {
        schemaVersion: 3,
        released: [],
        locked: ['codex:a'],
        lockOn: true,
        assignments: [
          { sessionKey: 'codex:a', actorId: 'saved-a', characterKey: ONE },
          { sessionKey: 'codex:b', actorId: 'saved-b', characterKey: TWO },
        ],
      },
    });
    replay('codex:a');
    replay('codex:b');

    ready();

    expect(cast()).toStrictEqual([['codex:a', ONE, 'saved-a']]);
    expect(savedAssignments().map((a) => a.sessionKey)).toStrictEqual([
      'codex:a',
    ]);

    store.setLockOn(false);

    const b = cast().find(([key]) => key === 'codex:b');
    expect(b).toBeDefined();
    expect(b?.[2]).not.toBe('saved-b');
  });

  it('示範: 鎖定展示 does not touch demo mode: the demo session plays while it is not locked', () => {
    const { ready, start, store, assigner, detection, cast } = wire();
    ready();
    start('codex:a');
    store.setLocked('codex:a', true);
    store.setLockOn(true);

    assigner.setDemo({ characterKey: TWO });
    detection.setDemo('idle');

    expect(cast()).toStrictEqual([['demo:1', TWO, 'actor-2']]);
  });
});
