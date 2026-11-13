import { describe, expect, it } from 'vitest';
import {
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
import {
  type DetectionTimings,
  SETTINGS_DEFAULTS,
} from '../../src/shared/settings';
import type { StateCode } from '../../src/shared/states';

/**
 * The I/O matrix's example timings. The reducer reads only these three; the
 * other detection timings stay at their defaults.
 */
const TIMINGS: DetectionTimings = {
  ...SETTINGS_DEFAULTS,
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
const toolStart = (toolCallId: string, toolName = 'Bash') =>
  event('tool.start', { toolCallId, toolName });
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
    openTools: [...conditions.openTools].map(([id, tool]) => [id, { ...tool }]),
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

  // Epic 2 close-out B2: a record replayed out of date order. Each is
  // dated `agoMs` before the sync moment (ts SYNC_TS, monotonic 0) and fed
  // at the time main/detection/sessions back-dates it to.
  const SYNC_TS = 1_762_675_200_000;
  const replayedAgo = (live: DetectionEvent, agoMs: number): Step => [
    -agoMs,
    detectionEventSchema.parse({ ...live, ts: SYNC_TS - agoMs, replay: true }),
  ];

  it('補讀順序: the main transcript’s turn.end replayed (3 minutes ago), then a subagent’s tool.start replayed (4 minutes ago): waiting, then idle, never working', () => {
    const replayedSteps: Step[] = [
      replayedAgo(turnStart(), 600_000),
      replayedAgo(turnEnd(), 180_000),
      replayedAgo(toolStart('s1'), 240_000),
    ];
    expectStates([
      ...replayedSteps,
      [0, 'waiting'],
      [119_999, 'waiting'],
      [120_000, 'idle'],
    ]);
    expect(feed(replayedSteps).openTools.size).toBe(0);
  });

  it('下一輪的工具: a replayed tool.start dated after the last turn.end opens as usual', () => {
    expectStates([
      replayedAgo(turnEnd(), 180_000),
      replayedAgo(turnStart(), 120_000),
      replayedAgo(toolStart('t2'), 60_000),
      [0, 'working'],
    ]);
  });

  it.each<[string, DetectionEvent]>([
    ['approval.request', approvalRequest('r')],
    ['question.request', questionRequest('q')],
  ])(
    '補讀的請求: a replayed %s dated before the last turn.end opens nothing',
    (_label, request) => {
      expectStates([
        replayedAgo(turnEnd(), 180_000),
        replayedAgo(request, 240_000),
        [0, 'waiting'],
      ]);
    },
  );

  it('補讀順序: a replayed turn.end and tool.start with the same ts open the tool, though the later one was back-dated a millisecond earlier', () => {
    const replayedAt = (live: DetectionEvent) =>
      detectionEventSchema.parse({ ...live, ts: SYNC_TS, replay: true });
    expectStates([
      [-180_000, replayedAt(turnEnd())],
      [-180_001, replayedAt(toolStart('a'))],
      [0, 'working'],
    ]);
  });

  it('即時事件: live events in order are unchanged, even at the very moment of the turn end', () => {
    expectStates([
      [0, turnStart()],
      [10, turnEnd()],
      [10, toolStart('a')],
      [10, 'working'],
      [10, approvalRequest('a')],
      [10, 'approval'],
      [10, questionRequest('q')],
      [10, 'approval'],
      [11, toolEnd('a')],
      [11, 'decision'],
    ]);
  });
});

