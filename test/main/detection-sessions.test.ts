import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSessions,
  type DetectedSession,
  type Sessions,
  type SessionsOptions,
} from '../../src/main/detection/sessions';
import {
  type AdapterOutput,
  confidenceFor,
  type DetectionEvent,
  detectionEventSchema,
  type Via,
} from '../../src/shared/detection-events';
import {
  type DetectionTimings,
  SETTINGS_DEFAULTS,
} from '../../src/shared/settings';
import {
  SOURCE_CAPABILITIES,
  type SourceCapability,
  type SourceCode,
} from '../../src/shared/sources';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Where the fake clocks start; the times below count from here. */
const MONO_START = 50_000;
const WALL_START = 1_762_675_200_000;

/** Most timers one advanceTo may fire before the test gives up. */
const MAX_TIMER_RUNS = 1000;

/**
 * A fake monotonic clock and wall clock that move together, with fake
 * timers on the monotonic one. Times in and out are milliseconds since the
 * start.
 */
function fakeClock() {
  let mono = MONO_START;
  let wall = WALL_START;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();

  return {
    now: () => mono,
    wallNow: () => wall,
    setTimer(run: () => void, delayMs: number): number {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: mono + delayMs, run });
      return id;
    },
    clearTimer(handle: unknown): void {
      timers.delete(handle as number);
    },
    /** When each timer set is due, earliest first. */
    pending(): number[] {
      return [...timers.values()]
        .map((timer) => timer.at - MONO_START)
        .sort((a, b) => a - b);
    },
    /**
     * Moves both clocks to `elapsed`, firing each timer due by then at its
     * own time, in time order.
     */
    advanceTo(elapsed: number): void {
      const end = MONO_START + elapsed;
      for (let runs = 0; ; runs += 1) {
        if (runs > MAX_TIMER_RUNS) {
          throw new Error('timers keep firing');
        }
        let next: [number, { at: number; run: () => void }] | undefined;
        for (const entry of timers) {
          if (
            entry[1].at <= end &&
            (next === undefined || entry[1].at < next[1].at)
          ) {
            next = entry;
          }
        }
        if (next === undefined) {
          break;
        }
        timers.delete(next[0]);
        wall += next[1].at - mono;
        mono = next[1].at;
        next[1].run();
      }
      wall += end - mono;
      mono = end;
    },
    /**
     * Moves both clocks to `elapsed` without firing anything: the timers
     * run late, as after the system slept.
     */
    skipTo(elapsed: number): void {
      wall += MONO_START + elapsed - mono;
      mono = MONO_START + elapsed;
    },
  };
}

