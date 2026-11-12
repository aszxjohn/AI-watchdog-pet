/**
 * The Gemini CLI adapter (Story 2.6) on a temporary `tmp` folder with a
 * fake watcher: the spec's I/O matrix end to end through createDetection
 * (main/detection/sessions with the real capability table, so the guessed
 * turn ends and approvals are the real ones) on fake clocks, then replay at
 * start, the header, subagents and the log. Nothing here touches the real
 * ~/.gemini.
 */
import nodeFs, {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext } from '../../src/main/detection/adapter';
import { createGeminiAdapter } from '../../src/main/detection/adapters/gemini/gemini';
import type { TranscriptFs } from '../../src/main/detection/adapters/jsonl/read';
import {
  createDetection,
  type Detection,
} from '../../src/main/detection/detection';
import {
  BAD_LINE_STREAK_DEGRADED,
  RECORDS_FOLDER_RECHECK_MS,
  REPLAY_TAIL_BYTES,
  TURN_END_INFER_MS,
} from '../../src/shared/constants';
import {
  type AdapterOutput,
  detectionEventSchema,
} from '../../src/shared/detection-events';
import {
  SETTINGS_DEFAULTS,
  type SettingsState,
} from '../../src/shared/settings';
import type { AdapterHealth } from '../../src/shared/sources';
import { fakeClock, type FakeClock } from '../helpers/fake-clock';
import { fakeWatcher } from '../helpers/jsonl-adapter';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const KEY_A = `gemini:${A}`;
const KEY_B = `gemini:${B}`;
const PROJECT = 'gundam';

let tmp: string;
let root: string;
let clock: FakeClock;
let watcher: ReturnType<typeof fakeWatcher>;
let heard: { sessions?: readonly { state: string }[] }[];
let consoleCalls: () => string[];

/** main/settings as detection sees it. */
function fakeSettings() {
  const state: SettingsState = { rev: 0, values: { ...SETTINGS_DEFAULTS } };
  return { get: () => state, onChange: () => () => {} };
}

