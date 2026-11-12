/**
 * The Cursor adapter (Story 2.7) on a temporary projects folder with a fake
 * watcher and a fake stat for the project names: the spec's I/O matrix end
 * to end through createDetection (main/detection/sessions with the real
 * capability table, so the guessed approvals and questions are the real
 * ones) on fake clocks, then replay at start, subagents and the log.
 * Nothing here touches the real ~/.cursor.
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
import { createCursorAdapter } from '../../src/main/detection/adapters/cursor/cursor';
import type { StatPath } from '../../src/main/detection/adapters/cursor/project-name';
import { USER_ABORTED } from '../../src/main/detection/adapters/cursor/translate';
import type { TranscriptFs } from '../../src/main/detection/adapters/jsonl/read';
import {
  createDetection,
  type Detection,
} from '../../src/main/detection/detection';
import { BAD_LINE_STREAK_DEGRADED } from '../../src/shared/constants';
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
const KEY_A = `cursor:${A}`;
const KEY_B = `cursor:${B}`;
const SLUG = 'Users-me-code-gundam-pet';
const NAME = 'gundam-pet';
/** The folders the fake stat knows (POSIX paths on every platform). */
const FOLDERS = [
  '/Users',
  '/Users/me',
  '/Users/me/code',
  '/Users/me/code/gundam-pet',
];

let tmp: string;
let root: string;
let clock: FakeClock;
let watcher: ReturnType<typeof fakeWatcher>;
let heard: { sessions?: readonly { state: string }[] }[];
let consoleCalls: () => string[];
let statted: string[];

/** The fake stat: only FOLDERS are there, as folders. */
const stat: StatPath = (file) => {
  statted.push(file);
  if (FOLDERS.includes(file)) {
    return { isDirectory: () => true };
  }
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
};

/** main/settings as detection sees it. */
function fakeSettings() {
  const state: SettingsState = { rev: 0, values: { ...SETTINGS_DEFAULTS } };
  return { get: () => state, onChange: () => () => {} };
}

beforeEach(() => {
  // Resolved: the adapter watches the projects folder's real path.
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'awp-cursor-')));
  root = path.join(tmp, 'projects');
  mkdirSync(root);
  clock = fakeClock();
  watcher = fakeWatcher();
  heard = [];
  statted = [];
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

const transcript = (id: string, slug = SLUG) =>
  path.join(root, slug, 'agent-transcripts', id, `${id}.jsonl`);
const subagentTranscript = (parentId: string, name = 'sub-1') =>
  path.join(
    root,
    SLUG,
    'agent-transcripts',
    parentId,
    'subagents',
    `${name}.jsonl`,
  );

const rec = {
  user: (text = 'hi') => ({
    role: 'user',
    message: { content: [{ type: 'text', text }] },
  }),
  assistant: (...tools: string[]) => ({
    role: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Let me look.' },
        ...tools.map((name) => ({ type: 'tool_use', name, input: {} })),
      ],
    },
  }),
  ended: (status = 'success', error?: string) =>
    error === undefined
      ? { type: 'turn_ended', status }
      : { type: 'turn_ended', status, error },
};

const lines = (records: readonly unknown[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join('');

/**
 * Appends `records` to `file`, dated `mtimeAgoMs` before the fake wall
 * clock (the records' only time is the file's).
 */
function append(file: string, records: readonly unknown[], mtimeAgoMs = 0) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, lines(records));
  const when = new Date(clock.wall() - mtimeAgoMs);
  utimesSync(file, when, when);
}

// ---------------------------------------------------------------------------
// The adapter through createDetection.

function adapter(fs?: TranscriptFs) {
  return createCursorAdapter({
    root,
    watch: watcher.watch,
    fs,
    stat,
    platform: 'darwin',
  });
}