let clock: ReturnType<typeof fakeClock>;
let timings: DetectionTimings;
let notifications: (readonly DetectedSession[])[];
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  clock = fakeClock();
  timings = { ...SETTINGS_DEFAULTS };
  notifications = [];
  consoleSpies = (['info', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Every `[detection]` console line so far, at any level. */
function detectionLines(): string[] {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls.map((call: unknown[]) => String(call[0])))
    .filter((line) => line.startsWith('[detection] '));
}

/** Sessions on the fake clock, with a listener recording every change. */
function start(options: Partial<SessionsOptions> = {}): Sessions {
  const sessions = createSessions({
    timings: () => timings,
    now: clock.now,
    wallNow: clock.wallNow,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options,
  });
  sessions.onChange((list) => {
    notifications.push(list);
  });
  return sessions;
}

interface Who {
  readonly source?: SourceCode;
  readonly id?: string;
  readonly via?: Via;
}

/** A live event, through the shared schema, stamped with the wall clock. */
function ev(
  type: DetectionEvent['type'],
  fields: Record<string, unknown> = {},
  { source = 'codex', id = 's1', via = 'log' }: Who = {},
): DetectionEvent {
  return detectionEventSchema.parse({
    type,
    source,
    sessionKey: `${source}:${id}`,
    ts: clock.wallNow(),
    via,
    confidence: confidenceFor(via),
    ...fields,
  });
}

/** The same event replayed from a record written `agoMs` ago. */
function replay(event: DetectionEvent, agoMs: number): DetectionEvent {
  return detectionEventSchema.parse({
    ...event,
    ts: clock.wallNow() - agoMs,
    replay: true,
  });
}

function syncReady(source: SourceCode = 'codex'): AdapterOutput {
  return { type: 'sync.ready', source };
}

/** `<key> <state>` per session, `(inferred)` appended when inferred. */
function states(list: readonly DetectedSession[]): string[] {
  return list.map(
    (session) =>
      `${session.sessionKey} ${session.state}${session.confidence === 'inferred' ? ' (inferred)' : ''}`,
  );
}

/** What every notification so far said, in order. */
function heard(): string[][] {
  return notifications.map(states);
}

describe('I/O matrix', () => {
  it('session.end removes the session and tells subscribers', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('turn.start'));

    sessions.receive(ev('session.end'));

    expect(sessions.list()).toStrictEqual([]);
    expect(heard()).toStrictEqual([['codex:s1 thinking'], []]);
    expect(clock.pending()).toStrictEqual([]);
  });

  it('a session ends sessionExpireMs after its last event, even mid-turn', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('turn.start'));

    clock.advanceTo(2 * HOUR - 1);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 thinking']);
    expect(clock.pending()).toStrictEqual([2 * HOUR]);

    clock.advanceTo(2 * HOUR);
    expect(sessions.list()).toStrictEqual([]);
    // The timer at the idle time changed nothing, so it told no one.
    expect(heard()).toStrictEqual([['codex:s1 thinking'], []]);
    expect(clock.pending()).toStrictEqual([]);
  });

  it('an event past the expiry starts a new session even before the timer fires', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('session.meta', { displayName: 'gundam-pet' }));
    sessions.receive(ev('tool.start', { toolCallId: 'a', toolName: 'Bash' }));
    sessions.receive(ev('approval.request', { requestId: 'a' }));
    expect(states(sessions.list())).toStrictEqual(['codex:s1 approval']);

    // No timer fires on the way (not even the idle check at 300000).
    clock.skipTo(2 * HOUR);
    sessions.receive(ev('activity'));

    // Not `approval` or `working`: the old open tool and approval are gone.
    expect(sessions.list()).toStrictEqual([
      {
        sessionKey: 'codex:s1',
        source: 'codex',
        displayName: null,
        state: 'waiting',
        confidence: 'exact',
      },
    ]);
    expect(clock.pending()).toStrictEqual([2 * HOUR + 300_000]);
  });

  it('an event for an ended key starts a new session', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('session.meta', { displayName: 'gundam-pet' }));
    sessions.receive(ev('tool.start', { toolCallId: 'a', toolName: 'Bash' }));
    sessions.receive(ev('session.end'));
    expect(sessions.list()).toStrictEqual([]);

    sessions.receive(ev('turn.start'));

    // Not `working`: the old session's open tool went with it.
    expect(sessions.list()).toStrictEqual([
      {
        sessionKey: 'codex:s1',
        source: 'codex',
        displayName: null,
        state: 'thinking',
        confidence: 'exact',
      },
    ]);
  });

  it('turn.end on a synced source: done at once, waiting when the timer fires', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('turn.start'));
    clock.advanceTo(1000);

    sessions.receive(ev('turn.end'));

    expect(states(sessions.list())).toStrictEqual(['codex:s1 done']);
    expect(clock.pending()).toStrictEqual([6000]);
    clock.advanceTo(5999);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 done']);
    clock.advanceTo(6000);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 waiting']);
    expect(clock.pending()).toStrictEqual([301_000]);
    clock.advanceTo(301_000);
    expect(heard()).toStrictEqual([
      ['codex:s1 thinking'],
      ['codex:s1 done'],
      ['codex:s1 waiting'],
      ['codex:s1 idle'],
    ]);
  });

  it('a replayed turn.end shows no done', () => {
    const sessions = start();
    sessions.receive(replay(ev('turn.start'), 3000));
    sessions.receive(replay(ev('turn.end'), 1000));

    sessions.receive(syncReady());

    expect(heard()).toStrictEqual([['codex:s1 waiting']]);

    // Nor when it arrives after the source synced.
    sessions.receive(replay(ev('turn.start', {}, { id: 's2' }), 500));
    sessions.receive(replay(ev('turn.end', {}, { id: 's2' }), 0));
    expect(heard()).toStrictEqual([
      ['codex:s1 waiting'],
      ['codex:s1 waiting', 'codex:s2 thinking'],
      ['codex:s1 waiting', 'codex:s2 waiting'],
    ]);
  });

  it('a replayed error shows no error', () => {
    const sessions = start();
    sessions.receive(replay(ev('turn.end'), 2000));
    sessions.receive(replay(ev('error'), 1000));

    sessions.receive(syncReady());
    sessions.receive(replay(ev('error'), 0));

    expect(heard()).toStrictEqual([['codex:s1 waiting']]);
  });

  it('a session replayed from 10 minutes ago is idle when published', () => {
    const sessions = start();
    sessions.receive(replay(ev('turn.start'), 12 * MINUTE));
    sessions.receive(replay(ev('turn.end'), 10 * MINUTE));

    sessions.receive(syncReady());

    expect(heard()).toStrictEqual([['codex:s1 idle']]);
    // Only its expiry is left: last event 10 minutes ago, plus 2 hours.
    expect(clock.pending()).toStrictEqual([110 * MINUTE]);
  });

  it('a session replayed from 3 hours ago expires without being published', () => {
    const sessions = start();
    sessions.receive(replay(ev('turn.end'), 3 * HOUR));
    sessions.receive(replay(ev('turn.end', {}, { id: 's2' }), 10 * MINUTE));

    sessions.receive(syncReady());

    expect(heard()).toStrictEqual([['codex:s2 idle']]);
    expect(clock.pending()).toStrictEqual([110 * MINUTE]);
  });

  it('a live event is timed from receipt, however old its ts', () => {
    const sessions = start();
    sessions.receive(syncReady());

    sessions.receive(ev('turn.end', { ts: clock.wallNow() - 10 * MINUTE }));

    expect(states(sessions.list())).toStrictEqual(['codex:s1 done']);
    expect(clock.pending()).toStrictEqual([5000]);
  });

  it('a replayed ts in the future counts as just received', () => {
    const sessions = start();
    sessions.receive(replay(ev('activity'), -MINUTE));
    sessions.receive(syncReady());

    expect(states(sessions.list())).toStrictEqual(['codex:s1 waiting']);
    expect(clock.pending()).toStrictEqual([300_000]);
    clock.advanceTo(299_999);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 waiting']);
    clock.advanceTo(300_000);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 idle']);
  });

  it('before sync.ready a source is not published and has no timer of its own', () => {
    const sessions = start();
    sessions.receive(syncReady('gemini'));
    sessions.receive(ev('turn.start'));
    sessions.receive(replay(ev('turn.start', {}, { id: 's2' }), 5000));
    clock.advanceTo(1000);
    sessions.receive(ev('turn.end'));
    sessions.receive(ev('turn.end', {}, { source: 'gemini', id: 'g1' }));

    expect(states(sessions.list())).toStrictEqual(['gemini:g1 done']);
    // gemini's done, and the sync deadline; nothing for codex's done at 6000.
    expect(clock.pending()).toStrictEqual([6000]);
    clock.advanceTo(6000);
    expect(clock.pending()).toStrictEqual([10_000]);
    clock.advanceTo(9999);
    expect(heard()).toStrictEqual([['gemini:g1 done'], ['gemini:g1 waiting']]);

    // At the deadline codex is published as it is then: its live done is
    // over, its replayed turn still open.
    clock.advanceTo(10_000);
    expect(heard().at(-1)).toStrictEqual([
      'codex:s1 waiting',
      'codex:s2 thinking',
      'gemini:g1 waiting',
    ]);
  });

  it('sync.ready publishes the source at once, in one notification, and starts its timers', () => {
    const sessions = start();
    sessions.receive(replay(ev('turn.start'), MINUTE));
    sessions.receive(replay(ev('activity', {}, { id: 's2' }), 2 * MINUTE));
    sessions.receive(
      replay(ev('session.meta', { displayName: 'proj' }, { id: 's2' }), 0),
    );
    sessions.receive(
      replay(ev('turn.start', {}, { source: 'claude-code', id: 'c1' }), 0),
    );
    expect(clock.pending()).toStrictEqual([10_000]);

    sessions.receive(syncReady());

    expect(heard()).toStrictEqual([['codex:s1 thinking', 'codex:s2 waiting']]);
    expect(sessions.list()[1]?.displayName).toBe('proj');
    // claude-code has not synced yet; its deadline comes first.
    expect(clock.pending()).toStrictEqual([10_000]);
    sessions.receive(syncReady('claude-code'));
    expect(heard()).toHaveLength(2);
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 thinking',
      'codex:s2 waiting',
      'claude-code:c1 thinking',
    ]);
    // s2: last event 2 minutes ago, idle 5 minutes after it.
    expect(clock.pending()).toStrictEqual([3 * MINUTE]);
  });

  it('a source that never sends sync.ready counts as synced after syncTimeoutMs', () => {
    const sessions = start();
    sessions.receive(replay(ev('turn.start'), MINUTE));

    clock.advanceTo(9999);
    expect(sessions.list()).toStrictEqual([]);
    clock.advanceTo(10_000);
    expect(heard()).toStrictEqual([['codex:s1 thinking']]);

    // A source first heard of after the deadline is published at once.
    clock.advanceTo(20_000);
    sessions.receive(ev('turn.start', {}, { source: 'cursor', id: 'k1' }));
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 thinking',
      'cursor:k1 thinking',
    ]);
  });

  it('changing doneMs mid-done re-times at once: waiting only after the new doneMs', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('turn.end'));
    expect(clock.pending()).toStrictEqual([5000]);

    clock.advanceTo(2000);
    timings = { ...timings, doneMs: 10_000 };
    sessions.retime();

    expect(clock.pending()).toStrictEqual([10_000]);
    clock.advanceTo(9999);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 done']);
    clock.advanceTo(10_000);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 waiting']);
    expect(heard()).toStrictEqual([['codex:s1 done'], ['codex:s1 waiting']]);
  });

  it('drops an output that fails the schema and logs only its field paths', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('turn.start'));
    const bad: unknown[] = [
      { ...ev('turn.end'), sessionKey: 'gemini:secret-id', message: 'secret' },
      { ...ev('error'), via: 'inferred' },
      { ...ev('turn.end'), ts: -5, replay: false },
      { type: 'tool.progress', note: 'secret' },
      { type: 'sync.ready', source: 'secret-source' },
      null,
    ];

    for (const output of bad) {
      sessions.receive(output as AdapterOutput);
    }

    expect(states(sessions.list())).toStrictEqual(['codex:s1 thinking']);
    expect(heard()).toHaveLength(1);
    const dropped = (fields: string) =>
      `[detection] dropped an adapter output that fails the schema (fields: ${fields})`;
    expect(detectionLines()).toStrictEqual([
      dropped('message, sessionKey'),
      dropped('confidence'),
      dropped('ts, replay'),
      dropped('type'),
      dropped('source'),
      dropped('(root)'),
    ]);
    expect(detectionLines().join('\n')).not.toContain('secret');
  });
});