describe('the last turn end (Epic 2 close-out B2)', () => {
  const TS = 1_762_675_200_000;
  /** `live` written `agoMs` before TS, replayed. */
  const replayedAgo = (live: DetectionEvent, agoMs: number) =>
    detectionEventSchema.parse({ ...live, ts: TS - agoMs, replay: true });
  const turnReply = () => event('turn.reply');
  const guessedTurnEnd = () => event('turn.end', {}, 'inferred');

  it('is absent until a turn.end, live or replayed, then the latest ts, kept when a turn starts again', () => {
    expect('lastTurnEndTs' in feed([[0, turnStart()]])).toBe(false);
    expect(feed([[-5000, replayedAgo(turnEnd(), 5000)]]).lastTurnEndTs).toBe(
      TS - 5000,
    );
    expect(feed([[7, turnEnd()]]).lastTurnEndTs).toBe(turnEnd().ts);
    expect(
      feed([
        [-5000, replayedAgo(turnEnd(), 5000)],
        [-9000, replayedAgo(turnEnd(), 9000)],
        [-4000, replayedAgo(turnStart(), 4000)],
      ]).lastTurnEndTs,
    ).toBe(TS - 5000);
  });

  it('is the record’s ts, not the back-dated time', () => {
    expect(feed([[-123, replayedAgo(turnEnd(), 5000)]]).lastTurnEndTs).toBe(
      TS - 5000,
    );
  });

  it('a guessed turn end does not set it, and session.end clears it', () => {
    const guessed = feed([
      [0, turnStart()],
      [1, turnReply()],
      [10_001, guessedTurnEnd()],
    ]);
    expect('lastTurnEndTs' in guessed).toBe(false);
    // A tool call written before the guess still opens.
    expect(
      reduceSession(guessed, replayedAgo(toolStart('a'), 60_000), 5000)
        .openTools.size,
    ).toBe(1);

    const ended = reduceSession(feed([[0, turnEnd()]]), sessionEnd(), 1);
    expect('lastTurnEndTs' in ended).toBe(false);
  });

  it.each<[string, DetectionEvent]>([
    ['tool.start', replayedAgo(toolStart('a'), 60_000)],
    ['approval.request', replayedAgo(approvalRequest('a'), 60_000)],
    ['question.request', replayedAgo(questionRequest('a'), 60_000)],
  ])(
    'an earlier %s acts like activity: no condition opens, nothing else changes',
    (_label, early) => {
      // An error and a reply that a tool.start would clear.
      const before = feed([
        [100, replayedAgo(turnEnd(), 30_000)],
        [200, turnStart()],
        [210, error()],
        [220, turnReply()],
      ]);
      expect(before.errorAt).toBe(210);
      expect(before.replyPending).toBe(true);
      expect(snapshot(reduceSession(before, early, 50))).toStrictEqual(
        snapshot(reduceSession(before, activity(), 50)),
      );
      expect(snapshot(reduceSession(before, early, 50))).toStrictEqual(
        snapshot(before),
      );
    },
  );

  it('evaluate and nextChangeAt read nothing new: the same conditions without it give the same answers', () => {
    const conditions = feed([
      [-180_000, replayedAgo(turnEnd(), 180_000)],
      [0, turnEnd()],
    ]);
    const { lastTurnEndTs: _ignored, ...without } = conditions;
    for (const at of [0, 4999, 5000, 299_999, 300_000]) {
      expect(evaluate(without, at, TIMINGS)).toStrictEqual(
        evaluate(conditions, at, TIMINGS),
      );
      expect(nextChangeAt(without, at, TIMINGS)).toBe(
        nextChangeAt(conditions, at, TIMINGS),
      );
    }
  });
});

describe('replayed events (Story 2.2)', () => {
  /** The same event, marked as replayed. */
  const replayed = (live: DetectionEvent) =>
    detectionEventSchema.parse({ ...live, replay: true });

  it('a replayed turn.end closes the turn but starts no done', () => {
    expectStates([
      [0, replayed(turnStart())],
      [1, replayed(toolStart('a'))],
      [2, replayed(approvalRequest('a'))],
      [3, replayed(questionRequest('q'))],
      [3, 'approval'],
      [4, replayed(turnEnd())],
      [4, 'waiting'],
      [300_003, 'waiting'],
      [300_004, 'idle'],
    ]);
    expect(
      snapshot(
        feed([
          [0, replayed(turnStart())],
          [1, replayed(toolStart('a'))],
          [2, replayed(approvalRequest('a'))],
          [4, replayed(turnEnd())],
        ]),
      ),
    ).toMatchObject({
      inTurn: false,
      openTools: [],
      openApprovals: [],
      openQuestions: [],
      turnEndedAt: null,
      lastEventAt: 4,
    });
  });

  it('a replayed turn.end leaves a live done as it was', () => {
    const conditions = feed([
      [0, turnEnd()],
      [1, replayed(turnEnd())],
    ]);
    expect(conditions.turnEndedAt).toBe(0);
    expect(evaluate(conditions, 4999, TIMINGS).state).toBe('done');
    expect(evaluate(conditions, 5000, TIMINGS).state).toBe('waiting');
  });

  it('a replayed error holds no error and only moves the last-event time', () => {
    const before = feed([[0, turnEnd()]]);
    const after = reduceSession(before, replayed(error()), 10);
    expect(snapshot(after)).toStrictEqual({
      ...snapshot(before),
      lastEventAt: 10,
    });
    expectStates([
      [0, replayed(error())],
      [0, 'waiting'],
    ]);
  });

  it('a replayed error leaves a live error as it was', () => {
    const conditions = feed([
      [0, error()],
      [5, replayed(error())],
    ]);
    expect(conditions.errorAt).toBe(0);
    expect(evaluate(conditions, 29_999, TIMINGS).state).toBe('error');
    expect(evaluate(conditions, 30_000, TIMINGS).state).toBe('waiting');
  });

  it('other replayed events rebuild the conditions like live ones', () => {
    expectStates([
      [0, replayed(error())],
      [1, replayed(turnStart())],
      [1, 'thinking'],
      [2, replayed(toolStart('a'))],
      [2, 'working'],
      [3, replayed(questionRequest('a', 'inferred'))],
      [3, 'decision (inferred)'],
      [4, replayed(toolEnd('a'))],
      [4, 'thinking'],
      [5, replayed(approvalRequest('r'))],
      [5, 'approval'],
      [6, replayed(approvalResolved('r'))],
      [6, 'thinking'],
    ]);
  });
});

