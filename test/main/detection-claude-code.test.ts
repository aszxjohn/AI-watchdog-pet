/**
 * The Claude Code adapter (Story 2.4) on a temporary projects folder with a
 * fake watcher: replay at start, reading changes, batching, health, and
 * the spec's I/O matrix end to end through createDetection on fake clocks.
 * Nothing here touches the real ~/.claude.
 */
import nodeFs, {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext } from '../../src/main/detection/adapter';
import { createClaudeCodeAdapter } from '../../src/main/detection/adapters/claude-code/claude-code';
import type { TranscriptFs } from '../../src/main/detection/adapters/claude-code/read';
import type {
  WatchHandlers,
  WatchTranscripts,
} from '../../src/main/detection/adapters/claude-code/watcher';
import {
  createDetection,
  type Detection,
} from '../../src/main/detection/detection';
import {
  BAD_LINE_STREAK_DEGRADED,
  RECORDS_FOLDER_RECHECK_MS,
  REPLAY_TAIL_BYTES,
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
import type { StageViewDetectionSections } from '../../src/shared/stage-view';
import { fakeClock, type FakeClock } from '../helpers/fake-clock';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const KEY_A = `claude-code:${A}`;
const KEY_B = `claude-code:${B}`;
const CWD = '/work/gundam';

let tmp: string;
let root: string;
let clock: FakeClock;
let watcher: ReturnType<typeof fakeWatcher>;
let heard: Partial<StageViewDetectionSections>[];
let consoleCalls: () => string[];

/** The fake watcher: tests fire its handlers by hand. */
function fakeWatcher() {
  let handlers: WatchHandlers | undefined;
  const state = {
    started: 0,
    closed: 0,
    root: undefined as string | undefined,
    follow: undefined as Parameters<WatchTranscripts>[1] | undefined,
    throws: false,
  };
  const watch: WatchTranscripts = (watchedRoot, follow, on) => {
    state.started += 1;
    if (state.throws) {
      throw Object.assign(new Error('no watcher'), { code: 'EMFILE' });
    }
    state.root = watchedRoot;
    state.follow = follow;
    handlers = on;
    return {
      close: async () => {
        state.closed += 1;
      },
    };
  };
  const on = (): WatchHandlers => {
    if (handlers === undefined) {
      throw new Error('the watcher was not started');
    }
    return handlers;
  };
  return { watch, state, on };
}

/** main/settings as detection sees it. */
function fakeSettings() {
  const state: SettingsState = { rev: 0, values: { ...SETTINGS_DEFAULTS } };
  return { get: () => state, onChange: () => () => {} };
}

beforeEach(() => {
  // Resolved: the adapter watches the projects folder's real path.
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'awp-claude-code-')));
  root = path.join(tmp, 'projects');
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
// Transcripts on disk.

const projectDir = () => path.join(root, '-work-gundam');
const transcript = (id: string) => path.join(projectDir(), `${id}.jsonl`);
const subagent = (id: string, name = 'agent-a1') =>
  path.join(projectDir(), id, 'subagents', `${name}.jsonl`);

/** A timestamp `agoMs` before the fake wall clock. */
const ts = (agoMs = 0) => new Date(clock.wall() - agoMs).toISOString();

const rec = {
  prompt: (agoMs = 0) => ({
    type: 'user',
    timestamp: ts(agoMs),
    cwd: CWD,
    message: { role: 'user', content: 'hi' },
  }),
  toolUse: (id: string, name: string, agoMs = 0) => ({
    type: 'assistant',
    timestamp: ts(agoMs),
    cwd: CWD,
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name }],
    },
  }),
  toolResult: (id: string, agoMs = 0) => ({
    type: 'user',
    timestamp: ts(agoMs),
    cwd: CWD,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id }],
    },
  }),
  endTurn: (agoMs = 0) => ({
    type: 'assistant',
    timestamp: ts(agoMs),
    cwd: CWD,
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text' }],
    },
  }),
  interrupt: (forToolUse = false) => ({
    type: 'user',
    timestamp: ts(),
    cwd: CWD,
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: forToolUse
            ? '[Request interrupted by user for tool use]'
            : '[Request interrupted by user]',
        },
      ],
    },
  }),
  apiError: () => ({
    type: 'assistant',
    timestamp: ts(),
    cwd: CWD,
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text' }],
    },
  }),
  activity: (agoMs = 0) => ({
    type: 'attachment',
    timestamp: ts(agoMs),
    cwd: CWD,
  }),
  customTitle: (customTitle: string) => ({ type: 'custom-title', customTitle }),
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
    adapters: [createClaudeCodeAdapter({ root, watch: watcher.watch, fs })],
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
  return detection
    .get()
    .adapters.find((adapter) => adapter.source === 'claude-code')?.health;
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
  write(transcript(A), rec.prompt());
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
  const adapter = createClaudeCodeAdapter({ root, watch: watcher.watch, fs });
  adapter.start(context);
  return { adapter, emitted };
}