describe('an inferred event from an adapter (Story 2.3)', () => {
  it.each<[string, () => DetectionEvent]>([
    [
      'an approval request',
      () => ev('approval.request', { requestId: 'a' }, { via: 'inferred' }),
    ],
    [
      'a question request',
      () => ev('question.request', { requestId: 'a' }, { via: 'inferred' }),
    ],
    ['an activity', () => ev('activity', {}, { via: 'inferred' })],
    ['a session end', () => ev('session.end', {}, { via: 'inferred' })],
  ])(
    'drops %s and logs its type and source only; the session is untouched',
    (_label, make) => {
      const sessions = start();
      sessions.receive(syncReady());
      sessions.receive(ev('tool.start', { toolCallId: 'a', toolName: 'Bash' }));
      const before = sessions.list();
      const event = make();

      sessions.receive(event);

      expect(sessions.list()).toBe(before);
      expect(states(sessions.list())).toStrictEqual(['codex:s1 working']);
      expect(heard()).toHaveLength(1);
      expect(detectionLines()).toStrictEqual([
        `[detection] dropped an inferred ${event.type} from the codex adapter (only inference may guess)`,
      ]);
    },
  );

  it('starts no session', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(
      ev('approval.request', { requestId: 'a' }, { via: 'inferred' }),
    );
    expect(sessions.list()).toStrictEqual([]);
    expect(heard()).toStrictEqual([]);
  });

  it("does not move the session's last-event time", () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('turn.start'));
    sessions.receive(ev('turn.end'));
    clock.advanceTo(timings.idleMs - 1);
    sessions.receive(ev('activity', {}, { via: 'inferred' }));
    clock.advanceTo(timings.idleMs);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 idle']);
  });

  it("inference's own guesses still apply", () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('tool.start', { toolCallId: 'a', toolName: 'Bash' }));
    clock.advanceTo(timings.approvalInferMs);
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 approval (inferred)',
    ]);
    expect(detectionLines()).toStrictEqual([]);
  });
});

