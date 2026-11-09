import { describe, expect, it } from 'vitest';
import {
  type DetectionTimings,
  evaluate,
  nextChangeAt,
  reduceSession,
  type SessionConditions,
} from '../../src/main/detection/reducer';
import {
  confidenceFor,
  type DetectionEvent,
  detectionEventSchema,
  type Via,
} from '../../src/shared/detection-events';
import type { StateCode } from '../../src/shared/states';

/** The I/O matrix's example timings. */
const TIMINGS: DetectionTimings = {
  doneMs: 5000,
  idleMs: 300_000,
  errorHoldMs: 30_000,
};

// ---------------------------------------------------------------------------
// Events. Each helper goes through the shared schema, so every event the
// tests feed the reducer is one an adapter could send.

function event(
  type: DetectionEvent['type'],
  fields: Record<string, unknown> = {},
  via: Via = 'log',
): DetectionEvent {
  return detectionEventSchema.parse({
    type,
    source: 'demo',
    sessionKey: 'demo:s1',
    // Deliberately unrelated to the monotonic times below: `ts` must not
    // take part in any duration.
    ts: 1_762_675_200_000,
    via,
    confidence: confidenceFor(via),
    ...fields,
  });
}

const sessionStart = () => event('session.start');
const sessionEnd = () => event('session.end');
const sessionMeta = (displayName: string) =>
  event('session.meta', { displayName });
const turnStart = () => event('turn.start');
const turnEnd = () => event('turn.end');
const toolStart = (toolCallId: string) =>
  event('tool.start', { toolCallId, toolName: 'Bash' });
const toolEnd = (toolCallId: string) => event('tool.end', { toolCallId });
const approvalRequest = (requestId: string, via: Via = 'log') =>
  event('approval.request', { requestId }, via);
const approvalResolved = (requestId: string) =>
  event('approval.resolved', { requestId });
const questionRequest = (requestId: string, via: Via = 'log') =>
  event('question.request', { requestId }, via);
const questionResolved = (requestId: string) =>
  event('question.resolved', { requestId });
const error = () => event('error');
const activity = () => event('activity');

// ---------------------------------------------------------------------------
// Event sequence -> state sequence. A script is a list of steps in time
// order: `[t, event]` feeds the event received at monotonic time t;
// `[t, 'state']` expects that state when evaluated at t, with `exact`
// confidence unless written `'state (inferred)'`.

type Probe = StateCode | `${StateCode} (inferred)`;
type Step = readonly [at: number, step: DetectionEvent | Probe];

function describeState(
  conditions: SessionConditions,
  at: number,
  timings: DetectionTimings,
): Probe {
  const { state, confidence } = evaluate(conditions, at, timings);
  return confidence === 'inferred' ? `${state} (inferred)` : state;
}

/** Feeds the events in order; returns the conditions after the last one. */
function feed(steps: readonly Step[]): SessionConditions {
  let conditions: SessionConditions | undefined;
  for (const [at, step] of steps) {
    if (typeof step !== 'string') {
      conditions = reduceSession(conditions, step, at);
    }
  }
  if (conditions === undefined) {
    throw new Error('the script has no event');
  }
  return conditions;
}

function expectStates(
  steps: readonly Step[],
  timings: DetectionTimings = TIMINGS,
): void {
  let conditions: SessionConditions | undefined;
  const expected: string[] = [];
  const actual: string[] = [];
  for (const [at, step] of steps) {
    if (typeof step === 'string') {
      if (conditions === undefined) {
        throw new Error('a probe comes before any event');
      }
      expected.push(`@${at} ${step}`);
      actual.push(`@${at} ${describeState(conditions, at, timings)}`);
    } else {
      conditions = reduceSession(conditions, step, at);
    }
  }
  expect(actual).toStrictEqual(expected);
}

/** Plain-data copy of the conditions, for equality checks. */
function snapshot(conditions: SessionConditions) {
  return {
    ...conditions,
    openTools: [...conditions.openTools],
    openApprovals: [...conditions.openApprovals],
    openQuestions: [...conditions.openQuestions],
  };
}