/** An emitted batch as lines: type (and tool), `replay` when replayed. */
function batchLines(outputs: readonly AdapterOutput[]): string[] {
  return outputs.map((output) => {
    if (output.type === 'sync.ready') {
      return 'sync.ready';
    }
    const tool = output.type === 'tool.start' ? ` ${output.toolName}` : '';
    return `${output.type}${tool}${output.replay === true ? ' replay' : ''}`;
  });
}

// ---------------------------------------------------------------------------

describe('I/O matrix', () => {
  it('新 session: a new transcript with a prompt shows up named after its working folder, 思考中', () => {
    const detection = running();
    expect(detection.get()).toStrictEqual({
      sessions: [
        {
          sessionKey: KEY_A,
          source: 'claude-code',
          displayName: 'gundam',
          state: 'thinking',
          confidence: 'exact',
        },
      ],
      adapters: [{ source: 'claude-code', health: 'ok' }],
    });
  });

  it('工具: tool_use is 工作中, its tool_result back to 思考中', () => {
    const detection = running();
    write(transcript(A), rec.toolUse('t1', 'Read'));
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);
    write(transcript(A), rec.toolResult('t1'));
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
  });

  it('一輪結束: end_turn is 做完了, then 等你回覆 5 seconds later', () => {
    const detection = running();
    write(transcript(A), rec.endTurn());
    expect(states(detection)).toStrictEqual([`${KEY_A} done`]);
    clock.advance(5 * SECOND - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} done`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
  });

  it.each([false, true])(
    '中斷 (for tool use: %s): the interrupt record ends the turn',
    (forToolUse) => {
      const detection = running();
      write(transcript(A), rec.toolUse('t1', 'Bash'));
      write(transcript(A), rec.interrupt(forToolUse));
      expect(states(detection)).toStrictEqual([`${KEY_A} done`]);
      clock.advance(5 * SECOND);
      expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
    },
  );

  it('API 錯誤: an isApiErrorMessage record is 出錯了', () => {
    const detection = running();
    write(transcript(A), rec.apiError());
    expect(states(detection)).toStrictEqual([`${KEY_A} error`]);
  });

  it('推測批准: Bash with no tool_result for 10 seconds is 要你批准, inferred', () => {
    const detection = running();
    write(transcript(A), rec.toolUse('t1', 'Bash'));
    clock.advance(10 * SECOND - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_A} approval (inferred)`]);
    write(transcript(A), rec.toolResult('t1'));
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
  });

  it('不推測的工具: Agent running for 10 minutes stays 工作中', () => {
    const detection = running();
    write(transcript(A), rec.toolUse('t1', 'Agent'));
    clock.advance(10 * MINUTE);
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);
  });

  it('提問工具: AskUserQuestion with no result for 10 seconds is 要你決定, inferred', () => {
    const detection = running();
    write(transcript(A), rec.toolUse('q1', 'AskUserQuestion'));
    clock.advance(10 * SECOND);
    expect(states(detection)).toStrictEqual([`${KEY_A} decision (inferred)`]);
  });

  it('subagent: its records only move the parent session’s last event time; no session of its own', () => {
    const detection = running();
    write(transcript(A), rec.endTurn());
    clock.advance(4 * MINUTE);
    write(subagent(A), rec.activity());
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
    // 5 minutes after end_turn, but 1 after the subagent's record.
    clock.advance(MINUTE + SECOND);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
    clock.advance(4 * MINUTE - SECOND - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_A} idle`]);
  });

  it('subagent 的工具: a subagent’s Bash with no tool_result for 10 seconds shows 要你批准 (inferred) on the parent', () => {
    const detection = running();
    write(transcript(A), rec.toolUse('agent-1', 'Agent'));
    write(subagent(A), rec.prompt(), rec.toolUse('s1', 'Bash'));
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);
    clock.advance(10 * SECOND - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_A} approval (inferred)`]);
    write(subagent(A), rec.toolResult('s1'), rec.endTurn());
    // The subagent's turn end ends nothing on the parent: Agent still runs.
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);
  });

  it('/clear: a new transcript in the same folder is a new session; the old one ends by expiry', () => {
    const detection = running();
    write(transcript(A), rec.endTurn());
    clock.advance(MINUTE);
    write(transcript(B), rec.prompt());
    expect(
      detection
        .get()
        .sessions.map((s) => [s.sessionKey, s.displayName, s.state]),
    ).toStrictEqual([
      [KEY_A, 'gundam', 'waiting'],
      [KEY_B, 'gundam', 'thinking'],
    ]);
    clock.advance(HOUR);
    write(transcript(B), rec.endTurn());
    clock.advance(HOUR - MINUTE - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} idle`, `${KEY_B} idle`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_B} idle`]);
  });

  it('標題: a custom-title record renames the session', () => {
    const detection = running();
    write(transcript(A), rec.customTitle('我的工作'));
    expect(detection.get().sessions[0]?.displayName).toBe('我的工作');
  });

  it('啟動補讀: a transcript modified an hour ago, last at tool_use, is 要你批准 (inferred) when first published', () => {
    append(
      transcript(A),
      [rec.prompt(HOUR + 5 * SECOND), rec.toolUse('t1', 'Bash', HOUR)],
      HOUR,
    );
    const detection = startDetection();
    expect(detection.get().sessions).toStrictEqual([]);

    watcher.on().ready();

    expect(states(detection)).toStrictEqual([`${KEY_A} approval (inferred)`]);
    const published = heard.filter((change) => change.sessions !== undefined);
    expect(
      published.map((change) => change.sessions?.map((s) => s.state)),
    ).toStrictEqual([['approval']]);
  });

  it('太舊的紀錄: a transcript modified 3 hours ago does not show', () => {
    append(transcript(A), [rec.prompt(3 * HOUR)], 3 * HOUR);
    const detection = startDetection();
    watcher.on().ready();
    expect(detection.get().sessions).toStrictEqual([]);
  });

  it(`壞行: ${BAD_LINE_STREAK_DEGRADED} unreadable lines in a row make the health degraded; the other records still count`, () => {
    const detection = running();
    // One short of the streak, then a good record: still ok.
    appendFileSync(
      transcript(A),
      'not json\n'.repeat(BAD_LINE_STREAK_DEGRADED - 1),
    );
    write(transcript(A), rec.toolUse('t1', 'Read'));
    expect(healthOf(detection)).toBe('ok');
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);

    appendFileSync(
      transcript(A),
      '{"broken"\n[1,2]\n'.repeat(BAD_LINE_STREAK_DEGRADED / 2),
    );
    watcher.on().changed(transcript(A));
    expect(healthOf(detection)).toBe('degraded');
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);

    // The next good record, in any transcript, counts as usual and makes
    // the health ok again.
    write(transcript(B), rec.prompt());
    expect(healthOf(detection)).toBe('ok');
    expect(states(detection)).toStrictEqual([
      `${KEY_A} working`,
      `${KEY_B} thinking`,
    ]);
  });

  it('沒有資料夾: with no projects folder the health is missing; nothing is watched or thrown', () => {
    rmSync(root, { recursive: true });
    const detection = startDetection();
    expect(detection.get()).toStrictEqual({
      sessions: [],
      adapters: [{ source: 'claude-code', health: 'missing' }],
    });
    expect(watcher.state.started).toBe(0);
  });
});