/** A tool call starting, on codex unless `who` says otherwise. */
function toolStart(toolCallId = 'a', toolName = 'Bash', who: Who = {}) {
  return ev('tool.start', { toolCallId, toolName }, who);
}

/** Codex with a question tool, as Story 2.5 may fill it in. */
const CODEX_ASKING: SourceCapability = {
  approval: 'none',
  question: 'none',
  questionTools: ['ask_user'],
};

describe('inference I/O matrix', () => {
  it('a tool not over after approvalInferMs: working before, approval (inferred) at it', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(toolStart());
    expect(clock.pending()).toStrictEqual([10_000]);

    clock.advanceTo(9999);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 working']);
    clock.advanceTo(10_000);
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 approval (inferred)',
    ]);
    expect(heard()).toStrictEqual([
      ['codex:s1 working'],
      ['codex:s1 approval (inferred)'],
    ]);
    // The guess is not the session's last event: idle still counts from 0.
    expect(clock.pending()).toStrictEqual([300_000]);
  });

  it('tool.end at 9 seconds: no approval', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(toolStart());
    clock.advanceTo(9000);

    sessions.receive(ev('tool.end', { toolCallId: 'a' }));

    expect(clock.pending()).toStrictEqual([309_000]);
    clock.advanceTo(60_000);
    expect(heard()).toStrictEqual([['codex:s1 working'], ['codex:s1 waiting']]);
  });

  it('tool.end after the guess: the approval goes', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(toolStart());
    clock.advanceTo(12_000);

    sessions.receive(ev('tool.end', { toolCallId: 'a' }));

    expect(heard()).toStrictEqual([
      ['codex:s1 working'],
      ['codex:s1 approval (inferred)'],
      ['codex:s1 waiting'],
    ]);
  });

  it('an exact approval.request with the same id after the guess: still approval, now exact', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(toolStart());
    clock.advanceTo(10_500);

    sessions.receive(ev('approval.request', { requestId: 'a' }));

    expect(heard()).toStrictEqual([
      ['codex:s1 working'],
      ['codex:s1 approval (inferred)'],
      ['codex:s1 approval'],
    ]);
  });

  it('an exact request with the same id within approvalInferMs: no guess', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(toolStart());
    sessions.receive(toolStart('b', 'Bash', { id: 's2' }));
    clock.advanceTo(2000);
    sessions.receive(ev('approval.request', { requestId: 'a' }));
    sessions.receive(ev('approval.request', { requestId: 'b' }, { id: 's2' }));
    clock.advanceTo(3000);
    sessions.receive(ev('approval.resolved', { requestId: 'b' }, { id: 's2' }));

    clock.advanceTo(60_000);

    // s1's exact approval stays exact; s2's tool keeps running unguessed.
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 approval',
      'codex:s2 working',
    ]);
    expect(heard()).toStrictEqual([
      ['codex:s1 working'],
      ['codex:s1 working', 'codex:s2 working'],
      ['codex:s1 approval', 'codex:s2 working'],
      ['codex:s1 approval', 'codex:s2 approval'],
      ['codex:s1 approval', 'codex:s2 working'],
    ]);
    expect(clock.pending()).toStrictEqual([302_000]);
  });

  it('approval.resolved after the guess while the tool keeps running: working, and no second guess', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(toolStart());
    clock.advanceTo(15_000);

    sessions.receive(ev('approval.resolved', { requestId: 'a' }));

    expect(states(sessions.list())).toStrictEqual(['codex:s1 working']);
    expect(clock.pending()).toStrictEqual([315_000]);
    clock.advanceTo(200_000);
    expect(heard()).toStrictEqual([
      ['codex:s1 working'],
      ['codex:s1 approval (inferred)'],
      ['codex:s1 working'],
    ]);
  });

  it('a question tool, questions not readable: decision (inferred) at approvalInferMs', () => {
    const sessions = start({
      capabilityOf: (source) =>
        source === 'codex' ? CODEX_ASKING : SOURCE_CAPABILITIES[source],
    });
    sessions.receive(syncReady());
    sessions.receive(toolStart('ask', 'ask_user'));
    sessions.receive(toolStart('a', 'Bash', { id: 's2' }));

    clock.advanceTo(9999);
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 working',
      'codex:s2 working',
    ]);
    clock.advanceTo(10_000);
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 decision (inferred)',
      'codex:s2 approval (inferred)',
    ]);
  });

  it('claude-code (exact): a tool running for 10 seconds stays working', () => {
    const sessions = start();
    const who = { source: 'claude-code', id: 'c1' } as const;
    sessions.receive(syncReady('claude-code'));
    sessions.receive(toolStart('a', 'Bash', who));
    sessions.receive(toolStart('q', 'AskUserQuestion', who));
    expect(clock.pending()).toStrictEqual([300_000]);

    clock.advanceTo(200_000);

    expect(heard()).toStrictEqual([['claude-code:c1 working']]);
  });

  it('a replayed tool.start 3 minutes ago, never ended: approval (inferred) when sync.ready publishes it', () => {
    const sessions = start();
    sessions.receive(replay(ev('turn.start'), 3 * MINUTE + 1000));
    sessions.receive(replay(toolStart(), 3 * MINUTE));

    sessions.receive(syncReady());

    expect(heard()).toStrictEqual([['codex:s1 approval (inferred)']]);
    // idle 5 minutes after the replayed tool.start, not after the guess.
    expect(clock.pending()).toStrictEqual([2 * MINUTE]);
  });

  it('before sync.ready: a tool past approvalInferMs is not guessed at or published', () => {
    timings = { ...timings, syncTimeoutMs: 60_000 };
    const sessions = start();
    sessions.receive(toolStart());
    expect(clock.pending()).toStrictEqual([60_000]);

    clock.advanceTo(30_000);
    expect(sessions.list()).toStrictEqual([]);
    expect(heard()).toStrictEqual([]);
    // Only the sync deadline: no timer for the guess.
    expect(clock.pending()).toStrictEqual([60_000]);

    sessions.receive(syncReady());
    expect(heard()).toStrictEqual([['codex:s1 approval (inferred)']]);
  });

  it('approvalInferMs changed to 30 seconds at 5 seconds: approval only at 30 seconds', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(toolStart());
    clock.advanceTo(5000);

    timings = { ...timings, approvalInferMs: 30_000 };
    sessions.retime();

    expect(clock.pending()).toStrictEqual([30_000]);
    clock.advanceTo(29_999);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 working']);
    clock.advanceTo(30_000);
    expect(heard()).toStrictEqual([
      ['codex:s1 working'],
      ['codex:s1 approval (inferred)'],
    ]);
  });
});

