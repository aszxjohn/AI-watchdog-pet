/**
 * The Claude Code adapter's record → event translation (Story 2.4): each
 * row of the spec's mapping table on hand-made records, then every fixture
 * transcript (de-identified real records) as a snapshot. The lenient
 * reading tests also cover the record helpers of the shared JSON Lines
 * core (adapters/jsonl/records: parseRecordLine, timestampOf,
 * displayNameOf, folderNameOf; shared since Story 2.6).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  currentNameEvent,
  NEW_TRANSCRIPT,
  type RecordContext,
  type TranscriptKind,
  type TranscriptState,
  translateRecord,
} from '../../src/main/detection/adapters/claude-code/translate';
import {
  displayNameOf,
  folderNameOf,
  parseRecordLine,
  timestampOf,
} from '../../src/main/detection/adapters/jsonl/records';
import {
  DETECTION_ID_MAX_LENGTH,
  type DetectionEvent,
  detectionEventSchema,
} from '../../src/shared/detection-events';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/claude-code/projects/-fixture-project',
);

const KEY = 'claude-code:11111111-2222-3333-4444-555555555555' as const;
const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const FALLBACK = 1_700_000_000_000;

const MAIN: RecordContext = {
  sessionKey: KEY,
  kind: 'main',
  replay: false,
  fallbackTs: FALLBACK,
};

/** A transcript already started and named, as after its first records. */
const STARTED: TranscriptState = {
  started: true,
  named: 'cwd',
  name: 'gundam',
  turnEnded: false,
  latestTs: T0,
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** One event as a line: type, ids, name, then `@ts`, and `replay`. */
function line(event: DetectionEvent): string {
  const parts: string[] = [event.type];
  if ('toolName' in event) {
    parts.push(event.toolName);
  }
  if ('toolCallId' in event) {
    parts.push(event.toolCallId);
  }
  if ('displayName' in event) {
    parts.push(JSON.stringify(event.displayName));
  }
  parts.push(`@${iso(event.ts)}`);
  if (event.replay === true) {
    parts.push('replay');
  }
  return parts.join(' ');
}

/** The lines `records` translate to, one after another, from `state`. */
function translate(
  records: readonly Record<string, unknown>[],
  state: TranscriptState = STARTED,
  context: RecordContext = MAIN,
): string[] {
  let current = state;
  const lines: string[] = [];
  for (const record of records) {
    const result = translateRecord(record, current, context);
    current = result.state;
    for (const event of result.events) {
      expect(detectionEventSchema.safeParse(event).success).toBe(true);
      lines.push(line(event));
    }
  }
  return lines;
}

const at = (offsetMs = 0) => iso(T0 + offsetMs);
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  timestamp: at(),
  message: { role: 'user', content },
  ...extra,
});
const assistant = (
  stopReason: string | null,
  content: unknown[] = [{ type: 'text' }],
  extra: Record<string, unknown> = {},
) => ({
  type: 'assistant',
  timestamp: at(),
  message: { role: 'assistant', stop_reason: stopReason, content },
  ...extra,
});
const toolUse = (id: string, name: string) => ({ type: 'tool_use', id, name });
const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id });

const AT = `@${at()}`;