describe('start and replay', () => {
  it('health ok at once; sync.ready only after the initial replay, once', () => {
    append(transcript(A), [rec.prompt(MINUTE)], MINUTE);
    const { emitted } = startAdapter();
    expect(emitted).toStrictEqual([{ outputs: [], health: 'ok' }]);
    expect(watcher.state.root).toBe(root);

    watcher.on().ready();
    watcher.on().ready();

    expect(
      emitted.slice(1).map((batch) => batchLines(batch.outputs)),
    ).toStrictEqual([
      [
        'session.start replay',
        'session.meta replay',
        'turn.start replay',
        'session.meta replay',
      ],
      ['sync.ready'],
    ]);
  });

  it('replays sessions oldest first, then subagents of sessions it read; skips subagents of sessions it did not', () => {
    append(transcript(B), [rec.prompt(2 * MINUTE)], 2 * MINUTE);
    append(transcript(A), [rec.prompt(3 * MINUTE)], 3 * MINUTE);
    append(subagent(A), [rec.activity(MINUTE)], MINUTE);
    // Its session is too old to replay.
    const old = 'cccccccc-0000-4000-8000-000000000003';
    append(transcript(old), [rec.prompt(3 * HOUR)], 3 * HOUR);
    append(subagent(old), [rec.activity(MINUTE)], MINUTE);
    const { emitted } = startAdapter();
    watcher.on().ready();
    const keys = emitted
      .slice(1)
      .map((batch) =>
        batch.outputs.map((output) =>
          output.type === 'sync.ready'
            ? 'sync.ready'
            : `${output.sessionKey} ${output.type}`,
        ),
      );
    expect(keys).toStrictEqual([
      [
        `${KEY_A} session.start`,
        `${KEY_A} session.meta`,
        `${KEY_A} turn.start`,
        `${KEY_A} session.meta`,
      ],
      [
        `${KEY_B} session.start`,
        `${KEY_B} session.meta`,
        `${KEY_B} turn.start`,
        `${KEY_B} session.meta`,
      ],
      [`${KEY_A} activity`],
      ['sync.ready'],
    ]);
  });

  it(`replays only the last ${REPLAY_TAIL_BYTES} bytes of a long transcript, skipping its partial first line`, () => {
    const filler = { type: 'attachment', pad: 'x'.repeat(1000) };
    const count = Math.ceil(REPLAY_TAIL_BYTES / 1000) + 50;
    append(transcript(A), [
      rec.prompt(2 * MINUTE),
      ...Array.from({ length: count }, () => filler),
      rec.endTurn(MINUTE),
    ]);
    const { emitted } = startAdapter();
    watcher.on().ready();
    const [replayed] = emitted
      .slice(1)
      .map((batch) => batchLines(batch.outputs));
    // No turn.start: the prompt is before the tail. The fillers have no
    // timestamp, so they give nothing; no bad line either.
    expect(replayed).toStrictEqual([
      'session.start replay',
      'session.meta replay',
      'turn.end replay',
      'session.meta replay',
    ]);
    expect(consoleCalls().join('\n')).not.toMatch(/unreadable|degraded/);

    // Reading goes on from the end of the tail: only the new record.
    append(transcript(A), [rec.prompt()]);
    watcher.on().changed(transcript(A));
    expect(batchLines(emitted.at(-1)?.outputs ?? [])).toStrictEqual([
      'turn.start',
      'session.meta',
    ]);
    expect(consoleCalls().join('\n')).not.toMatch(/unreadable|degraded/);
  });

  it('ignores changes reported before the initial replay; the replay reads them', () => {
    const { emitted } = startAdapter();
    append(transcript(A), [rec.prompt()]);
    watcher.on().added(transcript(A));
    watcher.on().changed(transcript(A));
    expect(emitted).toHaveLength(1);
    watcher.on().ready();
    expect(
      emitted.slice(1).map((batch) => batchLines(batch.outputs)),
    ).toStrictEqual([
      [
        'session.start replay',
        'session.meta replay',
        'turn.start replay',
        'session.meta replay',
      ],
      ['sync.ready'],
    ]);
  });

  it('logs the start and the sync with counts only', () => {
    append(transcript(A), [rec.prompt(MINUTE)], MINUTE);
    append(transcript(B), [rec.prompt(3 * HOUR)], 3 * HOUR);
    startAdapter();
    watcher.on().ready();
    expect(consoleCalls()).toStrictEqual([
      '[detection] claude-code: started; watching the projects folder',
      '[detection] claude-code: replayed 1 transcripts modified within the discovery window (1 sessions, 0 subagents; 2 transcripts in all); sync.ready',
    ]);
  });
});