describe('inference', () => {
  it('a threshold lowered below a running tool call guesses at once', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(toolStart());
    clock.advanceTo(5000);

    timings = { ...timings, approvalInferMs: 3000 };
    sessions.retime();

    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 approval (inferred)',
    ]);
  });

  it('a guess already made stays when the threshold goes up', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(toolStart());
    clock.advanceTo(15_000);

    timings = { ...timings, approvalInferMs: 60_000 };
    sessions.retime();
    clock.advanceTo(30_000);

    expect(heard()).toStrictEqual([
      ['codex:s1 working'],
      ['codex:s1 approval (inferred)'],
    ]);
  });

  it('shares the one timer with every other change', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('turn.end'));
    clock.advanceTo(2000);
    sessions.receive(toolStart('a', 'Bash', { id: 's2' }));
    clock.advanceTo(3000);
    sessions.receive(toolStart('b', 'Bash', { id: 's2' }));

    const due: number[][] = [];
    for (const at of [3000, 5000, 12_000, 13_000]) {
      clock.advanceTo(at);
      due.push(clock.pending());
    }

    expect(due).toStrictEqual([
      [5000], // s1: done ends
      [12_000], // s2: tool a guessed at
      [13_000], // s2: tool b guessed at
      [300_000], // s1: idle
    ]);
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 waiting',
      'codex:s2 approval (inferred)',
    ]);
  });

  it('a guess does not keep a session from expiring', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(toolStart());
    clock.advanceTo(10_000);
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 approval (inferred)',
    ]);

    clock.advanceTo(2 * HOUR - 1);
    expect(sessions.list()).toHaveLength(1);
    clock.advanceTo(2 * HOUR);
    expect(sessions.list()).toStrictEqual([]);
  });

  it('uses SOURCE_CAPABILITIES by default: gemini and cursor are guessed at, demo is not', () => {
    const sessions = start();
    for (const source of ['gemini', 'cursor', 'demo'] as const) {
      sessions.receive(syncReady(source));
      sessions.receive(toolStart('a', 'Bash', { source, id: 'x' }));
    }

    clock.advanceTo(10_000);

    expect(states(sessions.list())).toStrictEqual([
      'gemini:x approval (inferred)',
      'cursor:x approval (inferred)',
      'demo:x working',
    ]);
  });
});

