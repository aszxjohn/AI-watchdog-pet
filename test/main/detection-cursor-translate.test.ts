/**
 * The Cursor adapter's record → event translation (Story 2.7): each row of
 * the spec's mapping table on hand-made records, then every fixture
 * transcript (de-identified real records) as a snapshot.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  currentNameEvent,
  endedInError,
  NEW_TRANSCRIPT,
  type RecordContext,
  type TranscriptState,
  translateRecord,
  USER_ABORTED,
} from '../../src/main/detection/adapters/cursor/translate';
import { parseRecordLine } from '../../src/main/detection/adapters/jsonl/records';
import {
  type DetectionEvent,
  detectionEventSchema,
} from '../../src/shared/detection-events';
import { filesUnder } from '../helpers/jsonl-adapter';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/cursor/projects/fixture-project/agent-transcripts',
);

const KEY = 'cursor:0a1b2c3d-0000-4000-8000-00000000abcd' as const;
const MTIME = Date.parse('2026-03-01T10:00:00.000Z');

const MAIN: RecordContext = {
  kind: 'main',
  sessionKey: KEY,
  name: 'gundam-pet',
  replay: false,
  fallbackTs: MTIME,
};

const SUBAGENT: RecordContext = { ...MAIN, kind: 'subagent', name: null };

/** A transcript already started, as after its first prompt. */
const STARTED: TranscriptState = { ...NEW_TRANSCRIPT, started: true };

/** One event as a line: type, key (when not KEY's), ids, name, `replay`. */
function line(event: DetectionEvent): string {
  const parts: string[] = [event.type];
  if (event.sessionKey !== KEY) {
    parts.push(event.sessionKey);
  }
  if ('toolName' in event) {
    parts.push(event.toolName);
  }
  if ('toolCallId' in event) {
    parts.push(event.toolCallId);
  }
  if ('displayName' in event) {
    parts.push(JSON.stringify(event.displayName));
  }
  if (event.replay === true) {
    parts.push('replay');
  }
  return parts.join(' ');
}

/** The lines `records` translate to, one after another, from `state`. */
function run(
  records: readonly Record<string, unknown>[],
  state: TranscriptState = STARTED,
  context: RecordContext = MAIN,
): { lines: string[]; state: TranscriptState } {
  let current = state;
  const lines: string[] = [];
  for (const record of records) {
    const result = translateRecord(record, current, context);
    current = result.state;
    for (const event of result.events) {
      expect(detectionEventSchema.safeParse(event).success).toBe(true);
      expect(event.via).toBe('log');
      expect(event.confidence).toBe('exact');
      expect(event.ts).toBe(context.fallbackTs);
      lines.push(line(event));
    }
  }
  return { lines, state: current };
}

const translate = (
  records: readonly Record<string, unknown>[],
  state: TranscriptState = STARTED,
  context: RecordContext = MAIN,
) => run(records, state, context).lines;

const user = (text = 'hi') => ({
  role: 'user',
  message: { content: [{ type: 'text', text }] },
});
const assistant = (...tools: unknown[]) => ({
  role: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'ok' },
      ...tools.map((name) => ({ type: 'tool_use', name, input: {} })),
    ],
  },
});
const ended = (status = 'success', error?: unknown) =>
  error === undefined
    ? { type: 'turn_ended', status }
    : { type: 'turn_ended', status, error };