/**
 * Which rows of AD-21's condition table hold, before priority is applied.
 * `waiting` here is only "last event within idleMs"; the table's "not in a
 * turn, not in done" part is exactly what priority adds.
 */
function holding(
  c: SessionConditions,
  at: number,
  timings: DetectionTimings,
): StateCode[] {
  const states: StateCode[] = [];
  if (c.openApprovals.size > 0) states.push('approval');
  if (c.openQuestions.size > 0) states.push('decision');
  if (c.errorAt !== null && at - c.errorAt < timings.errorHoldMs) {
    states.push('error');
  }
  if (c.openTools.size > 0) states.push('working');
  if (c.inTurn) states.push('thinking');
  if (c.turnEndedAt !== null && at - c.turnEndedAt < timings.doneMs) {
    states.push('done');
  }
  states.push(at - c.lastEventAt < timings.idleMs ? 'waiting' : 'idle');
  return states;
}

// ---------------------------------------------------------------------------

describe('I/O matrix', () => {
  it.each<[string, Step[]]>([
    [
      'a turn ends: done until doneMs, then waiting, then idle',
      [
        [0, turnStart()],
        [0, 'thinking'],
        [1000, turnEnd()],
        [1000, 'done'],
        [5999, 'done'],
        [6000, 'waiting'],
        [300_999, 'waiting'],
        [301_000, 'idle'],
      ],
    ],
    [
      'parallel tools: working until the last one ends',
      [
        [0, toolStart('a')],
        [0, 'working'],
        [10, toolStart('b')],
        [20, toolEnd('a')],
        [20, 'working'],
        [400_000, 'working'],
        [400_000, toolEnd('b')],
        [400_000, 'waiting'],
      ],
    ],
    [
      'parallel tools in a turn: back to thinking when the last one ends',
      [
        [0, turnStart()],
        [1, toolStart('a')],
        [2, toolStart('b')],
        [3, toolEnd('a')],
        [3, 'working'],
        [4, toolEnd('b')],
        [4, 'thinking'],
      ],
    ],
    [
      'a tool raises an approval: approval until that tool ends',
      [
        [0, toolStart('a')],
        [0, 'working'],
        [1, approvalRequest('a')],
        [1, 'approval'],
        [2, toolEnd('a')],
        [2, 'waiting'],
      ],
    ],
    [
      'a pending question and an error: decision',
      [
        [0, questionRequest('q')],
        [1, error()],
        [1, 'decision'],
      ],
    ],
    [
      'an error and then a pending question: decision',
      [
        [0, error()],
        [1, questionRequest('q')],
        [1, 'decision'],
        [40_000, 'decision'],
      ],
    ],
    [
      'error holds for errorHoldMs, then falls back to waiting',
      [
        [0, error()],
        [0, 'error'],
        [29_999, 'error'],
        [30_000, 'waiting'],
      ],
    ],
    [
      'error holds for errorHoldMs, then falls back to thinking',
      [
        [0, turnStart()],
        [10, error()],
        [10, 'error'],
        [30_009, 'error'],
        [30_010, 'thinking'],
      ],
    ],
    [
      'turn.start clears error at once',
      [
        [0, error()],
        [100, turnStart()],
        [100, 'thinking'],
      ],
    ],
    [
      'tool.start clears error at once',
      [
        [0, error()],
        [100, toolStart('a')],
        [100, 'working'],
        [101, toolEnd('a')],
        [101, 'waiting'],
      ],
    ],
    [
      'other events do not clear error',
      [
        [0, turnStart()],
        [1, error()],
        [2, activity()],
        [3, toolEnd('a')],
        [4, approvalRequest('r')],
        [5, approvalResolved('r')],
        [6, questionRequest('q')],
        [7, questionResolved('q')],
        [8, sessionStart()],
        [9, sessionMeta('renamed')],
        [10, turnEnd()],
        [10, 'error'],
        [30_000, 'error'],
        [30_001, 'waiting'],
      ],
    ],
    [
      'turn.end with a tool and an approval left open: all cleared, done',
      [
        [0, turnStart()],
        [1, toolStart('a')],
        [2, approvalRequest('a')],
        [3, toolStart('b')],
        [4, questionRequest('q')],
        [4, 'approval'],
        [5, turnEnd()],
        [5, 'done'],
        [5005, 'waiting'],
      ],
    ],
    [
      'heartbeats only move the last-event time',
      [
        [0, activity()],
        [0, 'waiting'],
        [299_999, 'waiting'],
        [300_000, 'idle'],
        [300_000, activity()],
        [300_000, 'waiting'],
        [600_000, 'idle'],
      ],
    ],
    [
      'a heartbeat during done does not extend done',
      [
        [0, turnStart()],
        [1000, turnEnd()],
        [3000, activity()],
        [3000, 'done'],
        [6000, 'waiting'],
        [302_999, 'waiting'],
        [303_000, 'idle'],
      ],
    ],
    [
      'an unknown tool.end id is ignored',
      [
        [0, toolStart('a')],
        [1, toolEnd('zzz')],
        [1, 'working'],
      ],
    ],
    [
      'an unknown approval.resolved id is ignored',
      [
        [0, approvalRequest('r')],
        [1, approvalResolved('zzz')],
        [1, 'approval'],
        [2, approvalResolved('r')],
        [2, 'waiting'],
      ],
    ],
    [
      'an unknown question.resolved id is ignored',
      [
        [0, questionRequest('q')],
        [1, questionResolved('zzz')],
        [1, 'decision'],
        [2, questionResolved('q')],
        [2, 'waiting'],
      ],
    ],
    [
      'an unknown id on a new session is ignored',
      [
        [0, toolEnd('zzz')],
        [0, 'waiting'],
      ],
    ],
    [
      'an inferred request, then the exact one: confidence becomes exact',
      [
        [0, toolStart('a')],
        [10_000, approvalRequest('a', 'inferred')],
        [10_000, 'approval (inferred)'],
        [10_500, approvalRequest('a', 'log')],
        [10_500, 'approval'],
      ],
    ],
    [
      'events after session.end are ignored',
      [
        [0, turnStart()],
        [1, toolStart('a')],
        [2, approvalRequest('a')],
        [3, error()],
        [3, 'approval'],
        [4, sessionEnd()],
        [4, 'waiting'],
        [5, turnStart()],
        [6, toolStart('b')],
        [7, approvalRequest('b')],
        [8, error()],
        [8, 'waiting'],
        [300_004, 'idle'],
      ],
    ],
  ])('%s', (_label, steps) => {
    expectStates(steps);
  });

  it('turn.end empties every open set', () => {
    const conditions = feed([
      [0, turnStart()],
      [1, toolStart('a')],
      [2, approvalRequest('a')],
      [3, questionRequest('q')],
      [4, turnEnd()],
    ]);
    expect(snapshot(conditions)).toMatchObject({
      inTurn: false,
      openTools: [],
      openApprovals: [],
      openQuestions: [],
      turnEndedAt: 4,
    });
  });

  it('a heartbeat opens no condition', () => {
    const before = feed([[0, turnStart()]]);
    const after = reduceSession(before, activity(), 50);
    expect(snapshot(after)).toStrictEqual({
      ...snapshot(before),
      lastEventAt: 50,
    });
  });

  it('an unknown id does not throw and changes only the last-event time', () => {
    const before = feed([
      [0, toolStart('a')],
      [1, approvalRequest('r')],
      [2, questionRequest('q')],
    ]);
    for (const unknown of [
      toolEnd('zzz'),
      approvalResolved('zzz'),
      questionResolved('zzz'),
    ]) {
      const after = reduceSession(before, unknown, 9);
      expect(snapshot(after)).toStrictEqual({
        ...snapshot(before),
        lastEventAt: 9,
      });
    }
  });

  it('session.end clears every condition and marks the session ended', () => {
    const ended = feed([
      [0, turnStart()],
      [1, toolStart('a')],
      [2, approvalRequest('a')],
      [3, questionRequest('q')],
      [4, error()],
      [5, turnEnd()],
      [6, turnStart()],
      [7, sessionEnd()],
    ]);
    expect(snapshot(ended)).toStrictEqual({
      ended: true,
      inTurn: false,
      openTools: [],
      openApprovals: [],
      openQuestions: [],
      turnEndedAt: null,
      errorAt: null,
      lastEventAt: 7,
    });
    for (const later of [
      sessionStart(),
      turnStart(),
      toolStart('b'),
      approvalRequest('b'),
      error(),
      activity(),
      sessionMeta('renamed'),
      sessionEnd(),
    ]) {
      expect(reduceSession(ended, later, 100)).toBe(ended);
    }
  });
});