describe('subscribers', () => {
  it('one that throws does not stop the others, and is logged as a detection error', () => {
    const sessions = start();
    const failing = vi.fn(() => {
      throw new TypeError('secret detail');
    });
    const after = vi.fn();
    sessions.onChange(failing);
    sessions.onChange(after);

    sessions.receive(syncReady());
    sessions.receive(ev('turn.start'));

    expect(failing).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledExactlyOnceWith(sessions.list());
    expect(heard()).toStrictEqual([['codex:s1 thinking']]);
    expect(consoleSpies[2]?.mock.calls).toStrictEqual([
      ['[detection] a change listener failed (TypeError)'],
    ]);
  });

  it('hear only real changes: an event or timer that changes nothing is silent', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('activity'));
    clock.advanceTo(1000);
    sessions.receive(ev('activity'));
    sessions.receive(ev('approval.resolved', { requestId: 'nothing' }));
    sessions.retime();

    expect(heard()).toStrictEqual([['codex:s1 waiting']]);
  });

  it('hear a new display name and a confidence change', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('tool.start', { toolCallId: 'r', toolName: 'Bash' }));
    // codex cannot read approvals: inference guesses one.
    clock.advanceTo(timings.approvalInferMs);
    sessions.receive(ev('session.meta', { displayName: 'gundam-pet' }));
    sessions.receive(ev('approval.request', { requestId: 'r' }));

    expect(heard()).toStrictEqual([
      ['codex:s1 working'],
      ['codex:s1 approval (inferred)'],
      ['codex:s1 approval (inferred)'],
      ['codex:s1 approval'],
    ]);
    expect(notifications.map((list) => list[0]?.displayName)).toStrictEqual([
      null,
      null,
      'gundam-pet',
      'gundam-pet',
    ]);
  });

  it('stop hearing after unsubscribing', () => {
    const sessions = start();
    const listener = vi.fn();
    const unsubscribe = sessions.onChange(listener);
    sessions.receive(syncReady());
    sessions.receive(ev('turn.start'));
    unsubscribe();

    sessions.receive(ev('turn.end'));

    expect(listener).toHaveBeenCalledOnce();
    expect(heard()).toHaveLength(2);
  });

  it('a subscriber that feeds an event back does not leave the others with an older list', () => {
    const sessions = start();
    const seen: string[][] = [];
    sessions.onChange((list) => {
      if (list.length === 1 && list[0]?.state === 'thinking') {
        sessions.receive(
          ev('tool.start', { toolCallId: 'a', toolName: 'Bash' }),
        );
      }
    });
    sessions.onChange((list) => {
      seen.push(states(list));
    });
    sessions.receive(syncReady());

    sessions.receive(ev('turn.start'));

    expect(seen).toStrictEqual([['codex:s1 working']]);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 working']);
  });
});