describe('the mapping table', () => {
  it("a transcript's first record: session.start first, then the folder name from cwd", () => {
    expect(
      translate(
        [{ type: 'attachment', timestamp: at(), cwd: '/work/gundam' }],
        NEW_TRANSCRIPT,
      ),
    ).toStrictEqual([
      `session.start ${AT}`,
      `session.meta "gundam" ${AT}`,
      `activity ${AT}`,
    ]);
  });

  it('session.start comes once per transcript', () => {
    expect(
      translate(
        [{ type: 'attachment', timestamp: at() }, user('hi')],
        NEW_TRANSCRIPT,
      ),
    ).toStrictEqual([
      `session.start ${AT}`,
      `activity ${AT}`,
      `turn.start ${AT}`,
    ]);
  });

  it.each([
    ['a string', 'hi'],
    ['an empty string', ''],
    ['text blocks', [{ type: 'text', text: 'a' }, { type: 'text' }]],
    ['an image and text', [{ type: 'image' }, { type: 'text', text: 'b' }]],
  ])('user, content %s: turn.start', (_label, content) => {
    expect(translate([user(content)])).toStrictEqual([`turn.start ${AT}`]);
  });

  it.each([
    ['isMeta', { isMeta: true }],
    ['isCompactSummary', { isCompactSummary: true }],
  ])('user with %s: activity, not turn.start', (_label, extra) => {
    expect(translate([user('hi', extra)])).toStrictEqual([`activity ${AT}`]);
  });

  it('user with tool_result blocks: tool.end for each, no turn.start', () => {
    expect(
      translate([
        user([toolResult('t1'), { type: 'text', text: 'x' }, toolResult('t2')]),
      ]),
    ).toStrictEqual([`tool.end t1 ${AT}`, `tool.end t2 ${AT}`]);
  });

  it.each([
    '[Request interrupted by user]',
    '[Request interrupted by user for tool use]',
  ])(
    'user whose only text is %s: turn.end (string or one text block)',
    (text) => {
      for (const content of [
        text,
        [{ type: 'text', text }],
        [{ type: 'image' }, { type: 'text', text }],
      ]) {
        expect(translate([user(content)])).toStrictEqual([`turn.end ${AT}`]);
      }
    },
  );

  it('an interrupt text next to other text is a prompt; with a tool_result, the tool ends first', () => {
    const text = '[Request interrupted by user]';
    expect(
      translate([
        user([
          { type: 'text', text },
          { type: 'text', text: 'more' },
        ]),
        user(`${text} `),
        user([toolResult('t1'), { type: 'text', text }]),
      ]),
    ).toStrictEqual([
      `turn.start ${AT}`,
      `turn.start ${AT}`,
      `tool.end t1 ${AT}`,
      `turn.end ${AT}`,
    ]);
  });

  it.each(['end_turn', 'stop_sequence', 'max_tokens', 'refusal'])(
    'assistant, stop_reason %s: turn.end',
    (reason) => {
      expect(translate([assistant(reason)])).toStrictEqual([`turn.end ${AT}`]);
    },
  );

  it.each([['tool_use'], [null], ['pause_turn']])(
    'assistant, stop_reason %s, no tool_use: activity',
    (reason) => {
      expect(translate([assistant(reason)])).toStrictEqual([`activity ${AT}`]);
    },
  );

  it('assistant tool_use blocks: tool.start for each, before a turn.end in the same record', () => {
    expect(
      translate([
        assistant('tool_use', [
          { type: 'thinking' },
          toolUse('t1', 'Bash'),
          toolUse('t2', 'Agent'),
        ]),
        assistant('end_turn', [toolUse('t3', 'Read')]),
      ]),
    ).toStrictEqual([
      `tool.start Bash t1 ${AT}`,
      `tool.start Agent t2 ${AT}`,
      `tool.start Read t3 ${AT}`,
      `turn.end ${AT}`,
    ]);
  });

  it('assistant with isApiErrorMessage: error, then its turn.end', () => {
    expect(
      translate([assistant('stop_sequence', [], { isApiErrorMessage: true })]),
    ).toStrictEqual([`error ${AT}`, `turn.end ${AT}`]);
  });

  it('custom-title: session.meta; it outranks ai-title from then on', () => {
    expect(
      translate([
        { type: 'ai-title', aiTitle: 'AI 標題' },
        { type: 'custom-title', customTitle: '我的標題' },
        { type: 'ai-title', aiTitle: '另一個 AI 標題' },
        { type: 'custom-title', customTitle: '新標題' },
      ]),
    ).toStrictEqual([
      `session.meta "AI 標題" ${AT}`,
      `session.meta "我的標題" ${AT}`,
      `session.meta "新標題" ${AT}`,
    ]);
  });

  it('a title before any cwd: the folder name is not sent', () => {
    expect(
      translate(
        [
          { type: 'custom-title', customTitle: '標題' },
          user('hi', { cwd: '/work/gundam' }),
        ],
        NEW_TRANSCRIPT,
      ),
    ).toStrictEqual([
      // No timestamp yet: the fallback.
      `session.start @${iso(FALLBACK)}`,
      `session.meta "標題" @${iso(FALLBACK)}`,
      `turn.start ${AT}`,
    ]);
  });

  it('the folder name is sent once, from the first record with a cwd', () => {
    expect(
      translate(
        [
          { type: 'attachment', timestamp: at() },
          user('hi', { cwd: '/work/first' }),
          user('hi', { cwd: '/work/second' }),
        ],
        NEW_TRANSCRIPT,
      ),
    ).toStrictEqual([
      `session.start ${AT}`,
      `activity ${AT}`,
      `session.meta "first" ${AT}`,
      `turn.start ${AT}`,
      `turn.start ${AT}`,
    ]);
  });

  it('a blank or missing title is no title: the name stays, the folder name may still come', () => {
    expect(
      translate(
        [
          { type: 'custom-title', customTitle: '  ' },
          { type: 'ai-title' },
          { type: 'system', timestamp: at(), cwd: '/work/gundam' },
        ],
        NEW_TRANSCRIPT,
      ),
    ).toStrictEqual([
      `session.start @${iso(FALLBACK)}`,
      `session.meta "gundam" ${AT}`,
      `activity ${AT}`,
    ]);
  });

  it('other records with a timestamp: activity; without one: nothing', () => {
    expect(
      translate([
        { type: 'system', subtype: 'stop_hook_summary', timestamp: at() },
        { type: 'queue-operation', timestamp: at() },
        { type: 'file-history-snapshot' },
        { type: 'last-prompt' },
        { no: 'type', timestamp: at() },
        { type: 'user' },
      ]),
    ).toStrictEqual([`activity ${AT}`, `activity ${AT}`, `activity ${AT}`]);
  });

  it('a record without a timestamp is dated at the latest timestamp read so far', () => {
    expect(
      translate([
        { type: 'system', timestamp: at(5000) },
        { type: 'system', timestamp: at(1000) },
        { type: 'custom-title', customTitle: '標題' },
        assistant('end_turn', [], { timestamp: undefined }),
      ]),
    ).toStrictEqual([
      `activity @${at(5000)}`,
      `activity @${at(1000)}`,
      `session.meta "標題" @${at(5000)}`,
      `turn.end @${at(5000)}`,
    ]);
  });

  it('replayed: every event carries replay', () => {
    expect(
      translate([user('hi'), assistant('end_turn')], STARTED, {
        ...MAIN,
        replay: true,
      }),
    ).toStrictEqual([`turn.start ${AT} replay`, `turn.end ${AT} replay`]);
  });

  it("a subagent transcript: its tool calls are the parent session's; every other record is an activity of it", () => {
    const subagent: RecordContext = { ...MAIN, kind: 'subagent' };
    const result = translateRecord(user('hi'), NEW_TRANSCRIPT, subagent);
    expect(result.events.map(line)).toStrictEqual([`activity ${AT}`]);
    expect(result.events[0]?.sessionKey).toBe(KEY);
    expect(result.state).toStrictEqual({ ...NEW_TRANSCRIPT, latestTs: T0 });
    expect(
      translate(
        [
          assistant('tool_use', [{ type: 'thinking' }, toolUse('t1', 'Bash')]),
          user([toolResult('t1'), { type: 'text', text: 'x' }]),
          assistant('end_turn', [toolUse('t2', 'Read')], {
            isApiErrorMessage: true,
          }),
          assistant('end_turn'),
          user('[Request interrupted by user]'),
          { type: 'api-request-blob' },
          { type: 'custom-title', customTitle: '標題', cwd: '/x' },
          assistant('tool_use', [{ type: 'tool_use', name: 'Bash' }]),
        ],
        result.state,
        subagent,
      ),
    ).toStrictEqual([
      `tool.start Bash t1 ${AT}`,
      `tool.end t1 ${AT}`,
      `tool.start Read t2 ${AT}`,
      `activity ${AT}`,
      `activity ${AT}`,
      `activity ${AT}`,
      `activity ${AT}`,
      `activity ${AT}`,
    ]);
  });

  it('a turn.end right after a turn.end is left out; a turn.start or tool.start in between resets it', () => {
    expect(
      translate([
        assistant('end_turn'),
        assistant('end_turn'),
        user('[Request interrupted by user]'),
        assistant('stop_sequence', [], { isApiErrorMessage: true }),
        user([toolResult('t0')]),
        assistant('end_turn'),
        user('hi'),
        assistant('end_turn'),
        assistant('tool_use', [toolUse('t1', 'Bash')]),
        user([toolResult('t1')]),
        assistant('end_turn'),
        assistant('end_turn', [toolUse('t2', 'Read')]),
      ]),
    ).toStrictEqual([
      `turn.end ${AT}`,
      // The repeats are records with nothing else: activity instead.
      `activity ${AT}`,
      `activity ${AT}`,
      `error ${AT}`,
      `tool.end t0 ${AT}`,
      `activity ${AT}`,
      `turn.start ${AT}`,
      `turn.end ${AT}`,
      `tool.start Bash t1 ${AT}`,
      `tool.end t1 ${AT}`,
      `turn.end ${AT}`,
      `tool.start Read t2 ${AT}`,
      `turn.end ${AT}`,
    ]);
  });

  it('a new transcript has not ended a turn: its first turn.end is sent (a tail can start mid-turn)', () => {
    expect(translate([assistant('end_turn')], NEW_TRANSCRIPT)).toStrictEqual([
      `session.start ${AT}`,
      `turn.end ${AT}`,
    ]);
  });

  it('currentNameEvent: the name last sent, at the latest timestamp, for a main transcript only', () => {
    expect(currentNameEvent(STARTED, MAIN)).toMatchObject({
      type: 'session.meta',
      sessionKey: KEY,
      displayName: 'gundam',
      ts: T0,
    });
    expect(currentNameEvent(STARTED, { ...MAIN, replay: true })?.replay).toBe(
      true,
    );
    expect(currentNameEvent({ ...STARTED, latestTs: null }, MAIN)?.ts).toBe(
      FALLBACK,
    );
    expect(currentNameEvent({ ...STARTED, name: null }, MAIN)).toBeNull();
    expect(currentNameEvent(STARTED, { ...MAIN, kind: 'subagent' })).toBeNull();
    const titled = translate(
      [{ type: 'custom-title', customTitle: '新標題' }],
      STARTED,
    );
    expect(titled).toStrictEqual([`session.meta "新標題" ${AT}`]);
  });

  it('every event is via log, exact, from claude-code, for the given session', () => {
    const { events } = translateRecord(
      assistant('end_turn', [toolUse('t1', 'Bash')], {
        isApiErrorMessage: true,
        cwd: '/w',
      }),
      NEW_TRANSCRIPT,
      MAIN,
    );
    expect(events.length).toBe(5);
    for (const event of events) {
      expect(event).toMatchObject({
        source: 'claude-code',
        sessionKey: KEY,
        via: 'log',
        confidence: 'exact',
      });
      expect('replay' in event).toBe(false);
    }
  });

  it('returns the same state object when nothing it remembers changed', () => {
    const record = { type: 'system', timestamp: at() };
    expect(translateRecord(record, STARTED, MAIN).state).toBe(STARTED);
  });
});