describe('open tools (Story 2.2 inference)', () => {
  const replayed = (live: DetectionEvent) =>
    detectionEventSchema.parse({ ...live, replay: true });

  it('tool.start records when it started and which tool, not yet requested', () => {
    const conditions = feed([
      [100, toolStart('a')],
      [200, toolStart('b', 'Read')],
    ]);
    expect(snapshot(conditions).openTools).toStrictEqual([
      ['a', { startedAt: 100, toolName: 'Bash', requested: false }],
      ['b', { startedAt: 200, toolName: 'Read', requested: false }],
    ]);
  });

  it('a replayed tool.start starts at the back-dated time it is given', () => {
    const conditions = reduceSession(
      undefined,
      replayed(toolStart('a')),
      -180_000,
    );
    expect(conditions.openTools.get('a')?.startedAt).toBe(-180_000);
  });

  it('a repeated tool.start keeps the entry it found, but still clears error and moves the last-event time', () => {
    const before = feed([
      [0, toolStart('a')],
      [5, error()],
    ]);
    const after = reduceSession(before, toolStart('a', 'Read'), 10);
    expect(after.openTools).toBe(before.openTools);
    expect(after.openTools.get('a')).toStrictEqual({
      startedAt: 0,
      toolName: 'Bash',
      requested: false,
    });
    expect(after.errorAt).toBeNull();
    expect(after.lastEventAt).toBe(10);
  });

  it('tool.end and turn.end drop the entry', () => {
    const ended = feed([
      [0, toolStart('a')],
      [1, toolStart('b')],
      [2, toolEnd('a')],
    ]);
    expect([...ended.openTools.keys()]).toStrictEqual(['b']);
    expect(reduceSession(ended, turnEnd(), 3).openTools.size).toBe(0);
  });

  it.each<[string, DetectionEvent]>([
    ['an exact approval', approvalRequest('a', 'log')],
    ['a registry approval', approvalRequest('a', 'registry')],
    ['an inferred approval', approvalRequest('a', 'inferred')],
    ['an exact question', questionRequest('a', 'log')],
    ['an inferred question', questionRequest('a', 'inferred')],
  ])('%s with the tool call id marks the tool requested', (_label, request) => {
    const conditions = feed([
      [0, toolStart('a')],
      [1, toolStart('b')],
      [2, request],
    ]);
    expect(snapshot(conditions).openTools).toStrictEqual([
      ['a', { startedAt: 0, toolName: 'Bash', requested: true }],
      ['b', { startedAt: 1, toolName: 'Bash', requested: false }],
    ]);
  });

  it('requested stays true once the request is resolved, and the tool keeps running', () => {
    expectStates([
      [0, toolStart('a')],
      [10_000, approvalRequest('a', 'inferred')],
      [10_000, 'approval (inferred)'],
      [12_000, approvalResolved('a')],
      [12_000, 'working'],
    ]);
    const conditions = feed([
      [0, toolStart('a')],
      [10_000, approvalRequest('a', 'inferred')],
      [12_000, approvalResolved('a')],
      [13_000, questionRequest('a')],
      [14_000, questionResolved('a')],
    ]);
    expect(conditions.openTools.get('a')?.requested).toBe(true);
    expect(conditions.openApprovals.size).toBe(0);
    expect(conditions.openQuestions.size).toBe(0);
  });

  it('a request with another id leaves the open tools as they were', () => {
    const before = feed([[0, toolStart('a')]]);
    for (const request of [
      approvalRequest('r'),
      questionRequest('q', 'inferred'),
    ]) {
      expect(reduceSession(before, request, 1).openTools).toBe(
        before.openTools,
      );
    }
  });

  it('a tool whose request is still pending when it starts is requested', () => {
    const pending = feed([
      [0, approvalRequest('a')],
      [1, questionRequest('b')],
      [2, toolStart('a')],
      [3, toolStart('b')],
    ]);
    expect(pending.openTools.get('a')?.requested).toBe(true);
    expect(pending.openTools.get('b')?.requested).toBe(true);
    // An inferred request before its tool started was ignored (Story 2.3).
    const guessedEarly = feed([
      [0, questionRequest('c', 'inferred')],
      [1, toolStart('c')],
    ]);
    expect(guessedEarly.openTools.get('c')?.requested).toBe(false);
    expect(guessedEarly.openQuestions.size).toBe(0);
    // One resolved before its tool started is not pending any more.
    const resolved = feed([
      [0, approvalRequest('a')],
      [1, approvalResolved('a')],
      [2, toolStart('a')],
    ]);
    expect(resolved.openTools.get('a')?.requested).toBe(false);
  });
});