describe('the list', () => {
  it('is frozen, in first-seen order; a key that ends and returns goes last', () => {
    const sessions = start();
    sessions.receive(syncReady());
    for (const id of ['a', 'b', 'c']) {
      sessions.receive(ev('activity', {}, { id }));
    }
    sessions.receive(ev('turn.start', {}, { id: 'a' }));
    expect(states(sessions.list())).toStrictEqual([
      'codex:a thinking',
      'codex:b waiting',
      'codex:c waiting',
    ]);

    sessions.receive(ev('session.end', {}, { id: 'a' }));
    sessions.receive(ev('activity', {}, { id: 'a' }));

    const list = sessions.list();
    expect(states(list)).toStrictEqual([
      'codex:b waiting',
      'codex:c waiting',
      'codex:a waiting',
    ]);
    expect(Object.isFrozen(list)).toBe(true);
    expect(list.every((session) => Object.isFrozen(session))).toBe(true);
  });

  it('a session.end for a key never seen changes nothing', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('session.end'));

    expect(sessions.list()).toStrictEqual([]);
    expect(heard()).toStrictEqual([]);
    expect(clock.pending()).toStrictEqual([]);
  });

  it('a session that ends before its source syncs is never published', () => {
    const sessions = start();
    sessions.receive(replay(ev('turn.start'), 1000));
    sessions.receive(replay(ev('session.end'), 500));
    expect(clock.pending()).toStrictEqual([]);

    sessions.receive(syncReady());

    expect(heard()).toStrictEqual([]);
  });
});