describe('confidence', () => {
  it.each<[string, Step[]]>([
    [
      'an approval with only an inferred request is inferred',
      [
        [0, approvalRequest('r', 'inferred')],
        [0, 'approval (inferred)'],
      ],
    ],
    [
      'an exact request is not downgraded by a later inferred one',
      [
        [0, approvalRequest('r', 'registry')],
        [1, approvalRequest('r', 'inferred')],
        [1, 'approval'],
      ],
    ],
    [
      'one exact approval among inferred ones makes the state exact',
      [
        [0, approvalRequest('a', 'inferred')],
        [1, approvalRequest('b', 'log')],
        [1, 'approval'],
        [2, approvalResolved('b')],
        [2, 'approval (inferred)'],
      ],
    ],
    [
      'an inferred approval closed by its tool.end leaves nothing inferred',
      [
        [0, toolStart('a')],
        [10_000, approvalRequest('a', 'inferred')],
        [10_000, 'approval (inferred)'],
        [10_001, toolEnd('a')],
        [10_001, 'waiting'],
      ],
    ],
    [
      'an inferred question closed by its tool.end leaves nothing inferred',
      [
        [0, toolStart('ask')],
        [10_000, questionRequest('ask', 'inferred')],
        [10_000, 'decision (inferred)'],
        [10_001, toolEnd('ask')],
        [10_001, 'waiting'],
      ],
    ],
    [
      'a decision with only an inferred question is inferred',
      [
        [0, toolStart('ask')],
        [10_000, questionRequest('ask', 'inferred')],
        [10_000, 'decision (inferred)'],
        [10_001, questionRequest('ask', 'log')],
        [10_001, 'decision'],
      ],
    ],
    [
      'an exact approval outranks an inferred question',
      [
        [0, questionRequest('q', 'inferred')],
        [1, approvalRequest('r', 'log')],
        [1, 'approval'],
      ],
    ],
    [
      'an inferred approval outranks an exact question and stays inferred',
      [
        [0, questionRequest('q', 'log')],
        [1, approvalRequest('r', 'inferred')],
        [1, 'approval (inferred)'],
        [2, approvalResolved('r')],
        [2, 'decision'],
      ],
    ],
  ])('%s', (_label, steps) => {
    expectStates(steps);
  });
});