function startDetection(fs?: TranscriptFs): Detection {
  const detection = createDetection({
    settings: fakeSettings(),
    monotonic: clock.monotonic,
    wall: clock.wall,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    adapters: [adapter(fs)],
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
  return detection.get().adapters.find((a) => a.source === 'cursor')?.health;
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
  write(transcript(A), rec.user());
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
  const started = adapter(fs);
  started.start(context);
  return { adapter: started, emitted };
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
  it('新 session: a new transcript with a prompt shows up named after its project folder, 思考中', () => {
    const detection = running();
    expect(detection.get()).toStrictEqual({
      sessions: [
        {
          sessionKey: KEY_A,
          source: 'cursor',
          displayName: NAME,
          state: 'thinking',
          confidence: 'exact',
        },
      ],
      adapters: [{ source: 'cursor', health: 'ok' }],
    });
  });

  it('呼叫工具: an assistant record with tool_use is 工作中', () => {
    const detection = running();
    write(transcript(A), rec.assistant('Shell'));
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);
  });

  it('下一步: any record after it ends its tool calls; an assistant record with only text is 思考中', () => {
    const detection = running();
    write(transcript(A), rec.assistant('Shell', 'StrReplace'));
    clock.advance(5 * SECOND);
    write(transcript(A), rec.assistant());
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
    // The tool calls are over: nothing is guessed at for them.
    clock.advance(MINUTE);
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);

    write(transcript(A), rec.assistant('Write'));
    write(transcript(A), rec.user('and this'));
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
  });

  it('一輪結束: turn_ended success is 做完了, then 等你回覆 5 seconds later', () => {
    const detection = running();
    write(transcript(A), rec.assistant('Shell'), rec.ended());
    expect(states(detection)).toStrictEqual([`${KEY_A} done`]);
    clock.advance(5 * SECOND - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} done`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
  });

  it(`使用者中止: turn_ended with error ${USER_ABORTED} ends the turn; no 出錯了`, () => {
    const detection = running();
    write(transcript(A), rec.assistant('Shell'));
    write(transcript(A), rec.ended('error', USER_ABORTED));
    expect(states(detection)).toStrictEqual([`${KEY_A} done`]);
    clock.advance(5 * SECOND);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
  });

  it('錯誤: turn_ended with another error is 出錯了', () => {
    const detection = running();
    write(transcript(A), rec.ended('error', 'Connection failed'));
    expect(states(detection)).toStrictEqual([`${KEY_A} error`]);
  });

  it('重複的結束: two turn_ended in a row count once', () => {
    const detection = running();
    write(transcript(A), rec.ended());
    clock.advance(4 * SECOND);
    write(transcript(A), rec.ended('error', USER_ABORTED));
    expect(states(detection)).toStrictEqual([`${KEY_A} done`]);
    // 做完了 runs from the first one only.
    clock.advance(SECOND);
    expect(states(detection)).toStrictEqual([`${KEY_A} waiting`]);
  });

  it('推測批准: Shell with nothing newer for 10 seconds is 要你批准 (inferred); the next record ends it', () => {
    const detection = running();
    write(transcript(A), rec.assistant('Read', 'Shell'));
    clock.advance(10 * SECOND - 1);
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);
    clock.advance(1);
    expect(states(detection)).toStrictEqual([`${KEY_A} approval (inferred)`]);
    write(transcript(A), rec.assistant());
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
  });

  it('推測提問: AskQuestion with nothing newer for 10 seconds is 要你決定 (inferred)', () => {
    const detection = running();
    write(transcript(A), rec.assistant('AskQuestion'));
    clock.advance(10 * SECOND);
    expect(states(detection)).toStrictEqual([`${KEY_A} decision (inferred)`]);
    write(transcript(A), rec.assistant());
    expect(states(detection)).toStrictEqual([`${KEY_A} thinking`]);
  });

  it.each([
    'Read',
    'Glob',
    'Grep',
    'SearchConversations',
    'GetMcpTools',
    'WebSearch',
    'UpdateCurrentStep',
    'Task',
  ])('a no-guess tool, %s, stays 工作中 however long', (tool) => {
    const detection = running();
    write(transcript(A), rec.assistant(tool));
    clock.advance(4 * MINUTE);
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);
  });

  it("subagent: a subagent's records only move the parent session's last event time; no session of its own", () => {
    const detection = running();
    write(transcript(A), rec.assistant('Task'), rec.ended());
    clock.advance(4 * MINUTE);
    write(
      subagentTranscript(A),
      rec.user(),
      rec.assistant('Read'),
      rec.ended(),
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

  it('整檔重寫: a transcript written anew, smaller, with the same records first: only the new records count', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    write(transcript(A), rec.user(), rec.assistant('Shell'));
    const count = emitted.length;
    writeFileSync(transcript(A), lines([rec.user(), rec.ended()]));
    watcher.on().changed(transcript(A));
    expect(
      emitted.slice(count).map((batch) => batchLines(batch.outputs)),
    ).toStrictEqual([[`${KEY_A} turn.end`, `${KEY_A} session.meta`]]);
    expect(consoleCalls()).toContain(
      '[detection] cursor: a transcript got smaller; read it again from its start (1 lines read before skipped, 1 new)',
    );
  });

  it('整檔重寫, through detection: 做完了, not a new turn', () => {
    const detection = running();
    write(transcript(A), rec.assistant('Shell'));
    writeFileSync(transcript(A), lines([rec.user(), rec.ended()]));
    watcher.on().changed(transcript(A));
    expect(states(detection)).toStrictEqual([`${KEY_A} done`]);
  });

  it('名稱: a slug read back to a folder is named after it; one that is not, after the slug', () => {
    const detection = startDetection();
    watcher.on().ready();
    const gone = 'Users-me-code-gone-project';
    write(transcript(A), rec.user());
    write(transcript(B, gone), rec.user());
    expect(
      detection.get().sessions.map((s) => [s.sessionKey, s.displayName]),
    ).toStrictEqual([
      [KEY_A, NAME],
      [KEY_B, gone],
    ]);
    // Only stats, one search per slug.
    const count = statted.length;
    write(transcript(A), rec.assistant());
    write(transcript(B, gone), rec.assistant());
    expect(statted).toHaveLength(count);
  });

  it('太舊: a transcript modified 3 hours ago does not show', () => {
    append(transcript(A), [rec.user()], 3 * HOUR);
    const detection = startDetection();
    watcher.on().ready();
    expect(detection.get().sessions).toStrictEqual([]);
  });

  it(`壞行: ${BAD_LINE_STREAK_DEGRADED} unreadable lines in a row make the health degraded; the other records still count`, () => {
    const detection = running();
    appendFileSync(
      transcript(A),
      'not json\n'.repeat(BAD_LINE_STREAK_DEGRADED - 1),
    );
    write(transcript(A), rec.assistant('Shell'));
    expect(healthOf(detection)).toBe('ok');
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);

    appendFileSync(
      transcript(A),
      '{"broken"\n[1,2]\n'.repeat(BAD_LINE_STREAK_DEGRADED / 2),
    );
    watcher.on().changed(transcript(A));
    expect(healthOf(detection)).toBe('degraded');
    expect(states(detection)).toStrictEqual([`${KEY_A} working`]);

    write(transcript(B), rec.user());
    expect(healthOf(detection)).toBe('ok');
  });

  it('沒有資料夾: with no projects folder the health is missing; nothing is watched or thrown', () => {
    rmSync(root, { recursive: true });
    const detection = startDetection();
    expect(detection.get()).toStrictEqual({
      sessions: [],
      adapters: [{ source: 'cursor', health: 'missing' }],
    });
    expect(watcher.state.started).toBe(0);
  });
});

describe('start and replay', () => {
  it('replays sessions oldest first, then subagents of sessions it read; skips subagents of sessions it did not', () => {
    append(transcript(B), [rec.user()], 2 * MINUTE);
    append(transcript(A), [rec.user()], 3 * MINUTE);
    append(subagentTranscript(A), [rec.user()], MINUTE);
    // Its parent session's transcript is too old to replay.
    const old = 'dddddddd-0000-4000-8000-000000000004';
    append(transcript(old), [rec.user()], 3 * HOUR);
    append(subagentTranscript(old), [rec.user()], MINUTE);
    // Beside the transcripts: never read.
    mkdirSync(path.join(root, SLUG, 'canvases'), { recursive: true });
    writeFileSync(
      path.join(root, SLUG, 'canvases', 'x.jsonl'),
      lines([rec.user()]),
    );
    writeFileSync(path.join(root, 'cli-config.json'), '{}');

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
      '[detection] cursor: started; watching the projects folder',
      '[detection] cursor: replayed 3 transcripts modified within the discovery window (2 sessions, 2 subagents; 5 transcripts in all); sync.ready',
    ]);
  });

  it.each([
    ['a minute ago', MINUTE, `${KEY_A} waiting`],
    ['an hour ago', HOUR, `${KEY_A} idle`],
  ])(
    '補讀: a transcript last written %s, its turn ended, is 等你回覆 or 休息中 once synced, never 做完了',
    (_label, agoMs, expected) => {
      append(
        transcript(A),
        [rec.user(), rec.assistant('Shell'), rec.ended()],
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

  it("a subagent's records count only once its parent session started in a transcript read", () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    write(subagentTranscript(A), rec.user());
    expect(emitted).toHaveLength(2);
    // The parent's transcript with no message yet: not started.
    write(transcript(A), rec.ended());
    write(subagentTranscript(A), rec.assistant());
    expect(emitted).toHaveLength(2);

    write(transcript(A), rec.user());
    write(subagentTranscript(A), rec.ended());
    // Created after the start: read from its start, every record.
    expect(batchLines(emitted.at(-1)?.outputs ?? [])).toStrictEqual([
      `${KEY_A} activity`,
      `${KEY_A} activity`,
      `${KEY_A} activity`,
    ]);
  });

  it('the name stays after later reads', () => {
    const detection = running();
    write(transcript(A), rec.assistant('Shell'), rec.ended());
    write(transcript(A), rec.user());
    expect(detection.get().sessions[0]?.displayName).toBe(NAME);
  });

  it('every emitted event passes the shared schema', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    append(transcript(A), [
      rec.user(),
      rec.assistant('Read', 'Shell', 'AskQuestion'),
      rec.assistant(),
      rec.ended(),
      rec.ended('error', USER_ABORTED),
      rec.user(),
      rec.ended('error', 'x'),
      { role: 'system' },
    ]);
    watcher.on().added(transcript(A));
    append(subagentTranscript(A), [rec.user(), rec.ended()]);
    watcher.on().added(subagentTranscript(A));
    const outputs = emitted.flatMap((batch) => batch.outputs);
    expect(outputs.length).toBeGreaterThan(10);
    for (const output of outputs) {
      if (output.type !== 'sync.ready') {
        expect(detectionEventSchema.safeParse(output).success).toBe(true);
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
    expect(follow?.(subagentTranscript(A), stats(HOUR))).toBe(true);
    expect(follow?.(path.join(root, 'cli-config.json'), stats(0))).toBe(false);
  });

  it("removed while running: the sessions read before are forgotten, so a subagent waits until its parent's transcript is read again", () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    append(transcript(A), [rec.user()]);
    watcher.on().added(transcript(A));
    // A's own transcript drops out of the discovery window: not replayed.
    append(transcript(A), [], 3 * HOUR);
    append(subagentTranscript(A), [rec.user()]);

    watcher.on().folderRemoved(root);
    clock.advance(30 * SECOND);
    const before = emitted.length;
    watcher.on().ready();

    expect(consoleCalls()).toContain(
      '[detection] cursor: replayed 0 transcripts modified within the discovery window (0 sessions, 1 subagents; 2 transcripts in all)',
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

describe('the default stat and platform', () => {
  // Windows slugs: no real sample to know Cursor's form by.
  it.skipIf(process.platform === 'win32')(
    "names a session after a real project folder, read back from its slug with the file system's stat",
    () => {
      const project = path.join(tmp, 'work', 'gundam_pet.v2');
      mkdirSync(project, { recursive: true });
      // Cursor's rule: every character that is not a letter or a digit
      // becomes `-`; the leading one is left out.
      const slug = project.replace(/[^A-Za-z0-9]/g, '-').replace(/^-+/, '');
      const detection = createDetection({
        settings: fakeSettings(),
        monotonic: clock.monotonic,
        wall: clock.wall,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        adapters: [createCursorAdapter({ root, watch: watcher.watch })],
      });
      watcher.on().ready();
      write(transcript(A, slug), rec.user());
      expect(
        detection.get().sessions.map((s) => [s.sessionKey, s.displayName]),
      ).toStrictEqual([[KEY_A, 'gundam_pet.v2']]);
      detection.stop();
    },
  );
});

describe('the log', () => {
  it('gets no path, name or record content', () => {
    const detection = running();
    write(transcript(A), rec.assistant('Shell'), rec.user('秘密的提示'));
    writeFileSync(transcript(A), lines([rec.user()]));
    watcher.on().changed(transcript(A));
    appendFileSync(
      transcript(A),
      'secret text\n'.repeat(BAD_LINE_STREAK_DEGRADED),
    );
    watcher.on().changed(transcript(A));
    watcher.on().folderRemoved(root);
    detection.stop();
    const logged = consoleCalls().join('\n');
    for (const secret of [
      tmp,
      root,
      A,
      SLUG,
      NAME,
      '秘密',
      'secret',
      'Shell',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