describe('an inferred request with no open tool call (Story 2.3)', () => {
  it.each<[string, Step[], DetectionEvent]>([
    [
      'an approval for a tool call that already ended',
      [
        [0, turnStart()],
        [0, toolStart('a')],
        [5, toolEnd('a')],
      ],
      approvalRequest('a', 'inferred'),
    ],
    [
      'a question for a tool call that never started',
      [
        [0, turnStart()],
        [0, toolStart('a')],
      ],
      questionRequest('b', 'inferred'),
    ],
    [
      'an approval after turn.end closed every tool call',
      [
        [0, turnStart()],
        [0, toolStart('a')],
        [5, turnEnd()],
      ],
      approvalRequest('a', 'inferred'),
    ],
    [
      'an approval in a session with no tool call at all',
      [[0, sessionStart()]],
      approvalRequest('a', 'inferred'),
    ],
  ])('%s returns the very same conditions', (_label, steps, request) => {
    const before = feed(steps);
    const after = reduceSession(before, request, 10_000);
    expect(after).toBe(before);
    expect(evaluate(after, 10_000, TIMINGS).state).not.toMatch(
      /approval|decision/,
    );
  });

  it("as a session's first event it creates empty conditions, no request", () => {
    const conditions = reduceSession(
      undefined,
      approvalRequest('a', 'inferred'),
      42,
    );
    expect(snapshot(conditions)).toStrictEqual({
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

  it('an exact request with no open tool call still opens (AD-21 unchanged)', () => {
    expectStates([
      [0, sessionStart()],
      [1, approvalRequest('r')],
      [1, 'approval'],
      [2, approvalResolved('r')],
      [2, questionRequest('q', 'registry')],
      [2, 'decision'],
    ]);
  });

  it('an inferred request for an open tool call still opens', () => {
    expectStates([
      [0, toolStart('a')],
      [10_000, approvalRequest('a', 'inferred')],
      [10_000, 'approval (inferred)'],
    ]);
  });
});

describe('inferred requests and the last-event time (Story 2.2 inference)', () => {
  it('an inferred approval or question does not move it; an exact one does', () => {
    let conditions = feed([
      [0, toolStart('a')],
      [0, toolStart('q')],
    ]);
    conditions = reduceSession(
      conditions,
      approvalRequest('a', 'inferred'),
      10_000,
    );
    expect(conditions.lastEventAt).toBe(0);
    conditions = reduceSession(
      conditions,
      questionRequest('q', 'inferred'),
      20_000,
    );
    expect(conditions.lastEventAt).toBe(0);
    expect(nextChangeAt(conditions, 20_000, TIMINGS)).toBe(300_000);
    expect(evaluate(conditions, 20_000, TIMINGS)).toStrictEqual({
      state: 'approval',
      confidence: 'inferred',
    });

    conditions = reduceSession(conditions, approvalRequest('a', 'log'), 30_000);
    expect(conditions.lastEventAt).toBe(30_000);
    conditions = reduceSession(
      conditions,
      questionRequest('q', 'registry'),
      40_000,
    );
    expect(conditions.lastEventAt).toBe(40_000);
  });

  it("an inferred request as a session's first event starts the conditions then", () => {
    expect(
      reduceSession(undefined, approvalRequest('r', 'inferred'), 42)
        .lastEventAt,
    ).toBe(42);
  });

  it('the resolution of an inferred request is an event like any other', () => {
    const conditions = feed([
      [0, toolStart('a')],
      [10_000, approvalRequest('a', 'inferred')],
      [12_000, approvalResolved('a')],
    ]);
    expect(conditions.lastEventAt).toBe(12_000);
  });

  it('only requests are exempt: any other inferred event moves it', () => {
    const before = feed([[0, toolStart('a')]]);
    expect(
      reduceSession(before, event('activity', {}, 'inferred'), 5000)
        .lastEventAt,
    ).toBe(5000);
  });
});

describe('the last-event time only moves forward', () => {
  it('an event dated before the last one leaves it as it was', () => {
    const conditions = feed([
      [1000, turnStart()],
      [400, activity()],
    ]);
    expect(conditions.lastEventAt).toBe(1000);
    expect(nextChangeAt(conditions, 1000, TIMINGS)).toBe(301_000);
  });

  it('a later event still moves it', () => {
    const conditions = feed([
      [400, turnStart()],
      [1000, activity()],
    ]);
    expect(conditions.lastEventAt).toBe(1000);
  });

  it('a first event dated in the past starts the conditions then', () => {
    expect(reduceSession(undefined, activity(), -600_000).lastEventAt).toBe(
      -600_000,
    );
  });
});

describe('confidence', () => {
  it.each<[string, Step[]]>([
    [
      'an approval with only an inferred request is inferred',
      [
        [0, toolStart('r')],
        [0, approvalRequest('r', 'inferred')],
        [0, 'approval (inferred)'],
      ],
    ],
    [
      'an exact request is not downgraded by a later inferred one',
      [
        [0, toolStart('r')],
        [0, approvalRequest('r', 'registry')],
        [1, approvalRequest('r', 'inferred')],
        [1, 'approval'],
      ],
    ],
    [
      'one exact approval among inferred ones makes the state exact',
      [
        [0, toolStart('a')],
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
        [0, toolStart('q')],
        [0, questionRequest('q', 'inferred')],
        [1, approvalRequest('r', 'log')],
        [1, 'approval'],
      ],
    ],
    [
      'an inferred approval outranks an exact question and stays inferred',
      [
        [0, toolStart('r')],
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
      for (const tool of next.openTools.values()) {
        expect(Object.isFrozen(tool)).toBe(true);
      }
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
        ...TIMINGS,
        doneMs: 3000,
        idleMs: 3000,
        errorHoldMs: 3000,
      }).state,
    ).toBe('idle');
    // And back again: nothing was remembered from the calls above.
    expect(evaluate(conditions, 3000, TIMINGS).state).toBe('error');
  });
});

describe('a reply and a guessed turn end (Story 2.6)', () => {
  const turnReply = () => event('turn.reply');
  /** main/detection/inference's guess. */
  const guessedTurnEnd = () => event('turn.end', {}, 'inferred');

  it.each<[string, Step[]]>([
    [
      'a reply in a turn is a heartbeat: still thinking, the last event moves',
      [
        [0, turnStart()],
        [1000, turnReply()],
        [1000, 'thinking'],
        [600_000, 'thinking'],
      ],
    ],
    [
      'a guessed turn end: done (inferred) until doneMs, then waiting (inferred), then idle',
      [
        [0, turnStart()],
        [1000, turnReply()],
        [11_000, guessedTurnEnd()],
        [11_000, 'done (inferred)'],
        [15_999, 'done (inferred)'],
        [16_000, 'waiting (inferred)'],
        // idle counts from the reply: the guess is not the last event.
        [300_999, 'waiting (inferred)'],
        [301_000, 'idle'],
      ],
    ],
    [
      'after the guess, the next turn: thinking, exact',
      [
        [0, turnStart()],
        [1000, turnReply()],
        [11_000, guessedTurnEnd()],
        [20_000, turnStart()],
        [20_000, 'thinking'],
        [21_000, turnEnd()],
        [21_000, 'done'],
        [26_000, 'waiting'],
      ],
    ],
    [
      'after the guess, the real turn end: done, exact',
      [
        [0, turnStart()],
        [1000, turnReply()],
        [11_000, guessedTurnEnd()],
        [12_000, turnEnd()],
        [12_000, 'done'],
        [17_000, 'waiting'],
      ],
    ],
    [
      'after the guess, an activity: still inferred, and idle counts from it',
      [
        [0, turnStart()],
        [1000, turnReply()],
        [11_000, guessedTurnEnd()],
        [20_000, activity()],
        [20_000, 'waiting (inferred)'],
        [319_999, 'waiting (inferred)'],
        [320_000, 'idle'],
      ],
    ],
    [
      'after the guess, a reply outside a turn: still inferred',
      [
        [0, turnStart()],
        [1000, turnReply()],
        [11_000, guessedTurnEnd()],
        [12_000, turnReply()],
        [12_000, 'done (inferred)'],
        [16_000, 'waiting (inferred)'],
      ],
    ],
    [
      'after the guess, a tool call: working, then waiting, exact',
      [
        [0, turnStart()],
        [1000, turnReply()],
        [11_000, guessedTurnEnd()],
        [12_000, toolStart('a')],
        [12_000, 'working'],
        [13_000, toolEnd('a')],
        [13_000, 'done'],
        [16_000, 'waiting'],
      ],
    ],
    [
      'after the guess, an error: error, exact; then waiting (inferred) again',
      [
        [0, turnStart()],
        [1000, turnReply()],
        [11_000, guessedTurnEnd()],
        [12_000, error()],
        [12_000, 'error'],
        [42_000, 'waiting (inferred)'],
      ],
    ],
    [
      'a real turn end after a reply is exact as before',
      [
        [0, turnStart()],
        [1000, turnReply()],
        [2000, turnEnd()],
        [2000, 'done'],
        [7000, 'waiting'],
      ],
    ],
    [
      'priority is unchanged: an approval after the guess is approval',
      [
        [0, turnStart()],
        [1000, turnReply()],
        [11_000, guessedTurnEnd()],
        [12_000, approvalRequest('r')],
        [12_000, 'approval'],
        [13_000, approvalResolved('r')],
        [13_000, 'done (inferred)'],
      ],
    ],
  ])('%s', (_label, steps) => {
    expectStates(steps);
  });

  it('a reply sets replyPending and otherwise acts like activity', () => {
    const before = feed([[0, turnStart()]]);
    const after = reduceSession(before, turnReply(), 50);
    expect(snapshot(after)).toStrictEqual({
      ...snapshot(before),
      lastEventAt: 50,
      replyPending: true,
    });
  });

  it.each<[string, () => DetectionEvent]>([
    ['turn.start', turnStart],
    ['tool.start', () => toolStart('a')],
    ['turn.end', turnEnd],
    ['a guessed turn.end', guessedTurnEnd],
  ])('%s clears replyPending', (_label, make) => {
    const pending = feed([
      [0, turnStart()],
      [1, turnReply()],
    ]);
    expect(pending.replyPending).toBe(true);
    expect('replyPending' in reduceSession(pending, make(), 2)).toBe(false);
  });

  it('session.end clears replyPending and turnEndInferred', () => {
    for (const steps of [
      [
        [0, turnStart()],
        [1, turnReply()],
      ],
      [
        [0, turnStart()],
        [1, turnReply()],
        [2, guessedTurnEnd()],
      ],
    ] satisfies Step[][]) {
      const ended = reduceSession(feed(steps), sessionEnd(), 3);
      expect('replyPending' in ended).toBe(false);
      expect('turnEndInferred' in ended).toBe(false);
    }
  });

  it.each<[string, () => DetectionEvent]>([
    ['activity', activity],
    ['tool.end', () => toolEnd('zzz')],
    ['approval.resolved', () => approvalResolved('zzz')],
    ['error', error],
    ['session.meta', () => sessionMeta('x')],
  ])('%s leaves replyPending as it was', (_label, make) => {
    const pending = feed([
      [0, turnStart()],
      [1, turnReply()],
    ]);
    expect(reduceSession(pending, make(), 2).replyPending).toBe(true);
  });

  it('a guessed turn end closes the turn like a real one but does not move the last-event time', () => {
    const before = feed([
      [0, turnStart()],
      [1, toolStart('a')],
      [2, approvalRequest('a')],
      [3, questionRequest('q')],
      [4, turnReply()],
    ]);
    const after = reduceSession(before, guessedTurnEnd(), 10_004);
    expect(snapshot(after)).toStrictEqual({
      ended: false,
      inTurn: false,
      openTools: [],
      openApprovals: [],
      openQuestions: [],
      turnEndedAt: 10_004,
      errorAt: null,
      lastEventAt: 4,
      turnEndInferred: true,
    });
    expect(nextChangeAt(after, 10_004, TIMINGS)).toBe(15_004);
  });

  it.each<[string, () => DetectionEvent]>([
    ['turn.start', turnStart],
    ['turn.end', turnEnd],
    ['tool.start', () => toolStart('a')],
  ])('a %s that is not inferred clears turnEndInferred', (_label, make) => {
    const guessed = feed([
      [0, turnStart()],
      [1, turnReply()],
      [10_001, guessedTurnEnd()],
    ]);
    expect(guessed.turnEndInferred).toBe(true);
    expect('turnEndInferred' in reduceSession(guessed, make(), 10_002)).toBe(
      false,
    );
  });

  it.each<[string, () => DetectionEvent]>([
    ['turn.start', () => event('turn.start', {}, 'inferred')],
    [
      'tool.start',
      () =>
        event('tool.start', { toolCallId: 'a', toolName: 'Bash' }, 'inferred'),
    ],
    ['activity', activity],
    ['turn.reply', turnReply],
    ['tool.end', () => toolEnd('a')],
    ['approval.resolved', () => approvalResolved('a')],
    ['error', error],
  ])(
    'an inferred one, or any other event (%s), leaves turnEndInferred',
    (_label, make) => {
      const guessed = feed([
        [0, turnStart()],
        [1, turnReply()],
        [10_001, guessedTurnEnd()],
      ]);
      expect(reduceSession(guessed, make(), 10_002).turnEndInferred).toBe(true);
    },
  );

  it('a replayed real turn end clears turnEndInferred but leaves the done as it was', () => {
    const guessed = feed([
      [0, turnStart()],
      [1, turnReply()],
      [10_001, guessedTurnEnd()],
    ]);
    const after = reduceSession(
      guessed,
      detectionEventSchema.parse({ ...turnEnd(), replay: true }),
      10_002,
    );
    expect('turnEndInferred' in after).toBe(false);
    expect(after.turnEndedAt).toBe(10_001);
    expect(evaluate(after, 10_002, TIMINGS)).toStrictEqual({
      state: 'done',
      confidence: 'exact',
    });
  });

  it('the flags are absent, not false, while they do not hold', () => {
    const conditions = feed([
      [0, turnStart()],
      [1, turnReply()],
      [2, turnStart()],
      [3, turnReply()],
      [4, guessedTurnEnd()],
      [5, turnStart()],
    ]);
    expect(Object.keys(conditions)).not.toContain('replyPending');
    expect(Object.keys(conditions)).not.toContain('turnEndInferred');
    expect(Object.isFrozen(conditions)).toBe(true);
  });

  it('reduceSession never changes the conditions it is given', () => {
    const steps: Step[] = [
      [0, turnStart()],
      [1, turnReply()],
      [2, guessedTurnEnd()],
      [3, activity()],
      [4, turnStart()],
    ];
    let conditions: SessionConditions | undefined;
    for (const [at, step] of steps) {
      if (typeof step === 'string') continue;
      const before = conditions && snapshot(conditions);
      const next = reduceSession(conditions, step, at);
      if (conditions !== undefined) {
        expect(snapshot(conditions)).toStrictEqual(before);
      }
      expect(Object.isFrozen(next)).toBe(true);
      conditions = next;
    }
  });
});
