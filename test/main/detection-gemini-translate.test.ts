/**
 * The Gemini CLI adapter's record → event translation (Story 2.6): each row
 * of the spec's mapping table on hand-made records (the cases the local
 * samples lack, errors, Esc, subagents, summaries and `$set.sessionId`,
 * among them), the starting state from the header, then every fixture chat
 * log (de-identified real records) as a snapshot.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type ChatState,
  currentNameEvent,
  hasText,
  headerSessionId,
  isFunctionResponse,
  NEW_CHAT,
  type RecordContext,
  REQUEST_CANCELLED,
  startChat,
  translateRecord,
} from '../../src/main/detection/adapters/gemini/translate';
import { parseRecordLine } from '../../src/main/detection/adapters/jsonl/records';
import {
  DETECTION_ID_MAX_LENGTH,
  type DetectionEvent,
  detectionEventSchema,
} from '../../src/shared/detection-events';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/gemini/tmp/fixture-project/chats',
);

const ID = '11111111-2222-3333-4444-555555555555';
const PARENT = 'gemini:99999999-0000-4000-8000-000000000009' as const;
const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const FALLBACK = 1_700_000_000_000;

const MAIN: RecordContext = {
  kind: 'main',
  project: 'gundam',
  parentKey: null,
  replay: false,
  fallbackTs: FALLBACK,
};

const SUBAGENT: RecordContext = {
  ...MAIN,
  kind: 'subagent',
  parentKey: PARENT,
};

/** A chat log whose header was read, nothing else. */
const FRESH: ChatState = { ...NEW_CHAT, sessionId: ID, project: 'gundam' };