describe('reading changes', () => {
  it('a read is one batch: the panel hears its outcome once, with no state in between', () => {
    running();
    heard = [];
    write(
      transcript(A),
      rec.toolUse('t1', 'Bash'),
      rec.toolResult('t1'),
      rec.endTurn(),
    );
    expect(
      heard.map((change) => change.sessions?.map((s) => s.state)),
    ).toStrictEqual([['done']]);
  });

  it('an incomplete last line waits for the rest', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    const record = JSON.stringify(rec.prompt());
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(transcript(A), record.slice(0, 20));
    watcher.on().added(transcript(A));
    expect(emitted).toHaveLength(2);
    appendFileSync(transcript(A), `${record.slice(20)}\n`);
    watcher.on().changed(transcript(A));
    expect(batchLines(emitted[2]?.outputs ?? [])).toStrictEqual([
      'session.start',
      'session.meta',
      'turn.start',
      'session.meta',
    ]);
    expect(consoleCalls().join('\n')).not.toMatch(/unreadable/);
  });

  it('a transcript created after the start is read from its start, live', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    append(transcript(A), [rec.prompt(), rec.endTurn()]);
    watcher.on().added(transcript(A));
    expect(batchLines(emitted[2]?.outputs ?? [])).toStrictEqual([
      'session.start',
      'session.meta',
      'turn.start',
      'turn.end',
      'session.meta',
    ]);
  });

  it(`one created after the start but already longer than ${REPLAY_TAIL_BYTES} bytes is replayed from its tail`, () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    const filler = { type: 'attachment', pad: 'x'.repeat(1000) };
    append(transcript(A), [
      rec.prompt(),
      ...Array.from(
        { length: Math.ceil(REPLAY_TAIL_BYTES / 1000) + 50 },
        () => filler,
      ),
      rec.endTurn(),
    ]);
    watcher.on().added(transcript(A));
    expect(batchLines(emitted[2]?.outputs ?? [])).toStrictEqual([
      'session.start replay',
      'session.meta replay',
      'turn.end replay',
      'session.meta replay',
    ]);
  });

  it('one that was there at the start but too old to replay is replayed from its tail when it changes (a resumed session)', () => {
    append(
      transcript(A),
      [rec.prompt(3 * HOUR), rec.endTurn(3 * HOUR)],
      3 * HOUR,
    );
    const detection = startDetection();
    watcher.on().ready();
    expect(detection.get().sessions).toStrictEqual([]);
    heard = [];

    append(transcript(A), [
      rec.prompt(),
      rec.toolUse('t1', 'Bash'),
      rec.toolResult('t1'),
    ]);
    // The watcher reports a file it was not following as added.
    watcher.on().added(transcript(A));

    // One change: the replayed tool call's guess and its end stay inside it.
    expect(heard).toHaveLength(1);
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
    // The folder name came with the old records, which expired in the same
    // batch; the name sent again at the end of the read keeps it.
    expect(detection.get().sessions[0]?.displayName).toBe('gundam');
  });

  it('a transcript that got smaller is logged and replayed from its tail', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    append(transcript(A), [
      rec.prompt(),
      rec.toolUse('t1', 'Bash'),
      rec.endTurn(),
    ]);
    watcher.on().added(transcript(A));
    truncateSync(transcript(A), 0);
    append(transcript(A), [rec.prompt()]);
    watcher.on().changed(transcript(A));
    // The session had started: no second session.start.
    expect(batchLines(emitted[3]?.outputs ?? [])).toStrictEqual([
      'turn.start replay',
      'session.meta replay',
    ]);
    expect(consoleCalls()).toContain(
      '[detection] claude-code: a transcript got smaller; replaying its last 2 MiB again',
    );
  });

  it('nothing new, nothing sent; a removed transcript is forgotten and read from its start if it comes back', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    append(transcript(A), [rec.prompt()]);
    watcher.on().added(transcript(A));
    watcher.on().changed(transcript(A));
    expect(emitted).toHaveLength(3);

    rmSync(transcript(A));
    watcher.on().removed(transcript(A));
    watcher.on().changed(transcript(A));
    expect(emitted).toHaveLength(3);
    append(transcript(A), [rec.prompt()]);
    watcher.on().added(transcript(A));
    expect(batchLines(emitted[3]?.outputs ?? [])).toStrictEqual([
      'session.start',
      'session.meta',
      'turn.start',
      'session.meta',
    ]);
  });

  it("a subagent's records count only once its session's transcript has been read", () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    append(subagent(A), [rec.activity()]);
    watcher.on().added(subagent(A));
    expect(emitted).toHaveLength(2);

    append(transcript(A), [rec.prompt()]);
    watcher.on().added(transcript(A));
    append(subagent(A), [rec.activity()]);
    watcher.on().changed(subagent(A));
    // Created after the start: read from its start, both records.
    expect(
      emitted.slice(3).map((batch) => batchLines(batch.outputs)),
    ).toStrictEqual([['activity', 'activity']]);
    expect(
      emitted[3]?.outputs.every(
        (o) => o.type !== 'sync.ready' && o.sessionKey === KEY_A,
      ),
    ).toBe(true);
  });

  it('ignores paths that are not transcripts, and files that cannot be opened', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    const notes = path.join(projectDir(), 'notes.jsonl');
    append(notes, [rec.prompt()]);
    watcher.on().added(notes);
    watcher.on().changed(transcript(B));
    expect(emitted).toHaveLength(2);
    expect(consoleCalls().join('\n')).not.toMatch(/cannot/);
  });

  it('every emitted event passes the shared schema', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    append(transcript(A), [
      rec.customTitle('標題'),
      rec.prompt(),
      rec.toolUse('t1', 'Bash'),
      rec.toolResult('t1'),
      rec.apiError(),
      rec.interrupt(),
    ]);
    watcher.on().added(transcript(A));
    for (const batch of emitted) {
      for (const output of batch.outputs) {
        if (output.type !== 'sync.ready') {
          expect(detectionEventSchema.safeParse(output).success).toBe(true);
        }
      }
    }
  });

  it('the watcher follows recent transcripts only, by the discovery window', () => {
    startAdapter();
    const follow = watcher.state.follow;
    const stats = (agoMs: number) => ({
      isFile: () => true,
      isDirectory: () => false,
      mtimeMs: clock.wall() - agoMs,
    });
    expect(follow?.(transcript(A), stats(HOUR))).toBe(true);
    expect(follow?.(transcript(A), stats(2 * HOUR))).toBe(true);
    expect(follow?.(transcript(A), stats(2 * HOUR + 1))).toBe(false);
  });
});