/** AD-5's priority, highest first. */
const PRIORITY: readonly StateCode[] = [
  'approval',
  'decision',
  'error',
  'working',
  'thinking',
  'done',
  'waiting',
  'idle',
];

const LONG_ERROR: DetectionTimings = { ...TIMINGS, idleMs: 1000 };
const LONG_DONE: DetectionTimings = {
  ...TIMINGS,
  doneMs: 10_000,
  idleMs: 1000,
};

/**
 * Every pair of states that can hold together: [higher, lower, events,
 * evaluated at, timings]. Each row sets up both conditions.
 */
const PAIRS: readonly [
  StateCode,
  StateCode,
  Step[],
  number,
  DetectionTimings,
][] = [
  [
    'approval',
    'decision',
    [
      [0, approvalRequest('r')],
      [0, questionRequest('q')],
    ],
    0,
    TIMINGS,
  ],
  [
    'approval',
    'error',
    [
      [0, approvalRequest('r')],
      [1, error()],
    ],
    1,
    TIMINGS,
  ],
  [
    'approval',
    'working',
    [
      [0, toolStart('a')],
      [1, approvalRequest('a')],
    ],
    1,
    TIMINGS,
  ],
  [
    'approval',
    'thinking',
    [
      [0, turnStart()],
      [1, approvalRequest('r')],
    ],
    1,
    TIMINGS,
  ],
  [
    'approval',
    'done',
    [
      [0, turnEnd()],
      [1, approvalRequest('r')],
    ],
    1,
    TIMINGS,
  ],
  ['approval', 'waiting', [[0, approvalRequest('r')]], 0, TIMINGS],
  ['approval', 'idle', [[0, approvalRequest('r')]], 300_000, TIMINGS],
  [
    'decision',
    'error',
    [
      [0, questionRequest('q')],
      [1, error()],
    ],
    1,
    TIMINGS,
  ],
  [
    'decision',
    'working',
    [
      [0, toolStart('a')],
      [1, questionRequest('a')],
    ],
    1,
    TIMINGS,
  ],
  [
    'decision',
    'thinking',
    [
      [0, turnStart()],
      [1, questionRequest('q')],
    ],
    1,
    TIMINGS,
  ],
  [
    'decision',
    'done',
    [
      [0, turnEnd()],
      [1, questionRequest('q')],
    ],
    1,
    TIMINGS,
  ],
  ['decision', 'waiting', [[0, questionRequest('q')]], 0, TIMINGS],
  ['decision', 'idle', [[0, questionRequest('q')]], 300_000, TIMINGS],
  [
    'error',
    'working',
    [
      [0, toolStart('a')],
      [1, error()],
    ],
    1,
    TIMINGS,
  ],
  [
    'error',
    'thinking',
    [
      [0, turnStart()],
      [1, error()],
    ],
    1,
    TIMINGS,
  ],
  [
    'error',
    'done',
    [
      [0, turnEnd()],
      [1, error()],
    ],
    1,
    TIMINGS,
  ],
  ['error', 'waiting', [[0, error()]], 0, TIMINGS],
  ['error', 'idle', [[0, error()]], 2000, LONG_ERROR],
  [
    'working',
    'thinking',
    [
      [0, turnStart()],
      [1, toolStart('a')],
    ],
    1,
    TIMINGS,
  ],
  [
    'working',
    'done',
    [
      [0, turnEnd()],
      [1, toolStart('a')],
    ],
    1,
    TIMINGS,
  ],
  ['working', 'waiting', [[0, toolStart('a')]], 0, TIMINGS],
  ['working', 'idle', [[0, toolStart('a')]], 300_000, TIMINGS],
  ['thinking', 'waiting', [[0, turnStart()]], 0, TIMINGS],
  ['thinking', 'idle', [[0, turnStart()]], 300_000, TIMINGS],
  ['done', 'waiting', [[0, turnEnd()]], 0, TIMINGS],
  ['done', 'idle', [[0, turnEnd()]], 2000, LONG_DONE],
];