beforeEach(() => {
  // Resolved: the adapter watches the tmp folder's real path.
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'awp-gemini-')));
  root = path.join(tmp, 'tmp');
  mkdirSync(root);
  clock = fakeClock();
  watcher = fakeWatcher();
  heard = [];
  const spies = [
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
  consoleCalls = () =>
    spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Chat logs on disk.

const chats = () => path.join(root, PROJECT, 'chats');
const chatLog = (id: string) =>
  path.join(chats(), `session-2026-03-01T10-00-${id.slice(0, 8)}.jsonl`);
const subagentLog = (parentId: string, name = 'sub-a1') =>
  path.join(chats(), parentId, `${name}.jsonl`);

/** A timestamp `agoMs` before the fake wall clock. */
const ts = (agoMs = 0) => new Date(clock.wall() - agoMs).toISOString();

const rec = {
  header: (sessionId: string, agoMs = 0) => ({
    sessionId,
    projectHash: 'f'.repeat(64),
    startTime: ts(agoMs),
    lastUpdated: ts(agoMs),
    kind: 'main',
  }),
  user: (id: string, agoMs = 0) => ({
    id,
    timestamp: ts(agoMs),
    type: 'user',
    content: [{ text: 'hi' }],
  }),
  functionResponse: (id: string) => ({
    id,
    timestamp: ts(),
    type: 'user',
    content: [{ functionResponse: { id: 'c', name: 'x', response: {} } }],
  }),
  gemini: (id: string, text = '', agoMs = 0) => ({
    id,
    timestamp: ts(agoMs),
    type: 'gemini',
    content: text,
    model: 'm',
  }),
  geminiTools: (
    id: string,
    statuses: readonly string[],
    text = '',
    agoMs = 0,
  ) => ({
    id,
    timestamp: ts(agoMs),
    type: 'gemini',
    content: text,
    toolCalls: statuses.map((status, n) => ({
      id: `run_shell_command__${id}${n}`,
      name: 'run_shell_command',
      status,
      timestamp: ts(),
    })),
  }),
  info: (id: string, content: string, agoMs = 0) => ({
    id,
    timestamp: ts(agoMs),
    type: 'info',
    content,
  }),
  error: (id: string) => ({
    id,
    timestamp: ts(),
    type: 'error',
    content: 'x',
  }),
  set: (fields: Record<string, unknown>) => ({ $set: fields }),
  updated: () => ({ $set: { lastUpdated: ts() } }),
};

const lines = (records: readonly unknown[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join('');

/** Appends `records` to `file`; with `mtimeAgoMs`, dates the file back. */
function append(
  file: string,
  records: readonly unknown[],
  mtimeAgoMs?: number,
): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, lines(records));
  if (mtimeAgoMs !== undefined) {
    const when = new Date(clock.wall() - mtimeAgoMs);
    utimesSync(file, when, when);
  }
}

// ---------------------------------------------------------------------------
// The adapter through createDetection.

function startDetection(fs?: TranscriptFs): Detection {
  const detection = createDetection({
    settings: fakeSettings(),
    monotonic: clock.monotonic,
    wall: clock.wall,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    adapters: [createGeminiAdapter({ root, watch: watcher.watch, fs })],
  });
  detection.onChange((sections) => {
    heard.push(sections);
  });
  return detection;
}

/** `<key> <state>`, `(inferred)` when inferred, per session. */
function states(detection: Detection): string[] {
  return detection
    .get()
    .sessions.map(
      (s) =>
        `${s.sessionKey} ${s.state}${s.confidence === 'inferred' ? ' (inferred)' : ''}`,
    );
}

function healthOf(detection: Detection): AdapterHealth | undefined {
  return detection.get().adapters.find((adapter) => adapter.source === 'gemini')
    ?.health;
}

/** Appends `records` to `file` and reports the change, as the watcher would. */
function write(file: string, ...records: unknown[]): void {
  const added = !nodeFs.existsSync(file);
  append(file, records);
  if (added) {
    watcher.on().added(file);
  } else {
    watcher.on().changed(file);
  }
}

/** Started, initial replay done, with one session running in A. */
function running(): Detection {
  const detection = startDetection();
  watcher.on().ready();
  write(chatLog(A), rec.header(A), rec.updated(), rec.user('u1'));
  return detection;
}

// ---------------------------------------------------------------------------
// The adapter on its own, with a recording context.

function startAdapter(fs?: TranscriptFs) {
  const emitted: { outputs: AdapterOutput[]; health?: AdapterHealth }[] = [];
  const context: AdapterContext = {
    emit(outputs, health) {
      emitted.push(
        health === undefined
          ? { outputs: [...outputs] }
          : { outputs: [...outputs], health },
      );
    },
    timings: () => SETTINGS_DEFAULTS,
    wallNow: clock.wall,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
  const adapter = createGeminiAdapter({ root, watch: watcher.watch, fs });
  adapter.start(context);
  return { adapter, emitted };
}

/** An emitted batch as lines: key, type, `replay` when replayed. */
function batchLines(outputs: readonly AdapterOutput[]): string[] {
  return outputs.map((output) =>
    output.type === 'sync.ready'
      ? 'sync.ready'
      : `${output.sessionKey} ${output.type}${output.replay === true ? ' replay' : ''}`,
  );
}

// ---------------------------------------------------------------------------

describe('I/O matrix', () => {
  it('新 session: a new chat log with a header, then a prompt, shows up named after its project folder, 思考中', () => {
    const detection = running();
    expect(detection.get()).toStrictEqual({
      sessions: [
        {
          sessionKey: KEY_A,
          source: 'gemini',
          displayName: PROJECT,
          state: 'thinking',
          confidence: 'exact',
        },
      ],
      adapters: [{ source: 'gemini', health: 'ok' }],
    });
  });

  it('只開沒問: a chat log with only its header and info messages does not show', () => {
    const detection = startDetection();
    watcher.on().ready();
    write(
      chatLog(A),
      rec.header(A),
      rec.set({ messages: [], lastUpdated: ts() }),
      rec.info('i1', 'Loaded'),
      rec.updated(),
      rec.info('i2', 'Loaded more'),
    );
    expect(detection.get().sessions).toStrictEqual([]);
    clock.advance(10 * MINUTE);
    expect(detection.get().sessions).toStrictEqual([]);
  });

  it('呼叫工具: a gemini message with no text is 工作中', () => {
    const detection = running();
    write(chatLog(A), rec.gemini('g1'), rec.updated());
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);
  });

  it('工具做完: the same id written again with toolCalls is back to 思考中', () => {
    const detection = running();
    write(chatLog(A), rec.gemini('g1'), rec.updated());
    write(
      chatLog(A),
      rec.geminiTools('g1', ['success']),
      rec.functionResponse('u2'),
      rec.updated(),
    );
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
  });

  it(`有文字的回覆: ${TURN_END_INFER_MS} ms with nothing newer after a reply with text is 做完了 (inferred), then 等你回覆 (inferred) 5 seconds later`, () => {
    const detection = running();
    write(chatLog(A), rec.gemini('g1', 'All done.'), rec.updated());
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
    clock.advance(TURN_END_INFER_MS - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_A} done (inferred)`]);
    clock.advance(5 * SECOND - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} done (inferred)`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting (inferred)`]);
  });

  it(`說完話接著呼叫工具: a new record within ${TURN_END_INFER_MS} ms of a reply keeps it 思考中 or 工作中; no 做完了`, () => {
    const detection = running();
    const seen = new Set<string>();
    const look = () => {
      for (const line of states(detection)) {
        seen.add(line);
      }
    };
    write(chatLog(A), rec.gemini('g1', 'Let me run it.'), rec.updated());
    look();
    clock.advance(TURN_END_INFER_MS - 1);
    look();
    write(
      chatLog(A),
      rec.geminiTools('g1', ['success'], 'Let me run it.'),
      rec.functionResponse('u2'),
      rec.updated(),
    );
    look();
    clock.advance(3 * SECOND);
    write(chatLog(A), rec.gemini('g2'), rec.updated());
    look();
    clock.advance(5 * SECOND);
    look();
    expect([...seen]).toStrictEqual([`${KEY_A} thinking`, `${KEY_A} working`]);
  });

  it('下一輪: a prompt after the guessed turn end is 思考中, no longer inferred', () => {
    const detection = running();
    write(chatLog(A), rec.gemini('g1', 'All done.'));
    clock.advance(TURN_END_INFER_MS + 5 * SECOND);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting (inferred)`]);
    write(chatLog(A), rec.user('u2'), rec.updated());
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
  });

  it.each([
    ['a minute ago', MINUTE, `${KEY_A} waiting (inferred)`],
    ['an hour ago', HOUR, `${KEY_A} idle`],
  ])(
    '補讀: a chat log last written %s with a reply with text is, once synced, 等你回覆 (inferred) or 休息中, never 做完了',
    (_label, agoMs, expected) => {
      append(
        chatLog(A),
        [
          rec.header(A, agoMs + 30 * SECOND),
          rec.user('u1', agoMs + 20 * SECOND),
          rec.gemini('g1', 'All done.', agoMs),
          rec.updated(),
        ],
        agoMs,
      );
      const detection = startDetection();
      watcher.on().ready();
      expect(states(detection)).toStrictEqual([expected]);
      const published = heard.filter((change) => change.sessions !== undefined);
      expect(
        published.flatMap((change) => change.sessions?.map((s) => s.state)),
      ).not.toContain('done');
    },
  );

  it('推測批准: a gemini message with no text and nothing newer for 10 seconds is 要你批准 (inferred)', () => {
    const detection = running();
    write(chatLog(A), rec.gemini('g1'), rec.updated());
    clock.advance(10 * SECOND - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_A} approval (inferred)`]);
    write(chatLog(A), rec.geminiTools('g1', ['success']));
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
  });

  it('拒絕批准: tool calls all cancelled, then Request cancelled., end the turn', () => {
    const detection = running();
    write(chatLog(A), rec.gemini('g1'), rec.updated());
    clock.advance(10 * SECOND);
    expect(states(detection)).toStrictEqual([`${KEY_A} approval (inferred)`]);
    write(
      chatLog(A),
      rec.geminiTools('g1', ['cancelled']),
      rec.info('i1', 'Request cancelled.'),
      rec.updated(),
      rec.functionResponse('u2'),
    );
    expect(states(detection)).toStrictEqual([`${KEY_A} done`]);
    clock.advance(5 * SECOND);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
  });

  it('中斷: Esc while the model streams (only Request cancelled.) ends the turn', () => {
    const detection = running();
    write(chatLog(A), rec.info('i1', 'Request cancelled.'), rec.updated());
    expect(states(detection)).toStrictEqual([`${KEY_A} done`]);
    clock.advance(5 * SECOND);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
  });

  it('錯誤: an error message is 出錯了', () => {
    const detection = running();
    write(chatLog(A), rec.error('e1'));
    expect(states(detection)).toStrictEqual([`${KEY_A} error`]);
  });

  it('標題: $set.summary renames the session, and the name stays after later reads', () => {
    const detection = running();
    write(chatLog(A), rec.set({ summary: '修好登入頁' }));
    expect(detection.get().sessions[0]?.displayName).toBe('修好登入頁');
    write(chatLog(A), rec.gemini('g1', 'ok'));
    expect(detection.get().sessions[0]?.displayName).toBe('修好登入頁');
  });

  it('/clear: a chat log with a new session id in the same project folder is a new session; the old one ends by expiry', () => {
    const detection = running();
    write(chatLog(A), rec.info('i1', 'Request cancelled.'));
    clock.advance(MINUTE);
    write(chatLog(B), rec.header(B), rec.user('u9'));
    expect(
      detection
        .get()
        .sessions.map((s) => [s.sessionKey, s.displayName, s.state]),
    ).toStrictEqual([
      [KEY_A, PROJECT, 'waiting'],
      [KEY_B, PROJECT, 'thinking'],
    ]);
    clock.advance(HOUR);
    write(chatLog(B), rec.info('i2', 'Request cancelled.'));
    clock.advance(HOUR - MINUTE - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} idle`, `${KEY_B} idle`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_B} idle`]);
  });

  it("subagent: a subagent's records only move the parent session's last event time; no session of its own", () => {
    const detection = running();
    write(chatLog(A), rec.info('i1', 'Request cancelled.'));
    clock.advance(4 * MINUTE);
    write(
      subagentLog(A),
      rec.header('cccccccc-0000-4000-8000-000000000003'),
      rec.user('s1'),
      rec.gemini('s2'),
    );
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
    // 5 minutes after the turn ended, but 1 after the subagent's records.
    clock.advance(MINUTE + SECOND);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
    clock.advance(4 * MINUTE - SECOND - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_A} idle`]);
  });

  it('太舊: a chat log modified 3 hours ago does not show', () => {
    append(
      chatLog(A),
      [rec.header(A, 3 * HOUR), rec.user('u1', 3 * HOUR)],
      3 * HOUR,
    );
    const detection = startDetection();
    watcher.on().ready();
    expect(detection.get().sessions).toStrictEqual([]);
  });

  it(`壞行: ${BAD_LINE_STREAK_DEGRADED} unreadable lines in a row make the health degraded; the other records still count`, () => {
    const detection = running();
    appendFileSync(
      chatLog(A),
      'not json\n'.repeat(BAD_LINE_STREAK_DEGRADED - 1),
    );
    write(chatLog(A), rec.gemini('g1'));
    expect(healthOf(detection)).toBe('ok');
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);

    appendFileSync(
      chatLog(A),
      '{"broken"\n[1,2]\n'.repeat(BAD_LINE_STREAK_DEGRADED / 2),
    );
    watcher.on().changed(chatLog(A));
    expect(healthOf(detection)).toBe('degraded');
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);

    write(chatLog(B), rec.header(B), rec.user('u9'));
    expect(healthOf(detection)).toBe('ok');
  });

  it('沒有資料夾: with no tmp folder the health is missing; nothing is watched or thrown', () => {
    rmSync(root, { recursive: true });
    const detection = startDetection();
    expect(detection.get()).toStrictEqual({
      sessions: [],
      adapters: [{ source: 'gemini', health: 'missing' }],
    });
    expect(watcher.state.started).toBe(0);
  });
});