describe('the projects folder missing', () => {
  it(`missing at start: checked again every ${RECORDS_FOLDER_RECHECK_MS} ms; once there, watched and replayed`, () => {
    rmSync(root, { recursive: true });
    const detection = startDetection();
    expect(healthOf(detection)).toBe('missing');
    expect(clock.pendingCount()).toBe(1);

    clock.advance(RECORDS_FOLDER_RECHECK_MS);
    expect(watcher.state.started).toBe(0);
    expect(healthOf(detection)).toBe('missing');

    append(transcript(A), [rec.prompt()]);
    clock.advance(RECORDS_FOLDER_RECHECK_MS - 1);
    expect(watcher.state.started).toBe(0);
    clock.advance(1);
    expect(watcher.state.started).toBe(1);
    expect(watcher.state.root).toBe(root);
    expect(healthOf(detection)).toBe('ok');
    expect(detection.get().sessions).toStrictEqual([]);

    watcher.on().ready();
    expect(
      detection.get().sessions.map((s) => [s.displayName, s.state]),
    ).toStrictEqual([['gundam', 'thinking']]);
    expect(consoleCalls()).toContain(
      '[detection] claude-code: the projects folder is there again; watching it',
    );
  });

  it('removed while running: the watcher closes, health missing; when it is back, watched and replayed again', () => {
    const detection = running();
    const old = watcher.on();
    old.folderRemoved(projectDir());
    expect(healthOf(detection)).toBe('ok');

    old.folderRemoved(root);
    expect(healthOf(detection)).toBe('missing');
    expect(watcher.state.closed).toBe(1);
    // The closed watcher's late events are ignored.
    write(transcript(A), rec.endTurn());
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);

    clock.advance(RECORDS_FOLDER_RECHECK_MS);
    expect(watcher.state.started).toBe(2);
    expect(healthOf(detection)).toBe('ok');
    expect(watcher.on()).not.toBe(old);
    watcher.on().ready();
    // Replayed from its tail: the turn ended before, so no 做完了.
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
    old.changed(transcript(A));
    write(transcript(A), rec.prompt());
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
  });

  it('a symbolically linked projects folder is watched at its real path', () => {
    const link = path.join(tmp, 'linked-projects');
    symlinkSync(root, link, 'junction');
    const detection = createDetection({
      settings: fakeSettings(),
      monotonic: clock.monotonic,
      wall: clock.wall,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      adapters: [createClaudeCodeAdapter({ root: link, watch: watcher.watch })],
    });
    expect(watcher.state.root).toBe(root);
    watcher.on().ready();
    write(transcript(A), rec.prompt());
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
  });
});