describe('lenient reading', () => {
  it('fields of the wrong type count as missing; nothing throws', () => {
    expect(
      translate([
        { type: 'user', timestamp: at(), message: 'not an object' },
        { type: 'user', timestamp: at(), message: { content: 42 } },
        {
          type: 'user',
          timestamp: at(),
          isMeta: 'yes',
          message: { content: 'x' },
        },
        {
          type: 'assistant',
          timestamp: at(),
          isApiErrorMessage: 'true',
          message: {
            stop_reason: 1,
            content: ['text', null, toolUse('t1', 'Bash')],
          },
        },
        { type: 'custom-title', customTitle: 7 },
        { type: 'user', timestamp: 'yesterday', message: { content: 'x' } },
      ]),
    ).toStrictEqual([
      `activity ${AT}`,
      `activity ${AT}`,
      `turn.start ${AT}`,
      `tool.start Bash t1 ${AT}`,
      `turn.start ${AT}`,
    ]);
  });

  it('a tool block without a usable id or name gives no event', () => {
    const long = 'x'.repeat(DETECTION_ID_MAX_LENGTH + 1);
    expect(
      translate([
        assistant('tool_use', [
          { type: 'tool_use', name: 'Bash' },
          { type: 'tool_use', id: '', name: 'Bash' },
          { type: 'tool_use', id: long, name: 'Bash' },
          { type: 'tool_use', id: 't1' },
          { type: 'tool_use', id: 't2', name: long },
        ]),
        user([
          { type: 'tool_result' },
          { type: 'tool_result', tool_use_id: 5 },
        ]),
      ]),
    ).toStrictEqual([`activity ${AT}`, `activity ${AT}`]);
  });

  it('parseRecordLine: a JSON object is a record; anything else is a bad line', () => {
    expect(parseRecordLine('{"type":"user","x":[1]}')).toStrictEqual({
      type: 'user',
      x: [1],
    });
    for (const bad of ['{', 'null', '[]', '"text"', '42', 'true', '{"a":1}x']) {
      expect(parseRecordLine(bad)).toBeNull();
    }
  });

  it.each<[unknown, number | null]>([
    ['2026-03-01T10:00:00.000Z', T0],
    ['2026-03-01T10:00:00.999Z', T0 + 999],
    [T0 + 0.7, T0],
    ['not a date', null],
    [-1, null],
    [Number.NaN, null],
    [1e20, null],
    [undefined, null],
    [{}, null],
  ])('timestampOf(%s) is %s', (timestamp, expected) => {
    expect(timestampOf({ timestamp })).toBe(expected);
  });

  it('display names are trimmed and cut to the id length, never in the middle of a surrogate pair', () => {
    expect(displayNameOf('  標題 ')).toBe('標題');
    expect(displayNameOf('')).toBeNull();
    expect(displayNameOf(3)).toBeNull();
    const max = DETECTION_ID_MAX_LENGTH;
    expect(displayNameOf('a'.repeat(max + 10))).toBe('a'.repeat(max));
    const emoji = `${'a'.repeat(max - 1)}😀`;
    expect(displayNameOf(emoji)).toBe('a'.repeat(max - 1));
  });

  it.each([
    ['/work/gundam', 'gundam'],
    ['/work/gundam/', 'gundam'],
    ['C:\\work\\gundam', 'gundam'],
    ['/', '/'],
    ['gundam', 'gundam'],
    ['', null],
    [undefined, null],
  ])('folderNameOf(%s) is %s', (cwd, expected) => {
    expect(folderNameOf(cwd)).toBe(expected);
  });
});