describe('a session’s own transcript', () => {
  it('the first user message: session.start, the name, then turn.start', () => {
    expect(translate([user()], NEW_TRANSCRIPT)).toStrictEqual([
      'session.start',
      'session.meta "gundam-pet"',
      'turn.start',
    ]);
  });

  it('the first assistant message starts the session too (a transcript replayed from its tail)', () => {
    expect(translate([assistant()], NEW_TRANSCRIPT)).toStrictEqual([
      'session.start',
      'session.meta "gundam-pet"',
      'activity',
    ]);
  });

  it('no name: no session.meta', () => {
    expect(
      translate([user()], NEW_TRANSCRIPT, { ...MAIN, name: null }),
    ).toStrictEqual(['session.start', 'turn.start']);
  });

  it('before the first message, nothing at all', () => {
    expect(
      translate([ended(), { type: 'other' }, {}], NEW_TRANSCRIPT),
    ).toStrictEqual([]);
  });

  it('an assistant message with tool_use parts: tool.start for each, numbered by step and place; the next record ends them', () => {
    expect(
      translate([
        user(),
        assistant('Read', 'Shell'),
        assistant('StrReplace'),
        assistant(),
        user('more'),
      ]),
    ).toStrictEqual([
      'turn.start',
      'tool.start Read step1:1',
      'tool.start Shell step1:2',
      'tool.end step1:1',
      'tool.end step1:2',
      'tool.start StrReplace step2:1',
      'tool.end step2:1',
      'activity',
      'turn.start',
    ]);
  });

  it('a user message ends the tool calls left open too', () => {
    expect(translate([assistant('Shell'), user()])).toStrictEqual([
      'tool.start Shell step1:1',
      'tool.end step1:1',
      'turn.start',
    ]);
  });

  it('a tool_use with no usable name gives no event, but keeps its place; with none usable, activity', () => {
    const { lines, state } = run([
      assistant(42, 'Shell', '', 'x'.repeat(257)),
      assistant(null),
    ]);
    expect(lines).toStrictEqual([
      'tool.start Shell step1:2',
      'tool.end step1:2',
      'activity',
    ]);
    expect(state.step).toBe(2);
    expect(state.openTools).toStrictEqual([]);
  });

  it('an assistant message with only text: activity', () => {
    expect(translate([assistant()])).toStrictEqual(['activity']);
  });

  it('turn_ended success: turn.end, which closes the tool calls left open', () => {
    const { lines, state } = run([assistant('Shell'), ended()]);
    expect(lines).toStrictEqual(['tool.start Shell step1:1', 'turn.end']);
    expect(state.openTools).toStrictEqual([]);
    expect(state.turnEnded).toBe(true);
  });

  it(`turn_ended with error ${USER_ABORTED}: the user stopped it, turn.end only`, () => {
    expect(translate([user(), ended('error', USER_ABORTED)])).toStrictEqual([
      'turn.start',
      'turn.end',
    ]);
  });

  it.each([
    ['another error', ended('error', 'Connection failed')],
    ['status error with no error', ended('error')],
    ['an error with another status', ended('failed', 'Rate limited')],
  ])('turn_ended with %s: error, then turn.end', (_label, record) => {
    expect(translate([user(), record])).toStrictEqual([
      'turn.start',
      'error',
      'turn.end',
    ]);
  });

  it.each([
    ['success with an error', ended('success', 'x')],
    ['another status, no error', ended('cancelled')],
    ['no status', { type: 'turn_ended' }],
    ['a blank error', ended('stopped', '  ')],
  ])('turn_ended with %s: turn.end only', (_label, record) => {
    expect(translate([user(), record])).toStrictEqual([
      'turn.start',
      'turn.end',
    ]);
  });

  it('two turn_ended in a row count once; a repeated one sends activity', () => {
    expect(
      translate([
        user(),
        ended(),
        ended('error', USER_ABORTED),
        user(),
        ended('error', USER_ABORTED),
        ended(),
      ]),
    ).toStrictEqual([
      'turn.start',
      'turn.end',
      'activity',
      'turn.start',
      'turn.end',
      'activity',
    ]);
  });

  it('a repeated turn_ended with another error: the error, no second turn.end', () => {
    expect(
      translate([user(), ended(), ended('error', 'Connection failed')]),
    ).toStrictEqual(['turn.start', 'turn.end', 'error']);
  });

  it('a tool call after a turn end resets it: the next turn_ended counts', () => {
    expect(translate([ended(), assistant('Shell'), ended()])).toStrictEqual([
      'turn.end',
      'tool.start Shell step1:1',
      'turn.end',
    ]);
  });

  it('any other record: activity (after the tool calls left open end)', () => {
    expect(
      translate([
        assistant('Shell'),
        { role: 'system', message: { content: [] } },
        { type: 'summary' },
        'not a record' as unknown as Record<string, unknown>,
      ]).slice(0, 3),
    ).toStrictEqual([
      'tool.start Shell step1:1',
      'tool.end step1:1',
      'activity',
    ]);
  });

  it('content that is not a part list: no tool calls', () => {
    expect(
      translate([
        { role: 'assistant', message: { content: 'text' } },
        { role: 'assistant', message: 'x' },
        { role: 'assistant' },
      ]),
    ).toStrictEqual(['activity', 'activity', 'activity']);
  });

  it('replayed records: every event carries replay', () => {
    expect(
      translate([user(), assistant('Shell')], NEW_TRANSCRIPT, {
        ...MAIN,
        replay: true,
      }),
    ).toStrictEqual([
      'session.start replay',
      'session.meta "gundam-pet" replay',
      'turn.start replay',
      'tool.start Shell step1:1 replay',
    ]);
  });
});

