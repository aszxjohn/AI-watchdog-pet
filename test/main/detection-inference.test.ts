import { describe, expect, it } from 'vitest';
import {
  inferEvents,
  type InferenceSubject,
  type InferenceTimings,
  type InferredRequest,
  nextInferenceAt,
} from '../../src/main/detection/inference';
import {
  evaluate,
  reduceSession,
  type SessionConditions,
} from '../../src/main/detection/reducer';
import { TURN_END_INFER_MS } from '../../src/shared/constants';
import {
  confidenceFor,
  type DetectionEvent,
  detectionEventSchema,
  type Via,
} from '../../src/shared/detection-events';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import {
  SOURCE_CAPABILITIES,
  type SourceCapability,
} from '../../src/shared/sources';

/** The I/O matrix's example threshold. */
const TIMINGS: InferenceTimings = { approvalInferMs: 10_000 };

/** The wall clock the caller stamps guesses with. */
const WALL = 1_762_675_200_000;

/** A source that reads neither kind and has one question tool. */
const ASKING: SourceCapability = {
  approval: 'none',
  question: 'none',
  turnEnd: 'exact',
  questionTools: ['ask_user'],
  noInferTools: ['slow_tool'],
};

/** Like ASKING, but its questions are written to its records. */
const ASKING_EXACT_QUESTIONS: SourceCapability = {
  ...ASKING,
  question: 'exact',
};

// ---------------------------------------------------------------------------
// Events, through the shared schema, from codex unless a row says otherwise
// (the subject's source only stamps the guesses).

function event(
  type: DetectionEvent['type'],
  fields: Record<string, unknown> = {},
  via: Via = 'log',
): DetectionEvent {
  return detectionEventSchema.parse({
    type,
    source: 'codex',
    sessionKey: 'codex:s1',
    ts: WALL,
    via,
    confidence: confidenceFor(via),
    ...fields,
  });
}

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

type Step = readonly [at: number, event: DetectionEvent];

function feed(steps: readonly Step[]): SessionConditions {
  let conditions: SessionConditions | undefined;
  for (const [at, step] of steps) {
    conditions = reduceSession(conditions, step, at);
  }
  if (conditions === undefined) {
    throw new Error('the script has no event');
  }
  return conditions;
}

/**
 * The requests among inferEvents's guesses, without their due times, in a
 * frozen array: what the tests of the request rule look at.
 */
function inferRequests(
  session: InferenceSubject,
  now: number,
  timings: InferenceTimings,
  wallNow: number,
): readonly InferredRequest[] {
  return Object.freeze(
    inferEvents(session, now, timings, wallNow).flatMap(({ event: guess }) =>
      guess.type === 'turn.end' ? [] : [guess],
    ),
  );
}

function subject(
  conditions: SessionConditions,
  capability: SourceCapability = SOURCE_CAPABILITIES.codex,
): InferenceSubject {
  return {
    sessionKey: 'codex:s1',
    source: 'codex',
    conditions,
    capability,
  };
}