describe('fixtures (de-identified real transcripts)', () => {
  interface FixtureFile {
    readonly label: string;
    readonly file: string;
    readonly id: string;
    readonly kind: TranscriptKind;
  }

  /** Every fixture transcript, each session followed by its subagents. */
  function fixtureFiles(): FixtureFile[] {
    const own = readdirSync(FIXTURES)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
    return own.flatMap((name) => {
      const id = name.slice(0, -'.jsonl'.length);
      const subDir = path.join(FIXTURES, id, 'subagents');
      let subs: string[] = [];
      try {
        subs = readdirSync(subDir).filter((sub) => sub.endsWith('.jsonl'));
      } catch {
        // No subagents.
      }
      return [
        { label: name, file: path.join(FIXTURES, name), id, kind: 'main' },
        ...subs.sort().map(
          (sub): FixtureFile => ({
            label: `${id}/subagents/${sub}`,
            file: path.join(subDir, sub),
            id,
            kind: 'subagent',
          }),
        ),
      ];
    });
  }

  it('covers a session, its subagent and the /clear pair', () => {
    expect(fixtureFiles().map(({ label }) => label)).toStrictEqual([
      '00000000-0000-4000-8000-000000000001.jsonl',
      '00000000-0000-4000-8000-000000000002.jsonl',
      '00000000-0000-4000-8000-000000000003.jsonl',
      '00000000-0000-4000-8000-000000000003/subagents/agent-fixture-1.jsonl',
      '00000000-0000-4000-8000-000000000004.jsonl',
      '00000000-0000-4000-8000-000000000005.jsonl',
      '00000000-0000-4000-8000-000000000006.jsonl',
    ]);
  });

  it.each(fixtureFiles().map((entry) => [entry.label, entry] as const))(
    '%s',
    (_label, { file, id, kind }) => {
      const records = readFileSync(file, 'utf8')
        .split('\n')
        .filter((text) => text !== '')
        .map((text) => {
          const record = parseRecordLine(text);
          expect(record).not.toBeNull();
          return record ?? {};
        });
      const lines = translate(records, NEW_TRANSCRIPT, {
        sessionKey: `claude-code:${id}`,
        kind,
        replay: false,
        fallbackTs: 0,
      });
      expect(lines.join('\n')).toMatchSnapshot();
    },
  );

  it('between them, they show every kind of event the table maps to', () => {
    const types = new Set<string>();
    for (const { file, id, kind } of fixtureFiles()) {
      let state = NEW_TRANSCRIPT;
      for (const text of readFileSync(file, 'utf8').split('\n')) {
        const record = text === '' ? null : parseRecordLine(text);
        if (record === null) {
          continue;
        }
        const result = translateRecord(record, state, {
          sessionKey: `claude-code:${id}`,
          kind,
          replay: false,
          fallbackTs: 0,
        });
        state = result.state;
        for (const event of result.events) {
          types.add(
            event.type === 'tool.start' && event.toolName === 'AskUserQuestion'
              ? 'tool.start AskUserQuestion'
              : event.type,
          );
        }
      }
    }
    expect([...types].sort()).toStrictEqual([
      'activity',
      'error',
      'session.meta',
      'session.start',
      'tool.end',
      'tool.start',
      'tool.start AskUserQuestion',
      'turn.end',
      'turn.start',
    ]);
  });
});