describe('a subagent’s transcript', () => {
  it("every record is the parent session's activity, from the first", () => {
    expect(
      translate(
        [user(), assistant('Read'), ended(), ended('error', 'x'), {}],
        NEW_TRANSCRIPT,
        SUBAGENT,
      ),
    ).toStrictEqual([
      'activity',
      'activity',
      'activity',
      'activity',
      'activity',
    ]);
  });
});

describe('endedInError', () => {
  it.each([
    [ended(), false],
    [ended('error', USER_ABORTED), false],
    [ended('success', USER_ABORTED), false],
    [ended('error', 'x'), true],
    [ended('error'), true],
    [ended('error', 42), true],
    [ended('other', 'x'), true],
    [ended('other'), false],
  ])('%j is %s', (record, expected) => {
    expect(endedInError(record)).toBe(expected);
  });
});

describe('currentNameEvent', () => {
  it('the name, dated at the file’s modification time, once the session started', () => {
    expect(currentNameEvent(STARTED, MAIN)).toStrictEqual({
      type: 'session.meta',
      source: 'cursor',
      sessionKey: KEY,
      ts: MTIME,
      via: 'log',
      confidence: 'exact',
      displayName: 'gundam-pet',
    });
    expect(currentNameEvent(STARTED, { ...MAIN, replay: true })).toMatchObject({
      replay: true,
    });
  });

  it('none before the session started, with no name, or for a subagent', () => {
    expect(currentNameEvent(NEW_TRANSCRIPT, MAIN)).toBeNull();
    expect(currentNameEvent(STARTED, { ...MAIN, name: null })).toBeNull();
    expect(currentNameEvent(STARTED, SUBAGENT)).toBeNull();
  });
});

describe('fixtures (de-identified real transcripts)', () => {
  // With `/` on every platform: the snapshots are named after them.
  const files = filesUnder(FIXTURES).map((file) =>
    file.split(path.sep).join('/'),
  );
  const sessions = files.filter((file) => !file.includes('subagents'));
  const subagents = files.filter((file) => file.includes('subagents'));

  /** The records of fixture `file`, every line a record. */
  function recordsOf(file: string): Record<string, unknown>[] {
    return readFileSync(path.join(FIXTURES, ...file.split('/')), 'utf8')
      .split('\n')
      .filter((text) => text !== '')
      .map((text) => {
        const record = parseRecordLine(text);
        expect(record).not.toBeNull();
        return record ?? {};
      });
  }

  /** Fixture `file` translated from its start, as the adapter would. */
  function translateFixture(
    file: string,
    kind: RecordContext['kind'] = 'main',
  ): DetectionEvent[] {
    let state = NEW_TRANSCRIPT;
    const events: DetectionEvent[] = [];
    for (const record of recordsOf(file)) {
      const result = translateRecord(record, state, {
        ...(kind === 'main' ? MAIN : SUBAGENT),
        name: kind === 'main' ? 'fixture-project' : null,
        fallbackTs: 0,
      });
      state = result.state;
      events.push(...result.events);
    }
    return events;
  }

  it('are four sessions and one subagent', () => {
    expect(sessions).toHaveLength(4);
    expect(subagents).toHaveLength(1);
  });

  it.each(sessions)('%s', (file) => {
    const events = translateFixture(file);
    for (const event of events) {
      expect(detectionEventSchema.safeParse(event).success).toBe(true);
    }
    expect(events.map(line).join('\n')).toMatchSnapshot();
  });

  it("the subagent's records are only its parent's activity", () => {
    const [file = ''] = subagents;
    const events = translateFixture(file, 'subagent');
    expect(events.length).toBe(recordsOf(file).length);
    expect(new Set(events.map((event) => event.type))).toStrictEqual(
      new Set(['activity']),
    );
  });

  it('between them, they show tools, AskQuestion, the user stopping, other errors and two turn ends in a row', () => {
    const all = sessions.flatMap((file) => translateFixture(file));
    const types = new Set(all.map((event) => event.type));
    expect([...types].sort()).toStrictEqual([
      'activity',
      'error',
      'session.meta',
      'session.start',
      'tool.end',
      'tool.start',
      'turn.end',
      'turn.start',
    ]);
    expect(
      all.some(
        (event) =>
          event.type === 'tool.start' && event.toolName === 'AskQuestion',
      ),
    ).toBe(true);
    const records = sessions.flatMap(recordsOf);
    expect(
      records.filter((record) => record.error === USER_ABORTED).length,
    ).toBeGreaterThan(0);
    const ends = sessions.map((file) =>
      recordsOf(file).map((record) => record.type === 'turn_ended'),
    );
    expect(
      ends.some((flags) => flags.some((flag, i) => flag && flags[i - 1])),
    ).toBe(true);
  });
});
