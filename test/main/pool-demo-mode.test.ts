/**
 * main/pool's demo mode (FR21 as changed on 2026-11-24): the controller on
 * fakes, then wired as main.ts wires it (main/detection on a fake clock,
 * main/pool's assigner and store on a real assignments.json in a temp
 * folder, the tray's 示範模式 template clicked) through the case that
 * started it: a character on a real session, demo mode showing another.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext } from '../../src/main/detection/adapter';
import { createDetection } from '../../src/main/detection/detection';
import { createAssigner, type DemoStage } from '../../src/main/pool/assign';
import {
  createDemoMode,
  DEMO_START_STATE,
  demoCharactersOf,
  type DemoCharacter,
  type DemoModeView,
} from '../../src/main/pool/demo-mode';
import { loadPool } from '../../src/main/pool/store';
import {
  demoCharacterItemId,
  demoItemId,
  trayMenuTemplate,
} from '../../src/main/windows/menu';
import {
  confidenceFor,
  detectionEventSchema,
  type SessionKey,
} from '../../src/shared/detection-events';
import type { CharacterKey, StagePack } from '../../src/shared/packs';
import {
  SETTINGS_DEFAULTS,
  type SettingsPatch,
  type SettingsState,
} from '../../src/shared/settings';
import type { StageViewPacksSections } from '../../src/shared/stage-view';
import { STATE_CODES, type StateCode } from '../../src/shared/states';
import { fakeClock } from '../helpers/fake-clock';

vi.mock('electron', () => import('../helpers/fake-electron'));

const CONTRACT: StagePack = {
  id: 'contract-pack',
  name: '契約測試包',
  version: '1.0.0',
  apiVersion: '1.0',
  compatibility: { compatible: true },
  characters: [
    { id: 'probe-one', name: '探針一', height: 110 },
    { id: 'probe-two', name: '探針二', height: 96 },
  ],
};
const DYNAMES_PACK: StagePack = {
  id: 'dynames',
  name: '力天使',
  version: '1.0.0',
  apiVersion: '1.0',
  compatibility: { compatible: true },
  characters: [{ id: 'dynames', name: '力天使 GN-002', height: 110 }],
};
const PROBE_ONE: CharacterKey = 'contract-pack/probe-one';
const PROBE_TWO: CharacterKey = 'contract-pack/probe-two';
const DYNAMES: CharacterKey = 'dynames/dynames';

const LISTED = {
  probeOne: { key: PROBE_ONE, label: '探針一（契約測試包）' },
  probeTwo: { key: PROBE_TWO, label: '探針二（契約測試包）' },
  dynames: { key: DYNAMES, label: '力天使 GN-002（力天使）' },
} as const satisfies Record<string, DemoCharacter>;

beforeEach(() => {
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
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

/** main/settings with `set` ops on any field, and a failure to inject. */
function fakeSettings(demoCharacter: CharacterKey | null = null) {
  let state: SettingsState = {
    rev: 0,
    values: { ...SETTINGS_DEFAULTS, demoCharacter },
  };
  const listeners = new Set<(next: SettingsState) => void>();
  const patches: SettingsPatch[] = [];
  let failNext = false;
  return {
    patches,
    failNextPatch() {
      failNext = true;
    },
    get: () => state,
    onChange(listener: (next: SettingsState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    patch(patch: SettingsPatch) {
      if (failNext) {
        failNext = false;
        throw new Error('no write');
      }
      patches.push(patch);
      let values = state.values;
      for (const op of patch.ops) {
        if (op.op === 'set') {
          values = { ...values, [op.field]: op.value };
        }
      }
      state = { rev: state.rev + 1, values };
      for (const listener of listeners) {
        listener(state);
      }
      return { rev: state.rev, merged: false, saved: true };
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

interface FakeOptions {
  readonly installed?: readonly StagePack[];
  readonly remembered?: CharacterKey | null;
  readonly watch?: boolean;
}

/**
 * Demo mode on fakes: `calls` records, in order, the batches, the
 * assigner's and detection's setDemo and the remembered character; `asks`
 * the chooser's questions (answer one with `answer`); `heard` the views.
 */
function onFakes({
  installed = [CONTRACT, DYNAMES_PACK],
  remembered = null,
  watch = true,
}: FakeOptions = {}) {
  const calls: string[] = [];
  const settings = fakeSettings(remembered);
  settings.onChange((state) => {
    calls.push(`remember ${String(state.values.demoCharacter)}`);
  });
  const packs = fakePacks(installed);
  const asks: {
    characters: readonly DemoCharacter[];
    pick: (key: CharacterKey) => void;
  }[] = [];
  const demo = createDemoMode({
    detection: {
      setDemo(state: StateCode | null) {
        calls.push(`detection ${String(state)}`);
      },
    },
    assigner: {
      setDemo(stage: DemoStage | null) {
        calls.push(
          `assigner ${stage === null ? 'off' : String(stage.characterKey)}`,
        );
      },
    },
    settings,
    packs,
    chooseCharacter(characters, pick) {
      calls.push('ask');
      asks.push({ characters, pick });
    },
    batch(run) {
      calls.push('batch begins');
      try {
        run();
      } finally {
        calls.push('batch ends');
      }
    },
  });
  if (watch) {
    demo.watch();
  }
  const heard: DemoModeView[] = [];
  demo.onChange((view) => {
    heard.push(view);
  });
  return { demo, calls, settings, packs, asks, heard };
}

describe('demoCharactersOf', () => {
  it('lists every character of the installed packs that fit this stage, by pack id then manifest order, labelled 角色（包）', () => {
    expect(demoCharactersOf([DYNAMES_PACK, CONTRACT], null)).toStrictEqual([
      LISTED.probeOne,
      LISTED.probeTwo,
      LISTED.dynames,
    ]);
  });

  it('puts the remembered one first, the rest in order', () => {
    expect(demoCharactersOf([CONTRACT, DYNAMES_PACK], DYNAMES)).toStrictEqual([
      LISTED.dynames,
      LISTED.probeOne,
      LISTED.probeTwo,
    ]);
    expect(demoCharactersOf([CONTRACT, DYNAMES_PACK], PROBE_TWO)).toStrictEqual(
      [LISTED.probeTwo, LISTED.probeOne, LISTED.dynames],
    );
  });

  it('a remembered one not installed changes nothing; a pack that does not fit this stage is left out', () => {
    const newer: StagePack = {
      ...DYNAMES_PACK,
      apiVersion: '1.9',
      compatibility: {
        compatible: false,
        reason: 'pack-newer',
        required: '1.9',
      },
    };
    expect(demoCharactersOf([CONTRACT, newer], DYNAMES)).toStrictEqual([
      LISTED.probeOne,
      LISTED.probeTwo,
    ]);
    expect(demoCharactersOf([], DYNAMES)).toStrictEqual([]);
  });
});

describe('demo mode', () => {
  it('starts off, the remembered character checked when it is installed', () => {
    expect(onFakes({ remembered: DYNAMES }).demo.view()).toStrictEqual({
      on: false,
      state: null,
      character: DYNAMES,
      characters: [LISTED.dynames, LISTED.probeOne, LISTED.probeTwo],
    });
    expect(
      onFakes({ remembered: 'gone-pack/gone' }).demo.view().character,
    ).toBeNull();
  });

  it('選角色: picking a character while off clears the stage, shows 休息中 with it and remembers it, as one change', () => {
    const { demo, calls, heard } = onFakes();

    demo.pickCharacter(DYNAMES);

    expect(DEMO_START_STATE).toBe('idle');
    expect(calls).toStrictEqual([
      'batch begins',
      `assigner ${DYNAMES}`,
      'detection idle',
      `remember ${DYNAMES}`,
      'batch ends',
    ]);
    const on: DemoModeView = {
      on: true,
      state: 'idle',
      character: DYNAMES,
      characters: [LISTED.dynames, LISTED.probeOne, LISTED.probeTwo],
    };
    expect(demo.view()).toStrictEqual(on);
    expect(heard).toStrictEqual([on]);
    expect(poolLines()).toStrictEqual([
      '[pool] demo mode on (a character picked)',
    ]);
  });

  it('切狀態: a state picked while on goes to the demo session alone; the character stays', () => {
    const { demo, calls } = onFakes();
    demo.pickCharacter(DYNAMES);
    calls.length = 0;

    for (const state of STATE_CODES) {
      demo.pickState(state);
      expect(demo.view()).toMatchObject({
        on: true,
        state,
        character: DYNAMES,
      });
    }

    expect(calls).toStrictEqual(
      STATE_CODES.flatMap((state) => [
        'batch begins',
        `detection ${state}`,
        'batch ends',
      ]),
    );
  });

  it('換角色: another character while on switches to it from 休息中; the same one again reloads it', () => {
    const { demo, calls } = onFakes();
    demo.pickCharacter(DYNAMES);
    demo.pickState('working');
    calls.length = 0;

    demo.pickCharacter(PROBE_ONE);
    demo.pickCharacter(PROBE_ONE);

    expect(calls).toStrictEqual([
      'batch begins',
      `assigner ${PROBE_ONE}`,
      'detection idle',
      `remember ${PROBE_ONE}`,
      'batch ends',
      'batch begins',
      `assigner ${PROBE_ONE}`,
      'detection idle',
      'batch ends',
    ]);
    expect(demo.view()).toMatchObject({ state: 'idle', character: PROBE_ONE });
  });

  it('a character not installed (a menu older than the packs) is refused with a warning', () => {
    const { demo, calls } = onFakes();

    demo.pickCharacter('gone-pack/gone');

    expect(calls).toStrictEqual([]);
    expect(demo.view().on).toBe(false);
    expect(poolLines()).toStrictEqual([
      '[pool] demo mode: the character picked is not installed',
    ]);
  });

  it('a state picked while off turns demo mode on with the remembered character, from that state', () => {
    const { demo, calls, asks } = onFakes({ remembered: PROBE_TWO });

    demo.pickState('approval');

    expect(asks).toStrictEqual([]);
    expect(calls).toStrictEqual([
      'batch begins',
      `assigner ${PROBE_TWO}`,
      'detection approval',
      'batch ends',
    ]);
    expect(demo.view()).toMatchObject({
      on: true,
      state: 'approval',
      character: PROBE_TWO,
    });
  });

  it.each([
    ['nothing remembered', null],
    ['the remembered one gone', 'gone-pack/gone'],
  ] as const)(
    '跳出選單: a state picked while off with %s asks which character to show, then shows that state with it',
    (_label, remembered) => {
      const { demo, calls, asks } = onFakes({ remembered });

      demo.pickState('thinking');

      expect(calls).toStrictEqual(['ask']);
      expect(demo.view().on).toBe(false);
      expect(asks.map((ask) => ask.characters)).toStrictEqual([
        [LISTED.probeOne, LISTED.probeTwo, LISTED.dynames],
      ]);

      asks[0]?.pick(DYNAMES);
      expect(calls.slice(1)).toStrictEqual([
        'batch begins',
        `assigner ${DYNAMES}`,
        'detection thinking',
        `remember ${DYNAMES}`,
        'batch ends',
      ]);
      expect(demo.view()).toMatchObject({
        on: true,
        state: 'thinking',
        character: DYNAMES,
      });
      expect(poolLines()).toContain(
        '[pool] demo mode: asking which character to show',
      );
    },
  );

  it('跳出選單: nothing is picked, nothing happens; a pick no longer installed is refused', () => {
    const { demo, calls, asks, packs } = onFakes();
    demo.pickState('thinking');
    expect(demo.view().on).toBe(false);

    packs.update([CONTRACT]);
    asks[0]?.pick(DYNAMES);

    expect(calls).toStrictEqual(['ask']);
    expect(demo.view().on).toBe(false);
  });

  it('沒有角色: a state picked while off with no character installed runs demo mode with none (the panel still shows the session)', () => {
    const { demo, calls, asks } = onFakes({ installed: [] });

    demo.pickState('error');

    expect(asks).toStrictEqual([]);
    expect(calls).toStrictEqual([
      'batch begins',
      'assigner null',
      'detection error',
      'batch ends',
    ]);
    expect(demo.view()).toStrictEqual({
      on: true,
      state: 'error',
      character: null,
      characters: [],
    });
    expect(poolLines()).toStrictEqual([
      '[pool] demo mode on (no character installed)',
    ]);
  });

  it('關閉: ends the demo session, then gives the stage back, as one change; nothing while off', () => {
    const { demo, calls, heard } = onFakes({ remembered: DYNAMES });
    demo.stop();
    expect(calls).toStrictEqual([]);

    demo.pickCharacter(DYNAMES);
    calls.length = 0;
    heard.length = 0;
    demo.stop();

    expect(calls).toStrictEqual([
      'batch begins',
      'detection null',
      'assigner off',
      'batch ends',
    ]);
    expect(demo.view()).toStrictEqual({
      on: false,
      state: null,
      character: DYNAMES,
      characters: [LISTED.dynames, LISTED.probeOne, LISTED.probeTwo],
    });
    expect(heard).toHaveLength(1);
    expect(poolLines()).toContain('[pool] demo mode off');
  });

  it('角色包移除: the character in use leaving (its pack removed, or a new version without it) turns demo mode off', () => {
    const { demo, calls, packs } = onFakes();
    demo.pickCharacter(PROBE_TWO);
    calls.length = 0;

    packs.update([
      { ...CONTRACT, version: '1.0.1', characters: [CONTRACT.characters[0]!] },
      DYNAMES_PACK,
    ]);

    expect(calls).toStrictEqual([
      'batch begins',
      'detection null',
      'assigner off',
      'batch ends',
    ]);
    expect(demo.view().on).toBe(false);
    expect(poolLines()).toContain(
      '[pool] demo mode off: its character is no longer installed',
    );
  });

  it('重新匯入: a new version that still has the character keeps demo mode as it is (the canvas reloads a pack whose version changed)', () => {
    const { demo, calls, packs, heard } = onFakes();
    demo.pickCharacter(DYNAMES);
    calls.length = 0;
    heard.length = 0;

    packs.update([CONTRACT, { ...DYNAMES_PACK, version: '1.0.1' }]);

    expect(calls).toStrictEqual([]);
    expect(demo.view()).toMatchObject({ on: true, character: DYNAMES });
    expect(heard).toStrictEqual([]);
  });

  it('follows the installed packs and the remembered character once watching: the menu hears each change of what it lists', () => {
    const { demo, packs, settings, heard } = onFakes();

    packs.update([DYNAMES_PACK]);
    settings.patch({
      baseRev: settings.get().rev,
      ops: [{ op: 'set', field: 'demoCharacter', value: DYNAMES }],
    });

    expect(heard).toStrictEqual([
      {
        on: false,
        state: null,
        character: null,
        characters: [LISTED.dynames],
      },
      {
        on: false,
        state: null,
        character: DYNAMES,
        characters: [LISTED.dynames],
      },
    ]);
    expect(demo.view()).toBe(heard[1]);
  });

  it('before watch(), a pack removed is not followed; watch() twice follows once', () => {
    const { demo, packs, heard, calls } = onFakes({ watch: false });
    demo.pickCharacter(DYNAMES);
    calls.length = 0;
    heard.length = 0;

    packs.update([CONTRACT]);
    expect(calls).toStrictEqual([]);

    demo.watch();
    demo.watch();
    packs.update([CONTRACT, DYNAMES_PACK]);
    packs.update([CONTRACT]);
    expect(calls.filter((call) => call === 'detection null')).toHaveLength(1);
  });

  it('a failed remember is logged; demo mode still goes on', () => {
    const { demo, settings } = onFakes();
    settings.failNextPatch();

    demo.pickCharacter(DYNAMES);

    expect(demo.view()).toMatchObject({ on: true, character: DYNAMES });
    expect(settings.get().values.demoCharacter).toBeNull();
    expect(poolLines()).toContain(
      '[pool] remembering the demo character failed (Error)',
    );
  });

  it('a listener that throws is logged; the others still hear', () => {
    const { demo, heard } = onFakes();
    demo.onChange(() => {
      throw new Error('menu gone');
    });

    demo.pickCharacter(DYNAMES);

    expect(heard).toHaveLength(1);
    expect(poolLines()).toContain('[pool] a demo mode listener failed (Error)');
  });

  it('an unsubscribed listener hears nothing more', () => {
    const { demo } = onFakes();
    const heard: DemoModeView[] = [];
    const unsubscribe = demo.onChange((view) => {
      heard.push(view);
    });
    unsubscribe();

    demo.pickCharacter(DYNAMES);

    expect(heard).toStrictEqual([]);
  });
});

/**
 * 2026-11-24 13:12: 力天使 played a real session, demo mode's session got
 * a test pack's character, and switching states seemed to do nothing.
 * Wired as main.ts wires it, the tray's 示範模式 template clicked.
 */
describe('demo mode wired as main.ts wires it', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-demo-mode-'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function wire() {
    const clock = fakeClock();
    const settings = fakeSettings();
    let context: AdapterContext | undefined;
    const detection = createDetection({
      settings,
      monotonic: clock.monotonic,
      wall: clock.wall,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      adapters: [
        {
          source: 'claude-code',
          start(given: AdapterContext) {
            context = given;
          },
          stop() {},
        },
      ],
    });
    const store = loadPool({ file: path.join(dir, 'assignments.json') });
    const packs = fakePacks([CONTRACT, DYNAMES_PACK]);
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
    assigner.watchPool();
    const demo = createDemoMode({
      detection,
      assigner,
      settings,
      packs,
      chooseCharacter: () => {
        throw new Error('not asked here');
      },
    });
    demo.watch();
    const actions = {
      openPage: () => {},
      pickDemoCharacter: (key: CharacterKey) => {
        demo.pickCharacter(key);
      },
      pickDemoState: (state: StateCode) => {
        demo.pickState(state);
      },
      stopDemo: () => {
        demo.stop();
      },
      quit: () => {},
    };
    /** Clicks the tray's 示範模式 item `id`, as demo mode shows it now. */
    const click = (id: string) => {
      const submenu = trayMenuTemplate(actions, demo.view()).find(
        (item) => item.id === 'demo',
      )?.submenu;
      const item = Array.isArray(submenu)
        ? submenu.find((entry) => entry.id === id)
        : undefined;
      if (typeof item?.click !== 'function') {
        throw new Error(`no item ${id}`);
      }
      (item.click as () => void)();
    };
    const emit = (sessionKey: SessionKey, type: 'session.start') => {
      context?.emit([
        detectionEventSchema.parse({
          type,
          source: 'claude-code',
          sessionKey,
          ts: clock.wall(),
          via: 'log',
          confidence: confidenceFor('log'),
        }),
      ]);
    };
    const ready = () => {
      context?.emit([{ type: 'sync.ready', source: 'claude-code' }], 'ok');
    };
    const cast = () =>
      assigner
        .get()
        .actors.map((actor) => [
          actor.sessionKey,
          actor.characterKey,
          actor.actorId,
          actor.state,
        ]);
    return { detection, demo, settings, store, click, emit, ready, cast };
  }

  it('示範力天使: picking it clears the stage, every state then plays on it alone, and 關閉 brings the real sessions back with their characters', () => {
    const { demo, settings, click, emit, ready, cast } = wire();
    ready();
    emit('claude-code:aaaa1111', 'session.start');
    emit('claude-code:bbbb2222', 'session.start');
    emit('claude-code:cccc3333', 'session.start');
    const before = cast().map(([key, character]) => [key, character]);
    expect(before).toStrictEqual([
      ['claude-code:aaaa1111', PROBE_ONE],
      ['claude-code:bbbb2222', PROBE_TWO],
      ['claude-code:cccc3333', DYNAMES],
    ]);

    click(demoCharacterItemId(DYNAMES));
    expect(cast()).toStrictEqual([['demo:1', DYNAMES, 'actor-4', 'idle']]);
    expect(settings.get().values.demoCharacter).toBe(DYNAMES);
    expect(demo.view().characters[0]?.key).toBe(DYNAMES);

    for (const state of STATE_CODES) {
      click(demoItemId(state));
      expect(cast()).toStrictEqual([['demo:1', DYNAMES, 'actor-4', state]]);
    }

    click(demoItemId(null));
    expect(cast().map(([key, character]) => [key, character])).toStrictEqual(
      before,
    );
    expect(demo.view()).toMatchObject({ on: false, character: DYNAMES });
  });

  it('next time, a state picked while off shows the remembered character at once', () => {
    const { demo, click, ready, cast } = wire();
    ready();
    click(demoCharacterItemId(PROBE_TWO));
    click(demoItemId(null));

    click(demoItemId('approval'));

    expect(cast()).toStrictEqual([
      ['demo:1', PROBE_TWO, 'actor-2', 'approval'],
    ]);
    expect(demo.view()).toMatchObject({ on: true, character: PROBE_TWO });
  });
});
