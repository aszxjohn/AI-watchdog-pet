/**
 * main/detection end to end on fake clocks: the demo adapter, the real
 * sessions and reducer, the sleep clock and settings changes, seen through
 * the `sessions` and `adapters` sections StageView publishes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDetection,
  type Detection,
  watchSleep,
} from '../../src/main/detection/detection';
import type {
  Sessions,
  SessionsOptions,
} from '../../src/main/detection/sessions';
import {
  type AdapterOutput,
  confidenceFor,
  detectionEventSchema,
  type DetectionEvent,
} from '../../src/shared/detection-events';
import {
  SETTINGS_DEFAULTS,
  type SettingsState,
  type SettingsValues,
} from '../../src/shared/settings';
import {
  stageViewSectionsSchema,
  type StageViewDetectionSections,
} from '../../src/shared/stage-view';
import { STATE_CODES, type StateCode } from '../../src/shared/states';
import { fakeClock, type FakeClock } from '../helpers/fake-clock';

/**
 * Every sessions instance createSessions made, and every output an adapter
 * handed it: the demo's events, and those a test feeds as another source.
 */
const captured = vi.hoisted(() => ({
  sessions: [] as Sessions[],
  outputs: [] as AdapterOutput[],
}));

vi.mock('../../src/main/detection/sessions', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/main/detection/sessions')>();
  return {
    ...actual,
    createSessions: (options: SessionsOptions): Sessions => {
      const sessions = actual.createSessions(options);
      const recorded: Sessions = {
        ...sessions,
        receive(output) {
          captured.outputs.push(output);
          sessions.receive(output);
        },
      };
      captured.sessions.push(recorded);
      return recorded;
    },
  };
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let clock: FakeClock;
let settings: ReturnType<typeof fakeSettings>;
let heard: Partial<StageViewDetectionSections>[];
let info: ReturnType<typeof vi.spyOn>;

/** main/settings as detection sees it; set() patches and notifies. */
function fakeSettings() {
  let state: SettingsState = { rev: 0, values: { ...SETTINGS_DEFAULTS } };
  const listeners = new Set<(next: SettingsState) => void>();
  return {
    get: () => state,
    onChange(listener: (next: SettingsState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(changes: Partial<SettingsValues>) {
      state = { rev: state.rev + 1, values: { ...state.values, ...changes } };
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

beforeEach(() => {
  clock = fakeClock();
  settings = fakeSettings();
  heard = [];
  captured.sessions = [];
  captured.outputs = [];
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function start(): Detection {
  const detection = createDetection({
    settings,
    monotonic: clock.monotonic,
    wall: clock.wall,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  detection.onChange((sections) => {
    heard.push(sections);
  });
  return detection;
}

/** The one sessions instance the detection under test made. */
function sessionsOf(): Sessions {
  const [sessions] = captured.sessions;
  if (sessions === undefined || captured.sessions.length !== 1) {
    throw new Error('expected exactly one sessions instance');
  }
  return sessions;
}

/** `<key> <state>` per session, `(inferred)` when inferred. */
function states(detection: Detection): string[] {
  return detection
    .get()
    .sessions.map(
      (session) =>
        `${session.sessionKey} ${session.state}${session.confidence === 'inferred' ? ' (inferred)' : ''}`,
    );
}

/** A live codex event, as a codex adapter would send it. */
function codex(
  type: DetectionEvent['type'],
  fields: Record<string, unknown> = {},
  via: 'log' | 'inferred' = 'log',
): DetectionEvent {
  return detectionEventSchema.parse({
    type,
    source: 'codex',
    sessionKey: 'codex:s1',
    ts: clock.wall(),
    via,
    confidence: confidenceFor(via),
    ...fields,
  });
}

/** Feeds `outputs` to the sessions, as another adapter would. */
function feed(...outputs: AdapterOutput[]): void {
  for (const output of outputs) {
    sessionsOf().receive(output);
  }
}

function demoSession(state: StateCode) {
  return {
    sessionKey: 'demo:1',
    source: 'demo',
    displayName: '示範',
    state,
    confidence: 'exact',
  };
}

const DEMO_ADAPTER = { source: 'demo', health: 'ok' };

function detectionLines(): string[] {
  return info.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((text: string) => text.startsWith('[detection] '));
}

describe('at start', () => {
  it('has no session and no adapter: demo mode is off', () => {
    const detection = start();
    expect(detection.get()).toStrictEqual({ sessions: [], adapters: [] });
    expect(clock.pendingCount()).toBe(0);
    expect(heard).toStrictEqual([]);
  });
});

describe('I/O matrix', () => {
  it('打開示範模式: one 示範 session in 要你批准, and demo in adapters with health ok, in one change', () => {
    const detection = start();

    detection.setDemo('approval');

    expect(detection.get()).toStrictEqual({
      sessions: [demoSession('approval')],
      adapters: [DEMO_ADAPTER],
    });
    expect(heard).toStrictEqual([
      { sessions: [demoSession('approval')], adapters: [DEMO_ADAPTER] },
    ]);
    expect(stageViewSectionsSchema.safeParse(detection.get()).success).toBe(
      true,
    );
    expect(detectionLines()).toStrictEqual([
      '[detection] demo mode on: approval',
    ]);
  });

  describe('改選狀態: every one of the 8 states to every other (8 × 8)', () => {
    const pairs = STATE_CODES.flatMap((from) =>
      STATE_CODES.map((to) => [from, to] as const),
    );

    it.each(pairs)('%s -> %s', (from, to) => {
      const detection = start();
      detection.setDemo(from);
      expect(detection.get().sessions).toStrictEqual([demoSession(from)]);
      heard = [];

      detection.setDemo(to);

      expect(detection.get()).toStrictEqual({
        sessions: [demoSession(to)],
        adapters: [DEMO_ADAPTER],
      });
      // One change at most, and never a list without the demo session.
      expect(heard.length).toBeLessThanOrEqual(1);
      for (const change of heard) {
        expect(change).toStrictEqual({ sessions: [demoSession(to)] });
      }

      clock.advance(10 * MINUTE);
      expect(detection.get().sessions).toStrictEqual([demoSession(to)]);
    });
  });

  it.each(STATE_CODES)(
    '維持: %s still holds 3 hours later, past every timing and the session expiry',
    (state) => {
      const detection = start();
      detection.setDemo(state);
      heard = [];

      for (let elapsed = 0; elapsed < 3 * HOUR; elapsed += 7 * MINUTE) {
        clock.advance(7 * MINUTE);
        expect(states(detection)).toStrictEqual([`demo:1 ${state}`]);
      }

      expect(detection.get().sessions).toStrictEqual([demoSession(state)]);
      expect(heard).toStrictEqual([]);
    },
  );

  it('維持: 休息中 holds 3 hours, named 示範, with idleMs 45 min and sessionExpireMs 60 min', () => {
    settings.set({ idleMs: 45 * MINUTE, sessionExpireMs: 60 * MINUTE });
    const detection = start();
    detection.setDemo('idle');
    heard = [];

    for (let elapsed = 0; elapsed < 3 * HOUR; elapsed += MINUTE) {
      clock.advance(MINUTE);
      expect(detection.get().sessions).toStrictEqual([demoSession('idle')]);
    }
    expect(heard).toStrictEqual([]);
  });

  it('休息中 with idleMs not less than sessionExpireMs cannot show: the session ends, with one warning', () => {
    settings.set({ idleMs: 60 * MINUTE, sessionExpireMs: 60 * MINUTE });
    const detection = start();
    detection.setDemo('idle');

    expect(detection.get()).toStrictEqual({
      sessions: [],
      adapters: [DEMO_ADAPTER],
    });
    expect(vi.mocked(console.warn).mock.calls).toStrictEqual([
      [
        '[detection] demo mode: idle cannot hold while idleMs is not less than sessionExpireMs; not repeating',
      ],
    ]);
  });

  it('維持: 做完了 is still 做完了 10 minutes later', () => {
    const detection = start();
    detection.setDemo('done');
    clock.advance(10 * MINUTE);
    expect(detection.get().sessions).toStrictEqual([demoSession('done')]);
  });

  it('休息中: the session ends and comes straight back with the same key, idle, in one change', () => {
    const detection = start();
    detection.setDemo('working');
    heard = [];
    captured.outputs = [];

    detection.setDemo('idle');

    expect(captured.outputs.map((output) => output.type)).toStrictEqual([
      'tool.end',
      'session.end',
      'session.start',
      'session.meta',
    ]);
    expect(detection.get().sessions).toStrictEqual([demoSession('idle')]);
    expect(heard).toStrictEqual([{ sessions: [demoSession('idle')] }]);
  });

  it('關閉示範模式: the session leaves and demo leaves adapters, in one change', () => {
    const detection = start();
    detection.setDemo('approval');
    heard = [];

    detection.setDemo(null);

    expect(detection.get()).toStrictEqual({ sessions: [], adapters: [] });
    expect(heard).toStrictEqual([{ sessions: [], adapters: [] }]);
    expect(clock.pendingCount()).toBe(0);
    expect(detectionLines().at(-1)).toBe('[detection] demo mode off');

    // Off is off: nothing comes back later.
    clock.advance(3 * HOUR);
    expect(detection.get()).toStrictEqual({ sessions: [], adapters: [] });
  });

  it('關閉 when demo mode is already off changes nothing', () => {
    const detection = start();
    detection.setDemo(null);
    expect(heard).toStrictEqual([]);
    expect(detectionLines()).toStrictEqual([]);
  });

  it('on again after off: the same key, a new session', () => {
    const detection = start();
    detection.setDemo('done');
    detection.setDemo(null);
    detection.setDemo('thinking');
    expect(detection.get()).toStrictEqual({
      sessions: [demoSession('thinking')],
      adapters: [DEMO_ADAPTER],
    });
    expect(detectionLines()).toStrictEqual([
      '[detection] demo mode on: done',
      '[detection] demo mode off',
      '[detection] demo mode on: thinking',
    ]);
  });

  it('改計時值: a new doneMs applies at once, with no new event', () => {
    const detection = start();
    feed({ type: 'sync.ready', source: 'codex' }, codex('turn.start'));
    feed(codex('turn.end'));
    clock.advance(3000);
    expect(states(detection)).toStrictEqual(['codex:s1 done']);
    captured.outputs = [];
    heard = [];

    settings.set({ doneMs: 2000 });

    expect(states(detection)).toStrictEqual(['codex:s1 waiting']);
    expect(heard).toHaveLength(1);
    expect(captured.outputs).toStrictEqual([]);
  });

  it('改計時值: a longer doneMs keeps it done longer, at once', () => {
    const detection = start();
    feed({ type: 'sync.ready', source: 'codex' }, codex('turn.start'));
    feed(codex('turn.end'));
    clock.advance(4000);
    settings.set({ doneMs: 10_000 });
    clock.advance(5000);
    expect(states(detection)).toStrictEqual(['codex:s1 done']);
    clock.advance(1000);
    expect(states(detection)).toStrictEqual(['codex:s1 waiting']);
  });

  it.each<[StateCode, Partial<SettingsValues>]>([
    ['done', { doneMs: 1000 }],
    ['done', { doneMs: 60_000 }],
    ['error', { errorHoldMs: 1000 }],
    ['waiting', { idleMs: 60_000 }],
    ['idle', { idleMs: 3_600_000 }],
    ['idle', { idleMs: 60_000 }],
    ['thinking', { sessionExpireMs: 3_600_000 }],
    ['idle', { sessionExpireMs: 3_600_000 }],
    ['idle', { idleMs: 3_000_000, sessionExpireMs: 3_600_000 }],
  ])('demo mode keeps %s when the timings change (%j)', (state, changes) => {
    const detection = start();
    detection.setDemo(state);
    clock.advance(2 * MINUTE);
    heard = [];

    settings.set(changes);

    expect(detection.get().sessions).toStrictEqual([demoSession(state)]);
    for (let elapsed = 0; elapsed < 2 * HOUR; elapsed += 250) {
      clock.advance(250);
      if (detection.get().sessions[0]?.state !== state) {
        throw new Error(`not ${state} ${elapsed + 250} ms later`);
      }
    }
    expect(heard).toStrictEqual([]);
  });

  it('a settings change that is not a timing sends no demo events', () => {
    const detection = start();
    detection.setDemo('idle');
    captured.outputs = [];

    settings.set({ canvasDisplayId: 5 });

    expect(captured.outputs).toStrictEqual([]);
    expect(detection.get().sessions).toStrictEqual([demoSession('idle')]);
  });

  describe('睡眠: asleep 8 hours with the monotonic clock at 0 s', () => {
    it('on resume, the expiry counts the 8 hours: a session silent since then ends', () => {
      const detection = start();
      feed({ type: 'sync.ready', source: 'codex' }, codex('turn.start'));
      feed(codex('turn.end'));
      clock.advance(10_000);
      expect(states(detection)).toStrictEqual(['codex:s1 waiting']);

      detection.suspend();
      clock.sleep(8 * HOUR);
      // Nothing has run yet: the timers did not move.
      expect(states(detection)).toStrictEqual(['codex:s1 waiting']);
      heard = [];

      detection.resume();

      expect(states(detection)).toStrictEqual([]);
      expect(heard).toStrictEqual([{ sessions: [] }]);
      expect(detectionLines()).toContain(
        '[detection] resumed: added 28800000 ms of sleep to the detection clock',
      );
    });

    it('on resume, idle counts the sleep: 10 minutes asleep is idle', () => {
      const detection = start();
      feed({ type: 'sync.ready', source: 'codex' }, codex('turn.start'));
      feed(codex('turn.end'));
      clock.advance(10_000);

      detection.suspend();
      clock.sleep(10 * MINUTE);
      detection.resume();

      expect(states(detection)).toStrictEqual(['codex:s1 idle']);
    });

    it('without the sleep added, the same session would still be waiting', () => {
      const detection = start();
      feed({ type: 'sync.ready', source: 'codex' }, codex('turn.start'));
      feed(codex('turn.end'));
      clock.advance(10_000);

      // No suspend: a resume alone adds nothing.
      clock.sleep(10 * MINUTE);
      detection.resume();

      expect(states(detection)).toStrictEqual(['codex:s1 waiting']);
      expect(detectionLines()).toContain(
        '[detection] resumed with no suspend before it; the detection clock is unchanged',
      );
    });

    it('a later event starts the session again', () => {
      const detection = start();
      feed({ type: 'sync.ready', source: 'codex' }, codex('turn.start'));
      detection.suspend();
      clock.sleep(8 * HOUR);
      detection.resume();
      expect(states(detection)).toStrictEqual([]);

      feed(codex('turn.start'));
      expect(states(detection)).toStrictEqual(['codex:s1 thinking']);
    });

    it.each(STATE_CODES)(
      'demo mode still shows %s after the sleep, with no change heard',
      (state) => {
        const detection = start();
        detection.setDemo(state);
        clock.advance(MINUTE);
        heard = [];

        detection.suspend();
        clock.sleep(8 * HOUR);
        detection.resume();

        expect(detection.get().sessions).toStrictEqual([demoSession(state)]);
        expect(heard).toStrictEqual([]);
        clock.advance(HOUR);
        expect(detection.get().sessions).toStrictEqual([demoSession(state)]);
      },
    );
  });

  it('轉接器送推測事件: an inferred event from an adapter is dropped and logged; the session is untouched', () => {
    const detection = start();
    feed(
      { type: 'sync.ready', source: 'codex' },
      codex('tool.start', { toolCallId: 't1', toolName: 'Bash' }),
    );
    heard = [];

    feed(codex('approval.request', { requestId: 't1' }, 'inferred'));

    expect(states(detection)).toStrictEqual(['codex:s1 working']);
    expect(heard).toStrictEqual([]);
    expect(vi.mocked(console.warn).mock.calls).toContainEqual([
      '[detection] dropped an inferred approval.request from the codex adapter (only inference may guess)',
    ]);
  });
});

describe('demo mode goes through sessions and the reducer', () => {
  it('hands every demo output to sessions.receive, starting with sync.ready', () => {
    const detection = start();
    detection.setDemo('approval');
    expect(captured.outputs.map((output) => output.type)).toStrictEqual([
      'sync.ready',
      'session.start',
      'session.meta',
      'turn.start',
      'tool.start',
      'approval.request',
    ]);
    expect(detection.get().sessions).toStrictEqual([demoSession('approval')]);
  });

  it('is published within the sync deadline: demo sends sync.ready itself', () => {
    const detection = start();
    clock.advance(1000);
    detection.setDemo('thinking');
    expect(detection.get().sessions).toStrictEqual([demoSession('thinking')]);
  });
});

describe('listeners', () => {
  it('hear only the sections that changed', () => {
    const detection = start();
    detection.setDemo('done');
    heard = [];

    clock.advance(SETTINGS_DEFAULTS.doneMs);
    detection.setDemo('error');

    expect(heard).toStrictEqual([{ sessions: [demoSession('error')] }]);
  });

  it('a listener that throws is logged and the others still hear', () => {
    const detection = start();
    const later = vi.fn();
    detection.onChange(() => {
      throw new Error('boom');
    });
    detection.onChange(later);

    detection.setDemo('working');

    expect(later).toHaveBeenCalledOnce();
    expect(heard).toHaveLength(1);
    expect(vi.mocked(console.error).mock.calls).toContainEqual([
      '[detection] a sections listener failed (Error)',
    ]);
  });

  it('stop hearing after unsubscribing', () => {
    const detection = start();
    const listener = vi.fn();
    const unsubscribe = detection.onChange(listener);
    unsubscribe();
    detection.setDemo('working');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('stop', () => {
  it('stops the demo and the timers with no further change heard', () => {
    const detection = start();
    detection.setDemo('approval');
    heard = [];

    detection.stop();

    expect(clock.pendingCount()).toBe(0);
    expect(heard).toStrictEqual([]);
  });

  it('afterwards nothing happens', () => {
    const detection = start();
    detection.stop();

    detection.setDemo('approval');
    detection.suspend();
    clock.sleep(HOUR);
    detection.resume();
    settings.set({ doneMs: 2000 });
    detection.stop();

    expect(detection.get()).toStrictEqual({ sessions: [], adapters: [] });
    expect(heard).toStrictEqual([]);
    expect(clock.pendingCount()).toBe(0);
    expect(detectionLines()).toStrictEqual([]);
  });
});

describe('watchSleep', () => {
  it('sends suspend and resume to detection', () => {
    const listeners = new Map<string, () => void>();
    const monitor = {
      on(event: 'suspend' | 'resume', listener: () => void) {
        listeners.set(event, listener);
      },
    };
    const target = { suspend: vi.fn(), resume: vi.fn() };

    watchSleep(monitor, target);
    expect([...listeners.keys()]).toStrictEqual(['suspend', 'resume']);

    listeners.get('suspend')?.();
    expect(target.suspend).toHaveBeenCalledOnce();
    expect(target.resume).not.toHaveBeenCalled();
    listeners.get('resume')?.();
    expect(target.resume).toHaveBeenCalledOnce();
  });

  it('wired to a real detection, an 8-hour sleep ends a silent session', () => {
    const listeners = new Map<string, () => void>();
    const detection = start();
    watchSleep(
      {
        on(event: 'suspend' | 'resume', listener: () => void) {
          listeners.set(event, listener);
        },
      },
      detection,
    );
    feed({ type: 'sync.ready', source: 'codex' }, codex('turn.start'));

    listeners.get('suspend')?.();
    clock.sleep(8 * HOUR);
    listeners.get('resume')?.();

    expect(states(detection)).toStrictEqual([]);
  });
});