/** A chat log already started and named, as after its first prompt. */
const STARTED: ChatState = { ...FRESH, started: true, latestTs: T0 };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** One event as a line: type, key (when not ID's), ids, name, `@ts`, `replay`. */
function line(event: DetectionEvent): string {
  const parts: string[] = [event.type];
  if (event.sessionKey !== `gemini:${ID}`) {
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
  parts.push(`@${iso(event.ts)}`);
  if (event.replay === true) {
    parts.push('replay');
  }
  return parts.join(' ');
}

/** The lines `records` translate to, one after another, from `state`. */
function run(
  records: readonly Record<string, unknown>[],
  state: ChatState = STARTED,
  context: RecordContext = MAIN,
): { lines: string[]; state: ChatState } {
  let current = state;
  const lines: string[] = [];
  for (const record of records) {
    const result = translateRecord(record, current, context);
    current = result.state;
    for (const event of result.events) {
      expect(detectionEventSchema.safeParse(event).success).toBe(true);
      expect(event.via).toBe('log');
      expect(event.confidence).toBe('exact');
      lines.push(line(event));
    }
  }
  return { lines, state: current };
}

const translate = (
  records: readonly Record<string, unknown>[],
  state: ChatState = STARTED,
  context: RecordContext = MAIN,
) => run(records, state, context).lines;

const at = (offsetMs = 0) => iso(T0 + offsetMs);
const header = (sessionId = ID) => ({
  sessionId,
  projectHash: 'h',
  startTime: at(-5000),
  lastUpdated: at(-5000),
  kind: 'main',
});
const msg = (type: string, id: string, content: unknown, offsetMs = 0) => ({
  type,
  id,
  timestamp: at(offsetMs),
  content,
});
const prompt = (id = 'u1', offsetMs = 0) =>
  msg('user', id, [{ text: 'hi' }], offsetMs);
const reply = (id = 'g1', text = 'done', offsetMs = 0) =>
  msg('gemini', id, text, offsetMs);
const toolCall = (id: string, name: string, status = 'success') => ({
  id,
  name,
  status,
  timestamp: at(),
});
const withTools = (id: string, calls: readonly unknown[], text = '') => ({
  ...msg('gemini', id, text),
  toolCalls: calls,
});
const functionResponse = (id = 'u2') =>
  msg('user', id, [
    { functionResponse: { id: 'c1', name: 'x', response: {} } },
  ]);
const info = (content: unknown, id = 'i1') => msg('info', id, content);

const AT = `@${at()}`;

describe('the header and the starting state', () => {
  it('a chat log starts from a header with a usable session id, named after its project folder', () => {
    expect(startChat(header(), { project: 'gundam' })).toStrictEqual(FRESH);
    expect(startChat(header(), { project: '  my project  ' })?.project).toBe(
      'my project',
    );
    expect(headerSessionId(header())).toBe(ID);
  });

  it.each([
    ['nothing (no complete first line)', null],
    ['a message', prompt()],
    ['a $set', { $set: { sessionId: ID } }],
    ['a header with no session id', { kind: 'main' }],
    ['a header with an empty session id', header('')],
    ['a header with a control character in its id', header('a\u0000b')],
    [
      'a header with an id too long',
      header('x'.repeat(DETECTION_ID_MAX_LENGTH + 1)),
    ],
  ])('not followed when the first line is %s', (_label, first) => {
    expect(startChat(first, { project: 'gundam' })).toBeNull();
  });

  it('the header read again (from the start) sends nothing', () => {
    expect(translate([header()], FRESH)).toStrictEqual([]);
    expect(translate([header()], STARTED)).toStrictEqual([]);
  });

  it('a header with another session id switches sessions, as $set.sessionId does', () => {
    const other = '22222222-0000-4000-8000-000000000002';
    expect(translate([header(other), prompt()])).toStrictEqual([
      `session.end ${AT}`,
      `session.start gemini:${other} ${AT}`,
      `session.meta gemini:${other} "gundam" ${AT}`,
      `turn.start gemini:${other} ${AT}`,
    ]);
  });
});

describe('the mapping table', () => {
  it('the first user message: session.start, then the project folder name, then turn.start', () => {
    expect(translate([prompt()], FRESH)).toStrictEqual([
      `session.start ${AT}`,
      `session.meta "gundam" ${AT}`,
      `turn.start ${AT}`,
    ]);
  });

  it('a gemini message can start the session too', () => {
    expect(translate([reply()], FRESH)).toStrictEqual([
      `session.start ${AT}`,
      `session.meta "gundam" ${AT}`,
      `turn.reply ${AT}`,
    ]);
  });

  it('只開沒問: before the first prompt, info and every other record send nothing', () => {
    const { lines, state } = run(
      [
        { $set: { messages: [], lastUpdated: at() } },
        info('Loaded something'),
        info(REQUEST_CANCELLED, 'i2'),
        msg('error', 'e1', 'quota'),
        msg('warning', 'w1', 'careful'),
        { $set: { lastUpdated: at() } },
      ],
      FRESH,
    );
    expect(lines).toStrictEqual([]);
    expect(state.started).toBe(false);
  });

  it('a summary read before the first prompt names the session when it starts', () => {
    expect(
      translate([{ $set: { summary: '修好登入' } }, prompt()], FRESH),
    ).toStrictEqual([
      `session.start ${AT}`,
      `session.meta "修好登入" ${AT}`,
      `turn.start ${AT}`,
    ]);
  });

  it('呼叫工具: a gemini message with no text and no toolCalls is the pending placeholder', () => {
    expect(translate([reply('g1', '')])).toStrictEqual([
      `tool.start pending pending:g1 ${AT}`,
    ]);
    expect(translate([reply('g1', '   \n')])).toStrictEqual([
      `tool.start pending pending:g1 ${AT}`,
    ]);
    expect(translate([msg('gemini', 'g1', [{ text: '' }])])).toStrictEqual([
      `tool.start pending pending:g1 ${AT}`,
    ]);
  });

  it('工具做完: the same id written again with toolCalls ends the placeholder, then start and end per call, then turn.start', () => {
    expect(
      translate([
        reply('g1', ''),
        withTools('g1', [
          toolCall('glob__a1', 'glob'),
          toolCall('read_file__b2', 'read_file', 'error'),
        ]),
      ]),
    ).toStrictEqual([
      `tool.start pending pending:g1 ${AT}`,
      `tool.end pending:g1 ${AT}`,
      `tool.start glob glob__a1 ${AT}`,
      `tool.end glob__a1 ${AT}`,
      `tool.start read_file read_file__b2 ${AT}`,
      `tool.end read_file__b2 ${AT}`,
      `turn.start ${AT}`,
    ]);
  });

  it('有文字的回覆: a gemini message with text is turn.reply; written again with toolCalls, its calls and turn.start', () => {
    expect(
      translate([
        reply('g1', 'Let me check.'),
        withTools(
          'g1',
          [toolCall('run_shell_command__c3', 'run_shell_command')],
          'Let me check.',
        ),
      ]),
    ).toStrictEqual([
      `turn.reply ${AT}`,
      `tool.start run_shell_command run_shell_command__c3 ${AT}`,
      `tool.end run_shell_command__c3 ${AT}`,
      `turn.start ${AT}`,
    ]);
  });

  it('拒絕批准: every call cancelled sends no turn.start; the Request cancelled. after it ends the turn', () => {
    expect(
      translate([
        reply('g1', ''),
        withTools('g1', [
          toolCall('run_shell_command__d4', 'run_shell_command', 'cancelled'),
        ]),
        info(REQUEST_CANCELLED),
        functionResponse(),
      ]),
    ).toStrictEqual([
      `tool.start pending pending:g1 ${AT}`,
      `tool.end pending:g1 ${AT}`,
      `tool.start run_shell_command run_shell_command__d4 ${AT}`,
      `tool.end run_shell_command__d4 ${AT}`,
      `turn.end ${AT}`,
      `activity ${AT}`,
    ]);
  });

  it('中斷: only the Request cancelled. info ends the turn (in any form it is written)', () => {
    expect(translate([info(REQUEST_CANCELLED)])).toStrictEqual([
      `turn.end ${AT}`,
    ]);
    expect(translate([info(` ${REQUEST_CANCELLED}\n`)])).toStrictEqual([
      `turn.end ${AT}`,
    ]);
    expect(translate([info([{ text: REQUEST_CANCELLED }])])).toStrictEqual([
      `turn.end ${AT}`,
    ]);
  });

  it('錯誤: an error message is error, then turn.end', () => {
    expect(translate([msg('error', 'e1', 'API error')])).toStrictEqual([
      `error ${AT}`,
      `turn.end ${AT}`,
    ]);
  });

  it('標題: $set.summary is session.meta with it, and outranks the folder name from then on', () => {
    const { lines, state } = run([
      { $set: { summary: '  修好登入  ', lastUpdated: at() } },
    ]);
    expect(lines).toStrictEqual([`session.meta "修好登入" ${AT}`]);
    expect(currentNameEvent(state, MAIN)).toMatchObject({
      displayName: '修好登入',
    });
    // The same summary again changes nothing.
    expect(translate([{ $set: { summary: '修好登入' } }], state)).toStrictEqual(
      [],
    );
  });

  it('$set.sessionId: the session ends, and the chat log speaks for the new one from its next message', () => {
    const next = '33333333-0000-4000-8000-000000000003';
    const { lines, state } = run([
      { $set: { summary: '舊的標題' } },
      { $set: { sessionId: next } },
      info('ignored before the next prompt'),
      prompt('u9'),
    ]);
    expect(lines).toStrictEqual([
      `session.meta "舊的標題" ${AT}`,
      `session.end ${AT}`,
      `session.start gemini:${next} ${AT}`,
      `session.meta gemini:${next} "gundam" ${AT}`,
      `turn.start gemini:${next} ${AT}`,
    ]);
    expect(state.sessionId).toBe(next);
    // The same id again, or one that cannot be a native id: nothing.
    expect(
      translate(
        [{ $set: { sessionId: next } }, { $set: { sessionId: '' } }],
        state,
      ),
    ).toStrictEqual([]);
  });

  it('$set.sessionId before the session started ends nothing', () => {
    const next = '33333333-0000-4000-8000-000000000003';
    expect(
      translate([{ $set: { sessionId: next } }, prompt()], FRESH),
    ).toStrictEqual([
      `session.start gemini:${next} ${AT}`,
      `session.meta gemini:${next} "gundam" ${AT}`,
      `turn.start gemini:${next} ${AT}`,
    ]);
  });

  it('其他: a functionResponse, another info, a warning are activity; another $set or $rewindTo, nothing', () => {
    expect(
      translate([
        functionResponse(),
        info('Switched model'),
        msg('warning', 'w1', 'careful'),
        msg('something-new', 'n1', ''),
        { $set: { lastUpdated: at(), memoryScratchpad: {} } },
        { $rewindTo: 'u1' },
        { unknown: true },
      ]),
    ).toStrictEqual([
      `activity ${AT}`,
      `activity ${AT}`,
      `activity ${AT}`,
      `activity ${AT}`,
    ]);
  });

  it('a turn.end right after another is left out; the message sends activity instead', () => {
    expect(
      translate([
        info(REQUEST_CANCELLED),
        info(REQUEST_CANCELLED, 'i2'),
        msg('error', 'e1', 'x'),
        prompt(),
        info(REQUEST_CANCELLED, 'i3'),
      ]),
    ).toStrictEqual([
      `turn.end ${AT}`,
      `activity ${AT}`,
      `error ${AT}`,
      `turn.start ${AT}`,
      `turn.end ${AT}`,
    ]);
  });

  it('a tool.start resets it: the next turn end is sent', () => {
    expect(
      translate([
        info(REQUEST_CANCELLED),
        reply('g1', ''),
        info(REQUEST_CANCELLED, 'i2'),
      ]),
    ).toStrictEqual([
      `turn.end ${AT}`,
      `tool.start pending pending:g1 ${AT}`,
      `turn.end ${AT}`,
    ]);
  });
});

describe('the pending placeholder', () => {
  it('a turn end closes it: a later toolCalls write sends no tool.end for it', () => {
    expect(
      translate([
        reply('g1', ''),
        info(REQUEST_CANCELLED),
        withTools('g1', [toolCall('c1', 'glob', 'cancelled')]),
      ]),
    ).toStrictEqual([
      `tool.start pending pending:g1 ${AT}`,
      `turn.end ${AT}`,
      `tool.start glob c1 ${AT}`,
      `tool.end c1 ${AT}`,
    ]);
  });

  it('the same id written again with no text leaves it open; with text, it ends and the text is a reply', () => {
    expect(
      translate([reply('g1', ''), reply('g1', ''), reply('g1', 'now text')]),
    ).toStrictEqual([
      `tool.start pending pending:g1 ${AT}`,
      `activity ${AT}`,
      `tool.end pending:g1 ${AT}`,
      `turn.reply ${AT}`,
    ]);
  });

  it('a gemini message with another id ends it first', () => {
    expect(translate([reply('g1', ''), reply('g2', '')])).toStrictEqual([
      `tool.start pending pending:g1 ${AT}`,
      `tool.end pending:g1 ${AT}`,
      `tool.start pending pending:g2 ${AT}`,
    ]);
    expect(
      translate([reply('g1', ''), withTools('g2', [toolCall('c1', 'glob')])]),
    ).toStrictEqual([
      `tool.start pending pending:g1 ${AT}`,
      `tool.end pending:g1 ${AT}`,
      `tool.start glob c1 ${AT}`,
      `tool.end c1 ${AT}`,
      `turn.start ${AT}`,
    ]);
  });

  it('a new prompt ends it first (the model asked for no tools after all)', () => {
    expect(translate([reply('g1', ''), prompt('u3')])).toStrictEqual([
      `tool.start pending pending:g1 ${AT}`,
      `tool.end pending:g1 ${AT}`,
      `turn.start ${AT}`,
    ]);
  });

  it('a gemini message already written with tools, written again with no text, opens none', () => {
    expect(
      translate([withTools('g1', [toolCall('c1', 'glob')]), reply('g1', '')]),
    ).toStrictEqual([
      `tool.start glob c1 ${AT}`,
      `tool.end c1 ${AT}`,
      `turn.start ${AT}`,
      `activity ${AT}`,
    ]);
  });

  it('a gemini message without a usable id opens none', () => {
    expect(
      translate([
        msg('gemini', '', ''),
        { type: 'gemini', timestamp: at(), content: '' },
        msg('gemini', 'x'.repeat(DETECTION_ID_MAX_LENGTH), ''),
      ]),
    ).toStrictEqual([`activity ${AT}`, `activity ${AT}`, `activity ${AT}`]);
  });

  it('tool calls without a usable id or name give no event; any call not cancelled still means turn.start', () => {
    expect(
      translate([
        withTools('g1', [
          { name: 'glob', status: 'success' },
          { id: 'c2', status: 'success' },
          { id: '', name: 'glob', status: 'cancelled' },
          'not an object',
        ]),
      ]),
    ).toStrictEqual([`turn.start ${AT}`]);
    expect(translate([withTools('g1', [])])).toStrictEqual([
      `tool.start pending pending:g1 ${AT}`,
    ]);
  });
});

describe('subagents', () => {
  const SUB_FRESH: ChatState = {
    ...NEW_CHAT,
    sessionId: 'sub-1',
    project: 'gundam',
  };

  it("every record but its own header is the parent's activity; its turns, tools, errors and summaries send nothing else", () => {
    const { lines, state } = run(
      [
        header('sub-1'),
        prompt(),
        reply('g1', ''),
        withTools('g1', [toolCall('c1', 'glob')]),
        reply('g2', 'text'),
        info(REQUEST_CANCELLED),
        msg('error', 'e1', 'x'),
        { $set: { summary: 'sub title', sessionId: 'other' } },
        header('another'),
      ],
      SUB_FRESH,
      SUBAGENT,
    );
    expect(lines).toStrictEqual(
      Array.from({ length: 8 }, () => `activity ${PARENT} ${AT}`),
    );
    expect(state.started).toBe(false);
    expect(currentNameEvent(state, SUBAGENT)).toBeNull();
  });
});

describe('ts', () => {
  it('a gemini message written again with tool calls is dated when they finished (their latest timestamp), and moves the latest', () => {
    const later = (offsetMs: number) => ({
      ...toolCall(`c${offsetMs}`, 'run_shell_command'),
      timestamp: at(offsetMs),
    });
    const { lines, state } = run(
      [
        reply('g1', ''),
        withTools('g1', [
          later(60_000),
          later(300_000),
          { ...later(1), timestamp: 'x' },
        ]),
        { $set: { summary: 'after' } },
      ],
      { ...STARTED, latestTs: null },
      { ...MAIN, replay: true },
    );
    const done = `@${at(300_000)} replay`;
    expect(lines).toStrictEqual([
      `tool.start pending pending:g1 ${AT} replay`,
      `tool.end pending:g1 ${done}`,
      `tool.start run_shell_command c60000 ${done}`,
      `tool.end c60000 ${done}`,
      `tool.start run_shell_command c300000 ${done}`,
      `tool.end c300000 ${done}`,
      `tool.start run_shell_command c1 ${done}`,
      `tool.end c1 ${done}`,
      `turn.start ${done}`,
      `session.meta "after" ${done}`,
    ]);
    expect(state.latestTs).toBe(T0 + 300_000);
  });

  it('tool calls with no timestamp: the message’s own', () => {
    expect(
      translate([
        withTools('g1', [{ id: 'c1', name: 'glob', status: 'success' }]),
      ]),
    ).toStrictEqual([
      `tool.start glob c1 ${AT}`,
      `tool.end c1 ${AT}`,
      `turn.start ${AT}`,
    ]);
  });

  it('a record with no timestamp takes the latest read so far; before any, the fallback', () => {
    expect(
      translate(
        [
          { $set: { summary: 'a' } },
          msg('user', 'u1', 'x', 5000),
          { $set: { summary: 'b' } },
        ],
        { ...STARTED, latestTs: null },
      ),
    ).toStrictEqual([
      `session.meta "a" @${iso(FALLBACK)}`,
      `turn.start @${at(5000)}`,
      `session.meta "b" @${at(5000)}`,
    ]);
  });

  it('an older timestamp leaves the latest as it was; a replayed record is marked replay', () => {
    const { lines, state } = run(
      [prompt('u1', 5000), prompt('u2', 1000)],
      STARTED,
      { ...MAIN, replay: true },
    );
    expect(lines).toStrictEqual([
      `turn.start @${at(5000)} replay`,
      `turn.start @${at(1000)} replay`,
    ]);
    expect(state.latestTs).toBe(T0 + 5000);
  });
});

describe('the name sent again after a read', () => {
  it('the summary, else the project folder name, dated at the latest timestamp', () => {
    expect(currentNameEvent(STARTED, MAIN)).toStrictEqual({
      type: 'session.meta',
      source: 'gemini',
      sessionKey: `gemini:${ID}`,
      ts: T0,
      via: 'log',
      confidence: 'exact',
      displayName: 'gundam',
    });
    expect(
      currentNameEvent(
        { ...STARTED, summary: '標題', latestTs: null },
        { ...MAIN, replay: true },
      ),
    ).toMatchObject({ displayName: '標題', ts: FALLBACK, replay: true });
  });

  it('none before the session started, with no name, or for a subagent', () => {
    expect(currentNameEvent(FRESH, MAIN)).toBeNull();
    expect(currentNameEvent({ ...STARTED, project: null }, MAIN)).toBeNull();
    expect(currentNameEvent(STARTED, SUBAGENT)).toBeNull();
  });
});

describe('content', () => {
  it.each([
    ['', false],
    ['  \n', false],
    ['text', true],
    [[], false],
    [[{ text: '' }, { functionCall: {} }], false],
    [[{ text: 'x' }], true],
    [['x'], true],
    [{ text: 'x' }, true],
    [null, false],
    [undefined, false],
  ])('hasText(%j) is %s', (content, expected) => {
    expect(hasText(content)).toBe(expected);
  });

  it.each([
    [[{ functionResponse: {} }], true],
    [{ functionResponse: {} }, true],
    [[{ text: 'x' }, { functionResponse: { id: 'a' } }], true],
    [[{ functionResponse: 'x' }], false],
    ['functionResponse', false],
    [[{ text: 'x' }], false],
  ])('isFunctionResponse(%j) is %s', (content, expected) => {
    expect(isFunctionResponse(content)).toBe(expected);
  });
});

describe('fixtures (de-identified real chat logs)', () => {
  const files = readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();

  /** The records of fixture `name`, every line a record. */
  function recordsOf(name: string): Record<string, unknown>[] {
    return readFileSync(path.join(FIXTURES, name), 'utf8')
      .split('\n')
      .filter((text) => text !== '')
      .map((text) => {
        const record = parseRecordLine(text);
        expect(record).not.toBeNull();
        return record ?? {};
      });
  }

  /** Fixture `name` translated from its header, as the adapter would. */
  function translateFixture(name: string): DetectionEvent[] {
    const records = recordsOf(name);
    let state = startChat(records[0] ?? null, { project: 'fixture-project' });
    expect(state).not.toBeNull();
    const events: DetectionEvent[] = [];
    for (const record of records) {
      if (state === null) {
        break;
      }
      const result = translateRecord(record, state, {
        kind: 'main',
        project: 'fixture-project',
        parentKey: null,
        replay: false,
        fallbackTs: 0,
      });
      state = result.state;
      events.push(...result.events);
    }
    return events;
  }

  it('cover several turns with tools, an approval turned down, Esc, and a session opened with no prompt', () => {
    expect(files).toStrictEqual([
      'session-2026-01-01T00-00-00000003.jsonl',
      'session-2026-01-01T00-35-00000002.jsonl',
      'session-2026-01-01T01-53-00000001.jsonl',
    ]);
  });

  it.each(files)('%s', (name) => {
    const events = translateFixture(name);
    for (const event of events) {
      expect(detectionEventSchema.safeParse(event).success).toBe(true);
    }
    expect(events.map(line).join('\n')).toMatchSnapshot();
  });

  it('the session opened with no prompt (only info) sends nothing', () => {
    expect(
      translateFixture('session-2026-01-01T00-00-00000003.jsonl'),
    ).toStrictEqual([]);
  });

  it('between them, they show every kind of event the table maps to but those hand-written above', () => {
    const types = new Set(
      files.flatMap((name) =>
        translateFixture(name).map((event) =>
          event.type === 'tool.start' && event.toolName === 'pending'
            ? 'tool.start pending'
            : event.type,
        ),
      ),
    );
    expect([...types].sort()).toStrictEqual([
      'activity',
      'session.meta',
      'session.start',
      'tool.end',
      'tool.start',
      'tool.start pending',
      'turn.end',
      'turn.reply',
      'turn.start',
    ]);
  });
});