describe('start and replay', () => {
  it('replays sessions oldest first, then subagents of sessions it read; skips subagents of sessions it did not', () => {
    append(
      chatLog(B),
      [rec.header(B, 2 * MINUTE), rec.user('u2', 2 * MINUTE)],
      2 * MINUTE,
    );
    append(
      chatLog(A),
      [rec.header(A, 3 * MINUTE), rec.user('u1', 3 * MINUTE)],
      3 * MINUTE,
    );
    append(
      subagentLog(A),
      [
        rec.header('cccccccc-0000-4000-8000-000000000003', MINUTE),
        rec.user('s1', MINUTE),
      ],
      MINUTE,
    );
    // Its parent session's chat log is too old to replay.
    const old = 'dddddddd-0000-4000-8000-000000000004';
    append(
      chatLog(old),
      [rec.header(old, 3 * HOUR), rec.user('u3', 3 * HOUR)],
      3 * HOUR,
    );
    append(
      subagentLog(old),
      [
        rec.header('eeeeeeee-0000-4000-8000-000000000005', MINUTE),
        rec.user('s2', MINUTE),
      ],
      MINUTE,
    );
    const { emitted } = startAdapter();
    watcher.on().ready();
    expect(
      emitted.slice(1).map((batch) => batchLines(batch.outputs)),
    ).toStrictEqual([
      [
        `${KEY_A} session.start replay`,
        `${KEY_A} session.meta replay`,
        `${KEY_A} turn.start replay`,
        `${KEY_A} session.meta replay`,
      ],
      [
        `${KEY_B} session.start replay`,
        `${KEY_B} session.meta replay`,
        `${KEY_B} turn.start replay`,
        `${KEY_B} session.meta replay`,
      ],
      [`${KEY_A} activity replay`],
      ['sync.ready'],
    ]);
    expect(consoleCalls()).toStrictEqual([
      '[detection] gemini: started; watching the tmp folder',
      '[detection] gemini: replayed 3 transcripts modified within the discovery window (2 sessions, 2 subagents; 5 transcripts in all); sync.ready',
    ]);
  });

  it(`a chat log longer than ${REPLAY_TAIL_BYTES} bytes is replayed from its tail, its session id still from its header`, () => {
    const filler = rec.set({ lastUpdated: ts(), pad: 'x'.repeat(1000) });
    append(chatLog(A), [
      rec.header(A, 2 * MINUTE),
      rec.user('u1', 2 * MINUTE),
      ...Array.from(
        { length: Math.ceil(REPLAY_TAIL_BYTES / 1000) + 50 },
        () => filler,
      ),
      rec.gemini('g1', '', MINUTE),
    ]);
    const { emitted } = startAdapter();
    watcher.on().ready();
    // No turn.start: the prompt is before the tail. The gemini message
    // starts the session.
    expect(batchLines(emitted[1]?.outputs ?? [])).toStrictEqual([
      `${KEY_A} session.start replay`,
      `${KEY_A} session.meta replay`,
      `${KEY_A} tool.start replay`,
      `${KEY_A} session.meta replay`,
    ]);
    expect(consoleCalls().join('\n')).not.toMatch(/unreadable|degraded/);
  });

  it('a chat log whose header is not complete yet is followed once it is; one with no header never is', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    const header = JSON.stringify(rec.header(A));
    mkdirSync(chats(), { recursive: true });
    writeFileSync(chatLog(A), header.slice(0, 10));
    watcher.on().added(chatLog(A));
    expect(emitted).toHaveLength(2);
    appendFileSync(
      chatLog(A),
      `${header.slice(10)}\n${lines([rec.user('u1')])}`,
    );
    watcher.on().changed(chatLog(A));
    expect(batchLines(emitted[2]?.outputs ?? [])).toStrictEqual([
      `${KEY_A} session.start`,
      `${KEY_A} session.meta`,
      `${KEY_A} turn.start`,
      `${KEY_A} session.meta`,
    ]);

    write(chatLog(B), rec.user('u1'), rec.gemini('g1', 'x'));
    write(chatLog(B), rec.user('u2'));
    expect(emitted).toHaveLength(3);
  });

  it("a subagent's records count only once its parent session started in a chat log read", () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    const sub = 'cccccccc-0000-4000-8000-000000000003';
    write(subagentLog(A), rec.header(sub), rec.user('s1'));
    expect(emitted).toHaveLength(2);
    // The parent's chat log with only its header: not started yet.
    write(chatLog(A), rec.header(A), rec.info('i1', 'x'));
    write(subagentLog(A), rec.gemini('s2', 'x'));
    expect(emitted).toHaveLength(2);

    write(chatLog(A), rec.user('u1'));
    write(subagentLog(A), rec.gemini('s3', 'x'));
    // Created after the start: read from its start, every record but its
    // header.
    expect(batchLines(emitted.at(-1)?.outputs ?? [])).toStrictEqual([
      `${KEY_A} activity`,
      `${KEY_A} activity`,
      `${KEY_A} activity`,
    ]);
  });

  it('a $set.sessionId ends the session; the new one starts at its next message', () => {
    const detection = running();
    const next = B;
    write(chatLog(A), rec.set({ sessionId: next }), rec.info('i1', 'x'));
    expect(states(detection)).toStrictEqual([]);
    write(chatLog(A), rec.user('u2'));
    expect(
      detection
        .get()
        .sessions.map((s) => [s.sessionKey, s.displayName, s.state]),
    ).toStrictEqual([[KEY_B, PROJECT, 'thinking']]);
  });

  it('every emitted event passes the shared schema', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    append(chatLog(A), [
      rec.header(A),
      rec.set({ summary: '標題' }),
      rec.user('u1'),
      rec.gemini('g1'),
      rec.geminiTools('g1', ['success', 'cancelled']),
      rec.functionResponse('u2'),
      rec.gemini('g2', 'text'),
      rec.error('e1'),
      rec.info('i1', 'Request cancelled.'),
      rec.set({ sessionId: B }),
    ]);
    watcher.on().added(chatLog(A));
    append(subagentLog(A), [rec.header('sub'), rec.user('s1')]);
    watcher.on().added(subagentLog(A));
    const outputs = emitted.flatMap((batch) => batch.outputs);
    expect(outputs.length).toBeGreaterThan(10);
    for (const output of outputs) {
      if (output.type !== 'sync.ready') {
        expect(detectionEventSchema.safeParse(output).success).toBe(true);
      }
    }
  });

  it('the watcher follows recent chat logs only, by the discovery window', () => {
    startAdapter();
    const follow = watcher.state.follow;
    const stats = (agoMs: number) => ({
      isFile: () => true,
      isDirectory: () => false,
      mtimeMs: clock.wall() - agoMs,
    });
    expect(follow?.(chatLog(A), stats(HOUR))).toBe(true);
    expect(follow?.(chatLog(A), stats(2 * HOUR))).toBe(true);
    expect(follow?.(chatLog(A), stats(2 * HOUR + 1))).toBe(false);
    expect(follow?.(subagentLog(A), stats(HOUR))).toBe(true);
    expect(follow?.(path.join(root, PROJECT, 'logs.json'), stats(0))).toBe(
      false,
    );
  });

  it("removed while running: the sessions read before are forgotten, so a subagent waits until its parent's chat log is read again", () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    append(chatLog(A), [rec.header(A), rec.user('u1')]);
    watcher.on().added(chatLog(A));
    // A's own chat log drops out of the discovery window: not replayed.
    const old = new Date(clock.wall() - 3 * HOUR);
    utimesSync(chatLog(A), old, old);
    append(subagentLog(A), [
      rec.header('cccccccc-0000-4000-8000-000000000003'),
      rec.user('s1'),
    ]);

    watcher.on().folderRemoved(root);
    clock.advance(RECORDS_FOLDER_RECHECK_MS);
    const before = emitted.length;
    watcher.on().ready();

    expect(consoleCalls()).toContain(
      '[detection] gemini: replayed 0 transcripts modified within the discovery window (0 sessions, 1 subagents; 2 transcripts in all)',
    );
    expect(
      emitted
        .slice(before)
        .flatMap((batch) =>
          batch.outputs.filter(
            (o) => o.type !== 'sync.ready' && o.sessionKey === KEY_A,
          ),
        ),
    ).toStrictEqual([]);
  });
});

describe('the log', () => {
  it('gets no path and no record content', () => {
    const detection = running();
    write(
      chatLog(A),
      rec.set({ summary: '秘密的標題' }),
      rec.geminiTools('g1', ['success']),
    );
    appendFileSync(
      chatLog(A),
      'secret text\n'.repeat(BAD_LINE_STREAK_DEGRADED),
    );
    watcher.on().changed(chatLog(A));
    watcher.on().folderRemoved(root);
    detection.stop();
    const logged = consoleCalls().join('\n');
    for (const secret of [
      tmp,
      root,
      A,
      '秘密',
      'secret',
      PROJECT,
      'run_shell_command',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