describe('health', () => {
  it('a watcher that cannot start: logged, replayed once, sync.ready, degraded (never ok first)', () => {
    watcher.state.throws = true;
    append(transcript(A), [rec.prompt(MINUTE)], MINUTE);
    const { emitted } = startAdapter();
    expect(
      emitted.map((batch) => [batchLines(batch.outputs), batch.health]),
    ).toStrictEqual([
      [
        [
          'session.start replay',
          'session.meta replay',
          'turn.start replay',
          'session.meta replay',
        ],
        'degraded',
      ],
      [['sync.ready'], undefined],
    ]);
    expect(consoleCalls()).toContain(
      '[detection] claude-code: cannot watch the projects folder (EMFILE); replaying once without updates',
    );
  });

  it('a watcher error is logged by code and makes the health degraded; the adapter keeps going', () => {
    const detection = running();
    watcher.on().failed(Object.assign(new Error('x'), { code: 'EACCES' }));
    expect(consoleCalls()).toContain(
      '[detection] claude-code: watcher error (EACCES); health degraded',
    );
    expect(healthOf(detection)).toBe('degraded');
    write(transcript(A), rec.endTurn());
    expect(states(detection)).toStrictEqual([`${KEY_A} done`]);
  });

  it('a transcript that cannot be read is logged by code and skipped', () => {
    const failing: TranscriptFs = {
      ...nodeFs,
      openSync: (file, flags) => {
        if (file.endsWith(`${B}.jsonl`)) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return nodeFs.openSync(file, flags);
      },
    };
    const detection = startDetection(failing);
    watcher.on().ready();
    write(transcript(B), rec.prompt());
    write(transcript(A), rec.prompt());
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
    expect(consoleCalls()).toContain(
      '[detection] claude-code: cannot open a transcript (EACCES)',
    );
  });
});

describe('stop', () => {
  it('detection.stop() closes the watcher; later changes are not read', () => {
    const detection = running();
    detection.stop();
    expect(watcher.state.closed).toBe(1);
    write(transcript(A), rec.endTurn());
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
    expect(consoleCalls()).toContain('[detection] claude-code: stopped');
  });

  it('the run log gets no path and no record content', () => {
    const detection = running();
    write(
      transcript(A),
      rec.customTitle('秘密的標題'),
      rec.toolUse('t1', 'Bash'),
    );
    appendFileSync(
      transcript(A),
      'secret text\n'.repeat(BAD_LINE_STREAK_DEGRADED),
    );
    watcher.on().changed(transcript(A));
    truncateSync(transcript(A), 0);
    watcher.on().changed(transcript(A));
    watcher.on().folderRemoved(root);
    detection.stop();
    const logged = consoleCalls().join('\n');
    for (const secret of [tmp, root, A, '秘密', 'secret', 'gundam', 'Bash']) {
      expect(logged).not.toContain(secret);
    }
  });
});