/** `approval <id>` / `question <id>` per guess. */
function guessed(
  session: InferenceSubject,
  now: number,
  timings: InferenceTimings = TIMINGS,
): string[] {
  return inferRequests(session, now, timings, WALL).map(
    (request) =>
      `${request.type === 'approval.request' ? 'approval' : 'question'} ${request.requestId}`,
  );
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

// ---------------------------------------------------------------------------

describe('the rule', () => {
  it.each<
    [
      label: string,
      capability: SourceCapability,
      steps: Step[],
      now: number,
      guesses: string[],
      next: number | null,
    ]
  >([
    [
      'a tool running for less than approvalInferMs: nothing yet',
      SOURCE_CAPABILITIES.codex,
      [[0, toolStart('a')]],
      9999,
      [],
      10_000,
    ],
    [
      'at approvalInferMs exactly: an approval',
      SOURCE_CAPABILITIES.codex,
      [[0, toolStart('a')]],
      10_000,
      ['approval a'],
      null,
    ],
    [
      'long after: the approval still, until the reducer has it',
      SOURCE_CAPABILITIES.codex,
      [[0, toolStart('a')]],
      600_000,
      ['approval a'],
      null,
    ],
    [
      'gemini: an approval',
      SOURCE_CAPABILITIES.gemini,
      [[0, toolStart('a')]],
      10_000,
      ['approval a'],
      null,
    ],
    [
      'cursor: an approval',
      SOURCE_CAPABILITIES.cursor,
      [[0, toolStart('a')]],
      10_000,
      ['approval a'],
      null,
    ],
    [
      'a question tool, questions not readable: a question',
      ASKING,
      [[0, toolStart('ask', 'ask_user')]],
      10_000,
      ['question ask'],
      null,
    ],
    [
      'any other tool on the same source: an approval',
      ASKING,
      [[0, toolStart('a', 'Ask_user')]],
      10_000,
      ['approval a'],
      null,
    ],
    [
      'a question tool, questions exact: nothing, not even an approval',
      ASKING_EXACT_QUESTIONS,
      [[0, toolStart('ask', 'ask_user')]],
      10_000,
      [],
      null,
    ],
    [
      'a no-guess tool: nothing, however long it runs',
      ASKING,
      [[0, toolStart('s', 'slow_tool')]],
      600_000,
      [],
      null,
    ],
    [
      'a no-guess tool next to one that is guessed at: only the other',
      ASKING,
      [
        [0, toolStart('s', 'slow_tool')],
        [1000, toolStart('a')],
      ],
      11_000,
      ['approval a'],
      null,
    ],
    [
      'claude-code (none until its status file is read): Bash, an approval',
      SOURCE_CAPABILITIES['claude-code'],
      [[0, toolStart('a')]],
      10_000,
      ['approval a'],
      null,
    ],
    [
      'claude-code question tool: AskUserQuestion, a question',
      SOURCE_CAPABILITIES['claude-code'],
      [[0, toolStart('q', 'AskUserQuestion')]],
      10_000,
      ['question q'],
      null,
    ],
    [
      'claude-code question tool: ExitPlanMode, a question',
      SOURCE_CAPABILITIES['claude-code'],
      [[0, toolStart('p', 'ExitPlanMode')]],
      10_000,
      ['question p'],
      null,
    ],
    ...[
      'Agent',
      'Task',
      'Workflow',
      'WebSearch',
      'Monitor',
      'TaskOutput',
      'ScheduleWakeup',
    ].map(
      (
        name,
      ): [
        string,
        SourceCapability,
        Step[],
        number,
        string[],
        number | null,
      ] => [
        `claude-code no-guess tool ${name}: nothing after 10 minutes`,
        SOURCE_CAPABILITIES['claude-code'],
        [[0, toolStart('n', name)]],
        600_000,
        [],
        null,
      ],
    ),
    [
      'claude-code WebFetch (it may ask to approve a domain): an approval',
      SOURCE_CAPABILITIES['claude-code'],
      [[0, toolStart('w', 'WebFetch')]],
      10_000,
      ['approval w'],
      null,
    ],
    [
      'copilot: questions not readable, but no question tools yet: nothing',
      SOURCE_CAPABILITIES.copilot,
      [[0, toolStart('a')]],
      10_000,
      [],
      null,
    ],
    [
      'demo: nothing',
      SOURCE_CAPABILITIES.demo,
      [[0, toolStart('a')]],
      10_000,
      [],
      null,
    ],
    [
      'an exact approval with its id is pending: nothing',
      SOURCE_CAPABILITIES.codex,
      [
        [0, toolStart('a')],
        [2000, approvalRequest('a')],
      ],
      10_000,
      [],
      null,
    ],
    [
      'an exact question with its id is pending: nothing',
      SOURCE_CAPABILITIES.codex,
      [
        [0, toolStart('a')],
        [2000, questionRequest('a')],
      ],
      10_000,
      [],
      null,
    ],
    [
      'an exact approval came and was resolved, the tool still runs: nothing',
      SOURCE_CAPABILITIES.codex,
      [
        [0, toolStart('a')],
        [2000, approvalRequest('a')],
        [3000, approvalResolved('a')],
      ],
      10_000,
      [],
      null,
    ],
    [
      'an exact question came and was resolved: nothing',
      ASKING,
      [
        [0, toolStart('ask', 'ask_user')],
        [2000, questionRequest('ask')],
        [3000, questionResolved('ask')],
      ],
      10_000,
      [],
      null,
    ],
    [
      'a guess was resolved, the tool still runs: nothing again',
      SOURCE_CAPABILITIES.codex,
      [
        [0, toolStart('a')],
        [10_000, approvalRequest('a', 'inferred')],
        [12_000, approvalResolved('a')],
      ],
      600_000,
      [],
      null,
    ],
    [
      'a request with its id pending when the tool started: nothing',
      SOURCE_CAPABILITIES.codex,
      [
        [0, approvalRequest('a')],
        [1, toolStart('a')],
      ],
      20_000,
      [],
      null,
    ],
    [
      'a request with another id does not count',
      SOURCE_CAPABILITIES.codex,
      [
        [0, toolStart('a')],
        [1, approvalRequest('r')],
        [2, approvalResolved('r')],
      ],
      10_000,
      ['approval a'],
      null,
    ],
    [
      'the tool ended in time: nothing',
      SOURCE_CAPABILITIES.codex,
      [
        [0, toolStart('a')],
        [9000, toolEnd('a')],
      ],
      10_000,
      [],
      null,
    ],
    [
      'turn.end closed the tool: nothing',
      SOURCE_CAPABILITIES.codex,
      [
        [0, turnStart()],
        [1, toolStart('a')],
        [2, turnEnd()],
      ],
      20_000,
      [],
      null,
    ],
    [
      'several tools: the due ones in the order they started; next is the soonest still to come',
      SOURCE_CAPABILITIES.codex,
      [
        [0, toolStart('b')],
        [1000, toolStart('a')],
        [2000, toolStart('d')],
        [3000, toolStart('c')],
        [5000, toolStart('e')],
        [6000, toolEnd('d')],
        [7000, approvalRequest('c')],
      ],
      11_000,
      ['approval b', 'approval a'],
      15_000,
    ],
  ])('%s', (_label, capability, steps, now, guesses, next) => {
    const session = subject(feed(steps), capability);
    expect(guessed(session, now)).toStrictEqual(guesses);
    expect(nextInferenceAt(session, now, TIMINGS)).toBe(next);
  });

  it('a replayed tool call counts from its back-dated start: already due when its source syncs', () => {
    const replayed = detectionEventSchema.parse({
      ...toolStart('a'),
      replay: true,
    });
    const session = subject(reduceSession(undefined, replayed, -180_000));
    expect(guessed(session, 0)).toStrictEqual(['approval a']);
    // One replayed from 5 seconds ago is due 5 seconds after the sync.
    const recent = subject(reduceSession(undefined, replayed, -5000));
    expect(guessed(recent, 0)).toStrictEqual([]);
    expect(nextInferenceAt(recent, 0, TIMINGS)).toBe(5000);
  });

  it('follows the threshold it is given', () => {
    const session = subject(feed([[0, toolStart('a')]]));
    const longer = { approvalInferMs: 30_000 };
    expect(guessed(session, 10_000, longer)).toStrictEqual([]);
    expect(nextInferenceAt(session, 10_000, longer)).toBe(30_000);
    expect(guessed(session, 30_000, longer)).toStrictEqual(['approval a']);
    // Any set of detection timings will do.
    expect(nextInferenceAt(session, 0, SETTINGS_DEFAULTS)).toBe(10_000);
  });

  it('is half-open on a fractional clock: guessed exactly at nextInferenceAt', () => {
    // A performance.now()-style start where `(start + 10000) - start`
    // rounds below 10000.
    const start = 522_329.210_945_471_95;
    expect(start + 10_000 - start).toBeLessThan(10_000);
    const session = subject(feed([[start, toolStart('a')]]));
    const next = nextInferenceAt(session, start, TIMINGS);
    expect(next).toBe(start + 10_000);
    const at = next as number;
    expect(guessed(session, at - 0.001)).toStrictEqual([]);
    expect(guessed(session, at)).toStrictEqual(['approval a']);
    // And the boundary is not skipped: nothing is still to come after it.
    expect(nextInferenceAt(session, at, TIMINGS)).toBeNull();
  });
});

describe('the guesses', () => {
  it('are valid inferred request events, stamped with the wall clock given, frozen', () => {
    const session = subject(
      feed([
        [0, toolStart('a')],
        [1, toolStart('ask', 'ask_user')],
      ]),
      ASKING,
    );

    const requests = inferRequests(session, 20_000, TIMINGS, WALL + 7);

    expect(requests).toStrictEqual([
      {
        type: 'approval.request',
        source: 'codex',
        sessionKey: 'codex:s1',
        ts: WALL + 7,
        via: 'inferred',
        confidence: 'inferred',
        requestId: 'a',
      },
      {
        type: 'question.request',
        source: 'codex',
        sessionKey: 'codex:s1',
        ts: WALL + 7,
        via: 'inferred',
        confidence: 'inferred',
        requestId: 'ask',
      },
    ]);
    for (const request of requests) {
      expect(detectionEventSchema.parse(request)).toStrictEqual(request);
      expect(Object.isFrozen(request)).toBe(true);
    }
    expect(Object.isFrozen(requests)).toBe(true);
  });

  it('are made at most once per tool call: once the reducer has them, there is nothing more', () => {
    let conditions = feed([
      [0, toolStart('a')],
      [500, toolStart('ask', 'ask_user')],
    ]);
    const requests = inferRequests(
      subject(conditions, ASKING),
      10_500,
      TIMINGS,
      WALL,
    );
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      conditions = reduceSession(conditions, request, 10_500);
    }

    expect(evaluate(conditions, 10_500, SETTINGS_DEFAULTS)).toStrictEqual({
      state: 'approval',
      confidence: 'inferred',
    });
    const after = subject(conditions, ASKING);
    expect(guessed(after, 10_500)).toStrictEqual([]);
    expect(guessed(after, 600_000)).toStrictEqual([]);
    expect(nextInferenceAt(after, 10_500, TIMINGS)).toBeNull();
  });

  it('never change the conditions they were guessed from', () => {
    const conditions = feed([
      [0, toolStart('a')],
      [1, approvalRequest('r')],
    ]);
    const before = snapshot(conditions);
    inferRequests(subject(conditions), 10_000, TIMINGS, WALL);
    nextInferenceAt(subject(conditions), 0, TIMINGS);
    expect(snapshot(conditions)).toStrictEqual(before);
  });

  it('nothing for a tool with a pending request, even one the reducer left unrequested', () => {
    // Built by hand: the reducer marks such a tool requested, so only this
    // shows inference checks the pending requests itself.
    const base = feed([[0, toolStart('a')]]);
    for (const pending of [
      { openApprovals: new Map([['a', 'exact' as const]]) },
      { openQuestions: new Map([['a', 'inferred' as const]]) },
    ]) {
      const conditions: SessionConditions = { ...base, ...pending };
      expect(conditions.openTools.get('a')?.requested).toBe(false);
      expect(guessed(subject(conditions), 600_000)).toStrictEqual([]);
      expect(nextInferenceAt(subject(conditions), 0, TIMINGS)).toBeNull();
    }
  });

  it('nothing for a session with no open tool', () => {
    const session = subject(feed([[0, turnStart()]]));
    expect(inferRequests(session, 600_000, TIMINGS, WALL)).toStrictEqual([]);
    expect(nextInferenceAt(session, 0, TIMINGS)).toBeNull();
  });
});