/**
 * The pairs that never hold together: turn.start ends done and turn.end
 * ends the turn; idle is waiting's complement.
 */
const EXCLUSIVE_PAIRS: readonly [StateCode, StateCode][] = [
  ['thinking', 'done'],
  ['waiting', 'idle'],
];

describe('priority approval > decision > error > working > thinking > done > waiting > idle', () => {
  it('the tables cover every pair of states, higher first', () => {
    const covered = [...PAIRS.map(([h, l]) => [h, l]), ...EXCLUSIVE_PAIRS].map(
      ([higher, lower]) => {
        expect(PRIORITY.indexOf(higher)).toBeLessThan(PRIORITY.indexOf(lower));
        return `${higher}>${lower}`;
      },
    );
    const all = PRIORITY.flatMap((higher, i) =>
      PRIORITY.slice(i + 1).map((lower) => `${higher}>${lower}`),
    );
    expect(covered.sort()).toStrictEqual(all.sort());
  });

  it.each(PAIRS)('%s over %s', (higher, lower, steps, at, timings) => {
    const conditions = feed(steps);
    expect(holding(conditions, at, timings)).toEqual(
      expect.arrayContaining([higher, lower]),
    );
    expect(evaluate(conditions, at, timings)).toStrictEqual({
      state: higher,
      confidence: 'exact',
    });
  });

  it('thinking and done never hold together', () => {
    expectStates([
      [0, turnStart()],
      [1000, turnEnd()],
      [1000, 'done'],
      // done would last until 6000, but a new turn ends it.
      [2000, turnStart()],
      [2000, 'thinking'],
      [3000, turnEnd()],
      [3000, 'done'],
      [7999, 'done'],
      [8000, 'waiting'],
    ]);
    const conditions = feed([
      [0, turnEnd()],
      [1, turnStart()],
    ]);
    expect(holding(conditions, 1, TIMINGS)).not.toContain('done');
  });

  it('waiting and idle never hold together', () => {
    const conditions = feed([[0, activity()]]);
    for (const at of [0, 299_999, 300_000, 900_000]) {
      const states = holding(conditions, at, TIMINGS);
      expect(states.includes('waiting')).not.toBe(states.includes('idle'));
    }
  });
});