describe('one timer', () => {
  it('is set for the earliest change or expiry of any published session', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('turn.end', {}, { id: 'a' }));
    clock.advanceTo(1000);
    sessions.receive(ev('error', {}, { id: 'b' }));
    clock.advanceTo(2000);
    sessions.receive(ev('turn.start', {}, { id: 'c' }));

    const due: number[][] = [];
    for (const at of [2000, 5000, 31_000, 300_000, 301_000, 302_000]) {
      clock.advanceTo(at);
      due.push(clock.pending());
    }

    expect(due).toStrictEqual([
      [5000], // a: done ends
      [31_000], // b: error hold ends
      [300_000], // a: idle
      [301_000], // b: idle
      [302_000], // c: idle (no change: thinking)
      [2 * HOUR], // a: expiry
    ]);
    expect(states(sessions.list())).toStrictEqual([
      'codex:a idle',
      'codex:b idle',
      'codex:c thinking',
    ]);
    clock.advanceTo(2 * HOUR + 2000);
    expect(sessions.list()).toStrictEqual([]);
    expect(clock.pending()).toStrictEqual([]);
  });

  it('retime applies every timing at once', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('activity'));
    clock.advanceTo(2 * MINUTE);

    timings = { ...timings, idleMs: MINUTE };
    sessions.retime();
    expect(states(sessions.list())).toStrictEqual(['codex:s1 idle']);
    expect(clock.pending()).toStrictEqual([2 * HOUR]);

    clock.advanceTo(90 * MINUTE);
    timings = { ...timings, sessionExpireMs: HOUR };
    sessions.retime();
    expect(sessions.list()).toStrictEqual([]);
    expect(clock.pending()).toStrictEqual([]);
  });

  it('retime moves the sync deadline, and publishes at once when it has passed', () => {
    const sessions = start();
    sessions.receive(ev('turn.start'));
    expect(clock.pending()).toStrictEqual([10_000]);

    timings = { ...timings, syncTimeoutMs: 20_000 };
    sessions.retime();
    expect(clock.pending()).toStrictEqual([20_000]);

    clock.advanceTo(15_000);
    expect(sessions.list()).toStrictEqual([]);
    timings = { ...timings, syncTimeoutMs: 5000 };
    sessions.retime();
    expect(heard()).toStrictEqual([['codex:s1 thinking']]);
  });

  it('stop clears it, and nothing is applied afterwards', () => {
    const sessions = start();
    sessions.receive(syncReady());
    sessions.receive(ev('turn.end'));
    expect(clock.pending()).toStrictEqual([5000]);

    sessions.stop();
    sessions.receive(ev('turn.start', {}, { id: 's2' }));
    sessions.retime();
    clock.advanceTo(HOUR);

    expect(clock.pending()).toStrictEqual([]);
    expect(states(sessions.list())).toStrictEqual(['codex:s1 done']);
    expect(heard()).toStrictEqual([['codex:s1 done']]);
  });
});

describe('default clocks and timers', () => {
  it('use performance.now, Date.now and setTimeout', () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
      now: WALL_START,
    });
    const sessions = createSessions({ timings: () => timings });
    sessions.receive(syncReady());
    sessions.receive(replay(ev('activity'), 4 * MINUTE));
    sessions.receive(ev('turn.end', {}, { id: 's2' }));
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 waiting',
      'codex:s2 done',
    ]);

    vi.advanceTimersByTime(5000);
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 waiting',
      'codex:s2 waiting',
    ]);
    vi.advanceTimersByTime(MINUTE - 5000);
    expect(states(sessions.list())).toStrictEqual([
      'codex:s1 idle',
      'codex:s2 waiting',
    ]);

    sessions.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