describe('turn ends (Story 2.6)', () => {
  const turnReply = () => event('turn.reply');
  const activity = () => event('activity');

  /** A source whose records show no turn end. */
  const SILENT = SOURCE_CAPABILITIES.gemini;

  /** `turn.end @<dueAt>` for a turn end, `<kind> <id> @<dueAt>` for a request. */
  function inferred(session: InferenceSubject, now: number): string[] {
    return inferEvents(session, now, TIMINGS, WALL).map(
      ({ event: guess, dueAt }) =>
        guess.type === 'turn.end'
          ? `turn.end @${dueAt}`
          : `${guess.type === 'approval.request' ? 'approval' : 'question'} ${guess.requestId} @${dueAt}`,
    );
  }

  it('waits TURN_END_INFER_MS, 10 seconds, a constant', () => {
    expect(TURN_END_INFER_MS).toBe(10_000);
  });

  it.each<
    [
      label: string,
      capability: SourceCapability,
      steps: Step[],
      now: number,
      guesses: string[],
      next: number | null,
    ]
  >([
    [
      'a reply, less than 10 seconds of nothing: not yet',
      SILENT,
      [
        [0, turnStart()],
        [1000, turnReply()],
      ],
      10_999,
      [],
      11_000,
    ],
    [
      'a reply, then 10 seconds of nothing exactly: the turn ended then',
      SILENT,
      [
        [0, turnStart()],
        [1000, turnReply()],
      ],
      11_000,
      ['turn.end @11000'],
      null,
    ],
    [
      'long after: still the moment it fell due',
      SILENT,
      [
        [0, turnStart()],
        [1000, turnReply()],
      ],
      600_000,
      ['turn.end @11000'],
      null,
    ],
    [
      'an activity 6 seconds after the reply: 10 seconds from it',
      SILENT,
      [
        [0, turnStart()],
        [1000, turnReply()],
        [7000, activity()],
      ],
      16_999,
      [],
      17_000,
    ],
    [
      'a tool call 3 seconds after the reply: no turn end, the tool is guessed at as before',
      SILENT,
      [
        [0, turnStart()],
        [1000, turnReply()],
        [4000, toolStart('a')],
      ],
      14_000,
      ['approval a @14000'],
      null,
    ],
    [
      'a tool call that ends: back in the turn, no reply since, nothing',
      SILENT,
      [
        [0, turnStart()],
        [1000, turnReply()],
        [4000, toolStart('a')],
        [5000, toolEnd('a')],
      ],
      600_000,
      [],
      null,
    ],
    [
      'a reply while a tool runs: only the tool is guessed at',
      SILENT,
      [
        [0, turnStart()],
        [1000, toolStart('a')],
        [2000, turnReply()],
      ],
      600_000,
      ['approval a @11000'],
      null,
    ],
    [
      'that tool ends: 10 seconds from its end',
      SILENT,
      [
        [0, turnStart()],
        [1000, toolStart('a')],
        [2000, turnReply()],
        [5000, toolEnd('a')],
      ],
      14_999,
      [],
      15_000,
    ],
    [
      'a request pending with no tool: nothing',
      SILENT,
      [
        [0, turnStart()],
        [1000, turnReply()],
        [2000, approvalRequest('r')],
      ],
      600_000,
      [],
      null,
    ],
    [
      'a question pending with no tool: nothing',
      SILENT,
      [
        [0, turnStart()],
        [1000, turnReply()],
        [2000, questionRequest('q')],
      ],
      600_000,
      [],
      null,
    ],
    [
      'once it is resolved: 10 seconds from the resolution',
      SILENT,
      [
        [0, turnStart()],
        [1000, turnReply()],
        [2000, questionRequest('q')],
        [3000, questionResolved('q')],
      ],
      13_000,
      ['turn.end @13000'],
      null,
    ],
    [
      'a reply with no turn.start before it: not in a turn, nothing',
      SILENT,
      [[0, turnReply()]],
      600_000,
      [],
      null,
    ],
    [
      'a reply after the turn ended: nothing',
      SILENT,
      [
        [0, turnStart()],
        [1000, turnEnd()],
        [2000, turnReply()],
      ],
      600_000,
      [],
      null,
    ],
    [
      'a turn with no reply: nothing, it stays thinking',
      SILENT,
      [
        [0, turnStart()],
        [1000, activity()],
      ],
      600_000,
      [],
      null,
    ],
    [
      'a new turn after the reply: nothing until the next reply',
      SILENT,
      [
        [0, turnStart()],
        [1000, turnReply()],
        [2000, turnStart()],
      ],
      600_000,
      [],
      null,
    ],
    [
      'codex (turn ends exact): nothing',
      SOURCE_CAPABILITIES.codex,
      [
        [0, turnStart()],
        [1000, turnReply()],
      ],
      600_000,
      [],
      null,
    ],
    [
      'claude-code (turn ends exact): nothing',
      SOURCE_CAPABILITIES['claude-code'],
      [
        [0, turnStart()],
        [1000, turnReply()],
      ],
      600_000,
      [],
      null,
    ],
    [
      'demo (turn ends exact): nothing',
      SOURCE_CAPABILITIES.demo,
      [
        [0, turnStart()],
        [1000, turnReply()],
      ],
      600_000,
      [],
      null,
    ],
  ])('%s', (_label, capability, steps, now, guesses, next) => {
    const session = subject(feed(steps), capability);
    expect(inferred(session, now)).toStrictEqual(guesses);
    expect(nextInferenceAt(session, now, TIMINGS)).toBe(next);
  });

  it('the guess is a valid inferred turn.end, its ts the wall clock given moved back to the due time; it and its item are frozen', () => {
    const session = subject(
      feed([
        [0, turnStart()],
        [1000, turnReply()],
      ]),
      SILENT,
    );

    const guesses = inferEvents(session, 20_000, TIMINGS, WALL + 7);

    expect(guesses).toStrictEqual([
      {
        event: {
          type: 'turn.end',
          source: 'codex',
          sessionKey: 'codex:s1',
          // Noticed at 20 s, due at 11 s: 9 s earlier on the wall clock.
          ts: WALL + 7 - 9000,
          via: 'inferred',
          confidence: 'inferred',
        },
        dueAt: 11_000,
      },
    ]);
    const [guess] = guesses;
    expect(detectionEventSchema.parse(guess?.event)).toStrictEqual(
      guess?.event,
    );
    expect(Object.isFrozen(guess)).toBe(true);
    expect(Object.isFrozen(guess?.event)).toBe(true);
    expect(Object.isFrozen(guesses)).toBe(true);
  });

  it('a ts that would go below 0 stays at 0', () => {
    const session = subject(
      feed([
        [0, turnStart()],
        [1000, turnReply()],
      ]),
      SILENT,
    );
    expect(
      inferEvents(session, 20_000, TIMINGS, 5000).map(
        ({ event: guess }) => guess.ts,
      ),
    ).toStrictEqual([0]);
  });

  it('requests come with their due time too, stamped with the wall clock given', () => {
    const tools = subject(
      feed([
        [0, toolStart('a')],
        [1, toolStart('ask', 'ask_user')],
      ]),
      ASKING,
    );
    expect(
      inferEvents(tools, 20_000, TIMINGS, WALL).map(
        ({ event: guess, dueAt }) => [guess.type, guess.ts, dueAt],
      ),
    ).toStrictEqual([
      ['approval.request', WALL, 10_000],
      ['question.request', WALL, 10_001],
    ]);
  });

  it('is made once: once the reducer has it, there is nothing more', () => {
    let conditions = feed([
      [0, turnStart()],
      [1000, turnReply()],
    ]);
    const [guess] = inferEvents(
      subject(conditions, SILENT),
      11_000,
      TIMINGS,
      WALL,
    );
    if (guess === undefined) {
      throw new Error('no guess');
    }
    conditions = reduceSession(conditions, guess.event, guess.dueAt);

    expect(evaluate(conditions, 11_000, SETTINGS_DEFAULTS)).toStrictEqual({
      state: 'done',
      confidence: 'inferred',
    });
    expect(evaluate(conditions, 16_000, SETTINGS_DEFAULTS)).toStrictEqual({
      state: 'waiting',
      confidence: 'inferred',
    });
    const after = subject(conditions, SILENT);
    expect(inferEvents(after, 600_000, TIMINGS, WALL)).toStrictEqual([]);
    expect(nextInferenceAt(after, 11_000, TIMINGS)).toBeNull();
  });

  it('a replayed reply counts from the back-dated last event: already due when its source syncs', () => {
    const replayed = (live: DetectionEvent) =>
      detectionEventSchema.parse({ ...live, replay: true });
    const conditions = feed([
      [-3_600_500, replayed(turnStart())],
      [-3_600_000, replayed(turnReply())],
    ]);
    expect(inferred(subject(conditions, SILENT), 0)).toStrictEqual([
      'turn.end @-3590000',
    ]);
  });

  it('does not depend on approvalInferMs', () => {
    const session = subject(
      feed([
        [0, turnStart()],
        [1000, turnReply()],
      ]),
      SILENT,
    );
    expect(nextInferenceAt(session, 0, { approvalInferMs: 600_000 })).toBe(
      11_000,
    );
    expect(nextInferenceAt(session, 0, SETTINGS_DEFAULTS)).toBe(11_000);
  });

  it('is half-open on a fractional clock: guessed exactly at nextInferenceAt', () => {
    const start = 522_329.210_945_471_95;
    expect(start + 10_000 - start).toBeLessThan(10_000);
    const session = subject(
      feed([
        [start - 1, turnStart()],
        [start, turnReply()],
      ]),
      SILENT,
    );
    const next = nextInferenceAt(session, start, TIMINGS);
    expect(next).toBe(start + 10_000);
    const at = next as number;
    expect(inferEvents(session, at - 0.001, TIMINGS, WALL)).toStrictEqual([]);
    expect(inferred(session, at)).toStrictEqual([`turn.end @${at}`]);
    expect(nextInferenceAt(session, at, TIMINGS)).toBeNull();
  });

  it('never changes the conditions it was guessed from', () => {
    const conditions = feed([
      [0, turnStart()],
      [1000, turnReply()],
    ]);
    const before = snapshot(conditions);
    inferEvents(subject(conditions, SILENT), 20_000, TIMINGS, WALL);
    nextInferenceAt(subject(conditions, SILENT), 0, TIMINGS);
    expect(snapshot(conditions)).toStrictEqual(before);
  });
});