describe('durations are half-open', () => {
  it.each<[string, Step[]]>([
    [
      'done: 1 ms before doneMs, and at doneMs',
      [
        [100, turnEnd()],
        [5099, 'done'],
        [5100, 'waiting'],
      ],
    ],
    [
      'error: 1 ms before errorHoldMs, and at errorHoldMs',
      [
        [100, error()],
        [30_099, 'error'],
        [30_100, 'waiting'],
      ],
    ],
    [
      'waiting: 1 ms before idleMs, and at idleMs',
      [
        [100, activity()],
        [300_099, 'waiting'],
        [300_100, 'idle'],
      ],
    ],
  ])('%s', (_label, steps) => {
    expectStates(steps);
  });

  it('a turn with no events for a long time stays thinking', () => {
    expectStates([
      [0, turnStart()],
      [10 * 60 * 60 * 1000, 'thinking'],
    ]);
  });
});

describe('session.start and session.meta', () => {
  it('session.start opens no condition', () => {
    expectStates([
      [0, sessionStart()],
      [0, 'waiting'],
      [300_000, 'idle'],
    ]);
  });

  it('session.meta changes nothing, not even the last-event time', () => {
    const before = feed([[0, activity()]]);
    expect(reduceSession(before, sessionMeta('gundam-pet'), 299_999)).toBe(
      before,
    );
    expectStates([
      [0, activity()],
      [299_999, sessionMeta('gundam-pet')],
      [300_000, 'idle'],
    ]);
  });

  it('a first event creates the conditions of a new session', () => {
    expect(snapshot(reduceSession(undefined, sessionMeta('x'), 42))).toEqual({
      ended: false,
      inTurn: false,
      openTools: [],
      openApprovals: [],
      openQuestions: [],
      turnEndedAt: null,
      errorAt: null,
      lastEventAt: 42,
    });
  });
});

describe('conditions are read-only', () => {
  it('reduceSession never changes the conditions it is given', () => {
    const steps: Step[] = [
      [0, turnStart()],
      [1, toolStart('a')],
      [2, approvalRequest('a', 'inferred')],
      [3, questionRequest('q')],
      [4, error()],
    ];
    let conditions: SessionConditions | undefined;
    for (const [at, step] of steps) {
      if (typeof step === 'string') continue;
      const before = conditions && snapshot(conditions);
      const next = reduceSession(conditions, step, at);
      if (conditions !== undefined) {
        expect(snapshot(conditions)).toStrictEqual(before);
        expect(next).not.toBe(conditions);
      }
      expect(Object.isFrozen(next)).toBe(true);
      conditions = next;
    }
    const final = conditions as SessionConditions;
    const frozen = snapshot(final);
    for (const later of [
      toolEnd('a'),
      approvalRequest('a', 'log'),
      approvalResolved('a'),
      questionResolved('q'),
      turnEnd(),
      sessionEnd(),
    ]) {
      reduceSession(final, later, 10);
      expect(snapshot(final)).toStrictEqual(frozen);
    }
  });
});

describe('nextChangeAt', () => {
  it('with a fractional clock, each state changes exactly at nextChangeAt', () => {
    // A performance.now()-style start where `(start + d) - start` rounds
    // below d for all three durations.
    const start = 522_329.210_945_471_95;
    for (const duration of [5000, 30_000, 300_000]) {
      expect(start + duration - start).toBeLessThan(duration);
    }
    const cases: [DetectionEvent, StateCode, StateCode][] = [
      [turnEnd(), 'done', 'waiting'],
      [error(), 'error', 'waiting'],
      [activity(), 'waiting', 'idle'],
    ];
    for (const [first, before, after] of cases) {
      const conditions = feed([[start, first]]);
      const next = nextChangeAt(conditions, start, TIMINGS);
      expect(next).not.toBeNull();
      const at = next as number;
      expect(evaluate(conditions, start, TIMINGS).state).toBe(before);
      expect(evaluate(conditions, at, TIMINGS).state).toBe(after);
      // And the boundary is not skipped: the next change is a later one.
      const following = nextChangeAt(conditions, at, TIMINGS);
      expect(following === null || following > at).toBe(true);
    }
  });

  it('is the idle time when nothing else is pending, then null', () => {
    const conditions = feed([[1000, activity()]]);
    expect(nextChangeAt(conditions, 1000, TIMINGS)).toBe(301_000);
    expect(nextChangeAt(conditions, 300_999, TIMINGS)).toBe(301_000);
    expect(nextChangeAt(conditions, 301_000, TIMINGS)).toBeNull();
  });

  it('walks through done, error and idle in order', () => {
    const conditions = feed([
      [0, turnStart()],
      [1000, turnEnd()],
      [2000, error()],
    ]);
    // done ends at 6000, error at 32000, waiting at 302000.
    expect(nextChangeAt(conditions, 2000, TIMINGS)).toBe(6000);
    expect(nextChangeAt(conditions, 6000, TIMINGS)).toBe(32_000);
    expect(nextChangeAt(conditions, 32_000, TIMINGS)).toBe(302_000);
    expect(nextChangeAt(conditions, 302_000, TIMINGS)).toBeNull();
  });

  it('ignores done and error once a new turn clears them', () => {
    const conditions = feed([
      [0, turnEnd()],
      [1, error()],
      [2, turnStart()],
    ]);
    expect(nextChangeAt(conditions, 2, TIMINGS)).toBe(300_002);
  });

  it('follows the timings it is given', () => {
    const conditions = feed([[0, turnEnd()]]);
    expect(nextChangeAt(conditions, 0, TIMINGS)).toBe(5000);
    expect(
      nextChangeAt(conditions, 0, { ...TIMINGS, doneMs: 1000, idleMs: 500 }),
    ).toBe(500);
  });

  it('the state does not change before nextChangeAt, and does at it', () => {
    const conditions = feed([
      [0, turnStart()],
      [1000, turnEnd()],
      [2000, error()],
    ]);
    const seen: StateCode[] = [];
    let now: number | null = 2000;
    // Bounded, so a nextChangeAt that stops moving forward fails, not hangs.
    for (let step = 0; now !== null && step < 10; step++) {
      const { state } = evaluate(conditions, now, TIMINGS);
      seen.push(state);
      const next: number | null = nextChangeAt(conditions, now, TIMINGS);
      if (next !== null) {
        expect(next).toBeGreaterThan(now);
        expect(evaluate(conditions, next - 1, TIMINGS).state).toBe(state);
      }
      now = next;
    }
    expect(seen).toStrictEqual(['error', 'error', 'waiting', 'idle']);
  });
});

describe('timings', () => {
  it('the same conditions use new timings at once', () => {
    const conditions = feed([
      [0, turnEnd()],
      [0, error()],
    ]);
    expect(evaluate(conditions, 3000, TIMINGS).state).toBe('error');
    expect(
      evaluate(conditions, 3000, { ...TIMINGS, errorHoldMs: 3000 }),
    ).toStrictEqual({
      state: 'done',
      confidence: 'exact',
    });
    expect(
      evaluate(conditions, 3000, {
        ...TIMINGS,
        errorHoldMs: 3000,
        doneMs: 3000,
      }).state,
    ).toBe('waiting');
    expect(
      evaluate(conditions, 3000, {
        doneMs: 3000,
        idleMs: 3000,
        errorHoldMs: 3000,
      }).state,
    ).toBe('idle');
    // And back again: nothing was remembered from the calls above.
    expect(evaluate(conditions, 3000, TIMINGS).state).toBe('error');
  });
});
