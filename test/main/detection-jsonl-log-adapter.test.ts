/**
 * The shared JSON Lines adapter core (src/main/detection/adapters/jsonl/
 * log-adapter) on its own, with a minimal made-up source (Story 2.6):
 *
 * - `startState`: a transcript's starting state from its first line, and
 *   a transcript not followed until that line is there;
 * - every callback a source hands in may throw: the adapter keeps going,
 *   skips what it must, still sends `sync.ready`, and logs the callback and
 *   error code once;
 * - `rereadShrunk` (Story 2.7): a transcript that got smaller is read
 *   again from its start, the lines read before skipped.
 *
 * A temporary records folder and a fake watcher; nothing real is read.
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext } from '../../src/main/detection/adapter';
import {
  createJsonlLogAdapter,
  type JsonlLogAdapterOptions,
} from '../../src/main/detection/adapters/jsonl/log-adapter';
import type { Fields } from '../../src/main/detection/adapters/jsonl/records';
import {
  partsBelow,
  shouldFollow,
} from '../../src/main/detection/adapters/jsonl/watcher';
import {
  BAD_LINE_STREAK_DEGRADED,
  FIRST_LINE_MAX_BYTES,
  RECORDS_FOLDER_RECHECK_MS,
  REPLAY_TAIL_BYTES,
  TRAILING_READ_MS,
} from '../../src/shared/constants';
import {
  type AdapterOutput,
  type DetectionEvent,
  makeSessionKey,
  type SessionKey,
} from '../../src/shared/detection-events';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import type { AdapterHealth } from '../../src/shared/sources';
import { fakeClock, type FakeClock } from '../helpers/fake-clock';
import { fakeWatcher } from '../helpers/jsonl-adapter';

let tmp: string;
let root: string;
let clock: FakeClock;
let watcher: ReturnType<typeof fakeWatcher>;
let consoleCalls: () => string[];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'awp-jsonl-core-')));
  root = path.join(tmp, 'records');
  mkdirSync(root);
  clock = fakeClock();
  watcher = fakeWatcher();
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
// A made-up source: `<root>/<name>.jsonl`, one session per file (`codex:
// <name>`, or the id its header names). A `{"id":...}` record is a header;
// `{"type":"prompt"}` starts a turn; anything else is an activity.

interface Where {
  readonly name: string;
}

interface State {
  readonly id: string | null;
  readonly started: boolean;
}

const INITIAL: State = Object.freeze({ id: null, started: false });

const file = (name: string) => path.join(root, `${name}.jsonl`);

function locate(base: string, entry: string): Where | null {
  const parts = partsBelow(base, entry);
  const [only = ''] = parts ?? [];
  return parts?.length === 1 && only.endsWith('.jsonl')
    ? { name: only.slice(0, -'.jsonl'.length) }
    : null;
}

function keyOf(state: State, where: Where): SessionKey {
  return makeSessionKey('codex', state.id ?? where.name) ?? 'codex:none';
}

function translate(
  record: Fields,
  state: State,
  context: Where & { readonly replay: boolean },
) {
  if (typeof record.id === 'string') {
    return { state, events: [] };
  }
  const common = {
    source: 'codex',
    sessionKey: keyOf(state, context),
    ts: clock.wall(),
    via: 'log',
    confidence: 'exact',
    ...(context.replay ? { replay: true as const } : {}),
  } as const;
  const events: DetectionEvent[] = state.started
    ? []
    : [{ type: 'session.start', ...common }];
  events.push({
    type: record.type === 'prompt' ? 'turn.start' : 'activity',
    ...common,
  });
  return { state: { ...state, started: true }, events };
}

type Options = JsonlLogAdapterOptions<Where, State>;

function startAdapter(overrides: Partial<Options> = {}) {
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
  const adapter = createJsonlLogAdapter<Where, State>({
    source: 'codex',
    logPrefix: 'core-test',
    root,
    rootName: 'records folder',
    watch: watcher.watch,
    watchDepth: 0,
    locate,
    follow: (base, entry, stats, recent) =>
      shouldFollow(base, entry, stats, recent, (parts) =>
        parts.length === 1 ? 'transcript' : null,
      ),
    scan: (base, list) => [
      {
        label: 'logs',
        files: list(base)
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
          .map((entry) => path.join(base, entry.name)),
      },
    ],
    initialState: INITIAL,
    translate,
    nameEvent: () => null,
    ...overrides,
  });
  adapter.start(context);
  return { adapter, emitted };
}

/** Every event emitted so far, as `<key> <type>[ replay]`. */
function events(
  emitted: readonly { outputs: readonly AdapterOutput[] }[],
): string[] {
  return emitted.flatMap((batch) =>
    batch.outputs.map((output) =>
      output.type === 'sync.ready'
        ? 'sync.ready'
        : `${output.sessionKey} ${output.type}${output.replay === true ? ' replay' : ''}`,
    ),
  );
}

const lines = (records: readonly unknown[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join('');

/** The header's id as the starting state; null when it is not a header. */
const startFromHeader = (first: Fields | null): State | null =>
  first !== null && typeof first.id === 'string'
    ? { id: first.id, started: false }
    : null;

/** Writes `records` to `name`'s transcript and reports it, as the watcher would. */
function write(name: string, records: readonly unknown[], added = true): void {
  appendFileSync(file(name), lines(records));
  if (added) {
    watcher.on().added(file(name));
  } else {
    watcher.on().changed(file(name));
  }
}

const boom = () => {
  throw Object.assign(new Error('source bug'), { code: 'EBOOM' });
};

describe('startState', () => {
  it('starts a transcript from its first line: the header names the session', () => {
    const { emitted } = startAdapter({ startState: startFromHeader });
    watcher.on().ready();
    write('a', [{ id: 'real-id' }, { type: 'prompt' }]);
    expect(events(emitted)).toStrictEqual([
      'sync.ready',
      'codex:real-id session.start',
      'codex:real-id turn.start',
    ]);
  });

  it('hands it the first line even when only the tail is replayed', () => {
    const filler = { type: 'other', pad: 'x'.repeat(1000) };
    writeFileSync(
      file('a'),
      lines([
        { id: 'from-header' },
        ...Array.from(
          { length: Math.ceil(REPLAY_TAIL_BYTES / 1000) + 10 },
          () => filler,
        ),
        { type: 'prompt' },
      ]),
    );
    const firsts: (Fields | null)[] = [];
    const { emitted } = startAdapter({
      startState: (first) => {
        firsts.push(first);
        return startFromHeader(first);
      },
    });
    watcher.on().ready();
    expect(firsts).toStrictEqual([{ id: 'from-header' }]);
    const keys = new Set(
      emitted.flatMap((batch) =>
        batch.outputs.flatMap((output) =>
          output.type === 'sync.ready' ? [] : [output.sessionKey],
        ),
      ),
    );
    expect(keys).toStrictEqual(new Set(['codex:from-header']));
  });

  it('a first line not complete yet: not followed, nothing sent; tried again at the next change, from the start', () => {
    const { emitted } = startAdapter({ startState: startFromHeader });
    watcher.on().ready();
    const header = JSON.stringify({ id: 'later' });
    writeFileSync(file('a'), header.slice(0, 5));
    watcher.on().added(file('a'));
    expect(events(emitted)).toStrictEqual(['sync.ready']);

    appendFileSync(
      file('a'),
      `${header.slice(5)}\n${lines([{ type: 'prompt' }])}`,
    );
    watcher.on().changed(file('a'));
    expect(events(emitted)).toStrictEqual([
      'sync.ready',
      'codex:later session.start',
      'codex:later turn.start',
    ]);
  });

  it(`a first line longer than ${FIRST_LINE_MAX_BYTES} bytes is handed in as null`, () => {
    writeFileSync(
      file('a'),
      `${JSON.stringify({ id: 'x', pad: 'y'.repeat(FIRST_LINE_MAX_BYTES) })}\n`,
    );
    const firsts: (Fields | null)[] = [];
    const { emitted } = startAdapter({
      startState: (first) => {
        firsts.push(first);
        return startFromHeader(first);
      },
    });
    watcher.on().ready();
    expect(firsts).toStrictEqual([null]);
    expect(events(emitted)).toStrictEqual(['sync.ready']);
  });

  it('a first line that is not a record is handed in as null; null keeps the transcript unfollowed until a change', () => {
    writeFileSync(file('a'), 'not json\n');
    const { emitted } = startAdapter({ startState: startFromHeader });
    watcher.on().ready();
    expect(events(emitted)).toStrictEqual(['sync.ready']);
    expect(consoleCalls().join('\n')).toContain(
      'replayed 0 transcripts modified within the discovery window (1 logs; 1 transcripts in all); sync.ready',
    );
    // There at the scan: once it changes, replayed from its tail.
    writeFileSync(file('a'), lines([{ id: 'b' }, { type: 'prompt' }]));
    watcher.on().changed(file('a'));
    expect(events(emitted)).toStrictEqual([
      'sync.ready',
      'codex:b session.start replay',
      'codex:b turn.start replay',
    ]);
  });

  it('a complete first line it cannot start from is logged once per transcript, with no path or content; an incomplete one is not', () => {
    const { emitted } = startAdapter({ startState: startFromHeader });
    watcher.on().ready();
    const notStart =
      "[detection] core-test: a transcript's first line is not a usable start; not followed";
    // Incomplete: silent.
    writeFileSync(file('a'), '{"id":"x"');
    watcher.on().added(file('a'));
    expect(consoleCalls()).not.toContain(notStart);

    // A record, but no header: logged once, however often it changes.
    write('b', [{ type: 'prompt', secret: 'private text' }]);
    write('b', [{ type: 'prompt' }], false);
    // Another transcript like it: logged once more.
    write('c', [{ type: 'prompt' }]);
    expect(consoleCalls().filter((call) => call === notStart)).toHaveLength(2);
    expect(events(emitted)).toStrictEqual(['sync.ready']);
    const logged = consoleCalls().join('\n');
    expect(logged).not.toContain('private');
    expect(logged).not.toContain(tmp);
  });

  it('is asked only once per transcript followed', () => {
    const startState = vi.fn(startFromHeader);
    startAdapter({ startState });
    watcher.on().ready();
    write('a', [{ id: 'a' }, { type: 'prompt' }]);
    write('a', [{ type: 'other' }], false);
    write('a', [{ type: 'other' }], false);
    expect(startState).toHaveBeenCalledTimes(1);
  });
});

describe('the trailing read', () => {
  it(`a record appended after a change read, with no change reported for it, is read ${TRAILING_READ_MS} ms later; nothing new, nothing sent`, () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    write('a', [{ type: 'prompt' }]);
    // chokidar dropped the change of this write (within its 50 ms).
    appendFileSync(file('a'), lines([{ type: 'other' }]));
    clock.advance(TRAILING_READ_MS - 1);
    expect(events(emitted)).toStrictEqual([
      'sync.ready',
      'codex:a session.start',
      'codex:a turn.start',
    ]);
    clock.advance(1);
    expect(events(emitted)).toStrictEqual([
      'sync.ready',
      'codex:a session.start',
      'codex:a turn.start',
      'codex:a activity',
    ]);
    // One trailing read per change read: none waits any more.
    expect(clock.pendingCount()).toBe(0);
    const count = emitted.length;
    write('a', [], false);
    clock.advance(TRAILING_READ_MS);
    expect(emitted).toHaveLength(count);
  });

  it('one timer per transcript: each change of it moves its trailing read later', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    write('a', [{ type: 'prompt' }]);
    clock.advance(TRAILING_READ_MS - 10);
    write('a', [{ type: 'other' }], false);
    write('b', [{ type: 'prompt' }]);
    expect(clock.pendingCount()).toBe(2);
    appendFileSync(file('a'), lines([{ type: 'other' }]));
    clock.advance(TRAILING_READ_MS - 1);
    expect(
      events(emitted).filter((e) => e === 'codex:a activity'),
    ).toHaveLength(1);
    clock.advance(1);
    expect(
      events(emitted).filter((e) => e === 'codex:a activity'),
    ).toHaveLength(2);
    expect(clock.pendingCount()).toBe(0);
  });

  it('is cancelled when the adapter stops', () => {
    const { adapter, emitted } = startAdapter();
    watcher.on().ready();
    write('a', [{ type: 'prompt' }]);
    expect(clock.pendingCount()).toBe(1);
    adapter.stop();
    expect(clock.pendingCount()).toBe(0);
    appendFileSync(file('a'), lines([{ type: 'other' }]));
    const count = emitted.length;
    clock.advance(TRAILING_READ_MS);
    expect(emitted).toHaveLength(count);
  });

  it('is cancelled when the folder goes away; the watcher that comes back starts afresh', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    write('a', [{ type: 'prompt' }]);
    watcher.on().folderRemoved(root);
    // Only the check for the folder waits.
    expect(clock.pendingCount()).toBe(1);
    appendFileSync(file('a'), lines([{ type: 'other' }]));
    clock.advance(TRAILING_READ_MS);
    expect(events(emitted)).toStrictEqual([
      'sync.ready',
      'codex:a session.start',
      'codex:a turn.start',
    ]);
    clock.advance(RECORDS_FOLDER_RECHECK_MS - TRAILING_READ_MS);
    expect(watcher.state.started).toBe(2);
    expect(clock.pendingCount()).toBe(0);
  });
});

describe('a source callback that throws', () => {
  it('follow: that path is not followed; the watcher hears no throw', () => {
    startAdapter({ follow: boom });
    expect(watcher.state.follow?.(file('a'))).toBe(false);
    expect(watcher.state.follow?.(file('b'))).toBe(false);
    expect(consoleCalls()).toStrictEqual([
      '[detection] core-test: started; watching the records folder',
      "[detection] core-test: the source's follow threw (EBOOM); not following that path",
    ]);
  });

  it('scan: no transcripts are replayed, sync.ready is still sent', () => {
    writeFileSync(file('a'), lines([{ type: 'prompt' }]));
    const { emitted } = startAdapter({ scan: boom });
    watcher.on().ready();
    expect(events(emitted)).toStrictEqual(['sync.ready']);
    expect(consoleCalls()).toContain(
      "[detection] core-test: the source's scan threw (EBOOM); replaying nothing",
    );
    expect(consoleCalls()).toContain(
      '[detection] core-test: replayed 0 transcripts modified within the discovery window (0 transcripts in all); sync.ready',
    );
  });

  it('locate: that transcript is skipped; the others are read and sync.ready is sent', () => {
    writeFileSync(file('a'), lines([{ type: 'prompt' }]));
    writeFileSync(file('b'), lines([{ type: 'prompt' }]));
    const { emitted } = startAdapter({
      locate: (base, entry) =>
        entry === file('a') ? boom() : locate(base, entry),
    });
    watcher.on().ready();
    expect(events(emitted)).toStrictEqual([
      'codex:b session.start replay',
      'codex:b turn.start replay',
      'sync.ready',
    ]);
    expect(consoleCalls()).toContain(
      "[detection] core-test: the source's locate threw (EBOOM); skipping that transcript",
    );
  });

  it('gate.allows: that transcript is skipped; sync.ready is sent', () => {
    writeFileSync(file('a'), lines([{ type: 'prompt' }]));
    const { emitted } = startAdapter({
      gate: { allows: boom, read: () => {}, reset: () => {} },
    });
    watcher.on().ready();
    expect(events(emitted)).toStrictEqual(['sync.ready']);
    expect(consoleCalls()).toContain(
      "[detection] core-test: the source's gate.allows threw (EBOOM); skipping that transcript",
    );
  });

  it('startState: that transcript is skipped and not followed; sync.ready is sent', () => {
    writeFileSync(file('a'), lines([{ id: 'a' }, { type: 'prompt' }]));
    writeFileSync(file('b'), lines([{ id: 'b' }, { type: 'prompt' }]));
    const { emitted } = startAdapter({
      startState: (first) =>
        first?.id === 'a' ? boom() : startFromHeader(first),
    });
    watcher.on().ready();
    expect(events(emitted)).toStrictEqual([
      'codex:b session.start replay',
      'codex:b turn.start replay',
      'sync.ready',
    ]);
    expect(consoleCalls()).toContain(
      "[detection] core-test: the source's startState threw (EBOOM); skipping that transcript",
    );
  });

  it('translate: that line counts as unreadable and reading goes on with the next', () => {
    const { emitted } = startAdapter({
      translate: (record, state, context) =>
        record.type === 'bad' ? boom() : translate(record, state, context),
    });
    watcher.on().ready();
    write('a', [{ type: 'bad' }, { type: 'prompt' }]);
    expect(events(emitted)).toStrictEqual([
      'sync.ready',
      'codex:a session.start',
      'codex:a turn.start',
    ]);
    expect(consoleCalls()).toContain(
      "[detection] core-test: the source's translate threw (EBOOM); counting that line as unreadable",
    );

    // As many in a row as make a streak: degraded, as for unreadable lines.
    write(
      'a',
      Array.from({ length: BAD_LINE_STREAK_DEGRADED }, () => ({ type: 'bad' })),
      false,
    );
    expect(emitted.at(-1)?.health).toBe('degraded');
    write('a', [{ type: 'prompt' }], false);
    expect(emitted.at(-1)?.health).toBe('ok');
  });

  it('nameEvent: the events read are still sent', () => {
    const { emitted } = startAdapter({ nameEvent: boom });
    watcher.on().ready();
    write('a', [{ type: 'prompt' }]);
    expect(events(emitted)).toStrictEqual([
      'sync.ready',
      'codex:a session.start',
      'codex:a turn.start',
    ]);
    expect(consoleCalls()).toContain(
      "[detection] core-test: the source's nameEvent threw (EBOOM); sending the read without it",
    );
  });

  it('gate.read: the events read are still sent, and the transcript is followed', () => {
    const { emitted } = startAdapter({
      gate: { allows: () => true, read: boom, reset: () => {} },
    });
    watcher.on().ready();
    write('a', [{ type: 'prompt' }]);
    write('a', [{ type: 'other' }], false);
    expect(events(emitted)).toStrictEqual([
      'sync.ready',
      'codex:a session.start',
      'codex:a turn.start',
      'codex:a activity',
    ]);
    expect(consoleCalls()).toContain(
      "[detection] core-test: the source's gate.read threw (EBOOM); going on",
    );
  });

  it('gate.reset: the adapter still stops (and still goes missing when the folder goes away)', () => {
    const { adapter, emitted } = startAdapter({
      gate: { allows: () => true, read: () => {}, reset: boom },
    });
    watcher.on().ready();
    watcher.on().folderRemoved(root);
    expect(emitted.at(-1)?.health).toBe('missing');
    adapter.stop();
    expect(consoleCalls()).toContain(
      "[detection] core-test: the source's gate.reset threw (EBOOM); going on",
    );
    expect(consoleCalls()).toContain('[detection] core-test: stopped');
  });

  it('is logged once per callback and error code, with no path or content', () => {
    const { emitted } = startAdapter({
      translate: (record) => {
        throw Object.assign(new Error(String(record.secret)), {
          code: record.type === 'other' ? 'EOTHER' : 'EBOOM',
        });
      },
    });
    watcher.on().ready();
    write('a', [
      { type: 'x', secret: 'private text' },
      { type: 'x', secret: 'private text' },
      { type: 'other', secret: 'private text' },
    ]);
    expect(events(emitted)).toStrictEqual(['sync.ready']);
    const failures = consoleCalls().filter((call) => call.includes('threw'));
    expect(failures).toStrictEqual([
      "[detection] core-test: the source's translate threw (EBOOM); counting that line as unreadable",
      "[detection] core-test: the source's translate threw (EOTHER); counting that line as unreadable",
    ]);
    const logged = consoleCalls().join('\n');
    expect(logged).not.toContain('private');
    expect(logged).not.toContain(tmp);
  });
});

describe('rereadShrunk', () => {
  const start = () => startAdapter({ rereadShrunk: true });
  /** Every event emitted after the first `count`. */
  const after = (
    emitted: readonly { outputs: readonly AdapterOutput[] }[],
    count: number,
  ) => events(emitted.slice(count));
  const filler = (n: number) => ({ type: 'other', n, pad: 'x'.repeat(1000) });
  const fillers = (count: number) =>
    Array.from({ length: count }, (_, n) => filler(n));

  it('a transcript that got smaller is read again from its start: the lines read before are skipped, the rest sent, not replayed', () => {
    const { emitted } = start();
    watcher.on().ready();
    write('a', [
      { type: 'prompt' },
      { type: 'other', n: 1 },
      { type: 'other', n: 2, pad: 'x'.repeat(100) },
    ]);
    const count = emitted.length;
    writeFileSync(
      file('a'),
      lines([{ type: 'prompt' }, { type: 'other', n: 1 }, { type: 'prompt' }]),
    );
    watcher.on().changed(file('a'));
    // The translation state goes on: no second session.start.
    expect(after(emitted, count)).toStrictEqual(['codex:a turn.start']);
    expect(consoleCalls()).toContain(
      '[detection] core-test: a transcript got smaller; read it again from its start (2 lines read before skipped, 1 new)',
    );
    expect(consoleCalls().join('\n')).not.toContain('replaying');

    // Read on from there as usual.
    write('a', [{ type: 'other' }], false);
    expect(after(emitted, count)).toStrictEqual([
      'codex:a turn.start',
      'codex:a activity',
    ]);
  });

  it('from the first line that differs, every line is sent, even one equal to the line read before at its place', () => {
    const { emitted } = start();
    watcher.on().ready();
    write('a', [
      { type: 'prompt' },
      { type: 'other', n: 1, pad: 'x'.repeat(100) },
      { type: 'other', n: 2 },
    ]);
    const count = emitted.length;
    writeFileSync(
      file('a'),
      lines([{ type: 'prompt' }, { type: 'prompt' }, { type: 'other', n: 2 }]),
    );
    watcher.on().changed(file('a'));
    expect(after(emitted, count)).toStrictEqual([
      'codex:a turn.start',
      'codex:a activity',
    ]);
    expect(consoleCalls()).toContain(
      '[detection] core-test: a transcript got smaller; read it again from its start (1 lines read before skipped, 2 new)',
    );
  });

  it('emptied, then written anew: the lines read before are still skipped at the next read', () => {
    const { emitted } = start();
    watcher.on().ready();
    const before = [{ type: 'prompt' }, { type: 'other', n: 1 }];
    write('a', before);
    const count = emitted.length;
    truncateSync(file('a'), 0);
    watcher.on().changed(file('a'));
    expect(after(emitted, count)).toStrictEqual([]);
    // Written in two pieces; the second ends in the middle of a line.
    appendFileSync(file('a'), lines(before.slice(0, 1)));
    watcher.on().changed(file('a'));
    const rest = lines([...before.slice(1), { type: 'prompt' }]);
    appendFileSync(file('a'), rest.slice(0, -5));
    watcher.on().changed(file('a'));
    expect(after(emitted, count)).toStrictEqual([]);
    appendFileSync(file('a'), rest.slice(-5));
    watcher.on().changed(file('a'));
    expect(after(emitted, count)).toStrictEqual(['codex:a turn.start']);
  });

  it('cut to its first lines (not emptied): a line appended later is new, even one equal to the line read before at its place', () => {
    const { emitted } = start();
    watcher.on().ready();
    write('a', [{ type: 'prompt' }, { type: 'other', n: 1 }]);
    const count = emitted.length;
    writeFileSync(file('a'), lines([{ type: 'prompt' }]));
    watcher.on().changed(file('a'));
    expect(after(emitted, count)).toStrictEqual([]);
    write('a', [{ type: 'other', n: 1 }], false);
    expect(after(emitted, count)).toStrictEqual(['codex:a activity']);
  });

  it('every line read before matched: the next one is new', () => {
    const { emitted } = start();
    watcher.on().ready();
    write('a', [{ type: 'prompt' }, { type: 'other', pad: 'x'.repeat(100) }]);
    const count = emitted.length;
    writeFileSync(file('a'), lines([{ type: 'prompt' }]));
    watcher.on().changed(file('a'));
    write('a', [{ type: 'prompt' }], false);
    expect(after(emitted, count)).toStrictEqual(['codex:a turn.start']);
  });

  it(`grown past ${REPLAY_TAIL_BYTES} bytes, then smaller than that: the lines read before are still skipped`, () => {
    const { emitted } = start();
    watcher.on().ready();
    const many = fillers(Math.ceil(REPLAY_TAIL_BYTES / 1000) + 500);
    write('a', [{ type: 'prompt' }]);
    write('a', many, false);
    const count = emitted.length;
    writeFileSync(
      file('a'),
      lines([{ type: 'prompt' }, ...many.slice(0, 1500), { type: 'prompt' }]),
    );
    watcher.on().changed(file('a'));
    expect(after(emitted, count)).toStrictEqual(['codex:a turn.start']);
  });

  it(`still longer than ${REPLAY_TAIL_BYTES} bytes once smaller: replayed from its tail, as without it`, () => {
    const { emitted } = start();
    watcher.on().ready();
    write('a', [{ type: 'prompt' }]);
    write('a', fillers(Math.ceil(REPLAY_TAIL_BYTES / 1000) + 1000), false);
    const count = emitted.length;
    truncateSync(file('a'), REPLAY_TAIL_BYTES + 500_000);
    watcher.on().changed(file('a'));
    const replayed = after(emitted, count);
    expect(replayed.length).toBeGreaterThan(1000);
    expect(replayed.every((line) => line === 'codex:a activity replay')).toBe(
      true,
    );
    expect(consoleCalls()).toContain(
      '[detection] core-test: a transcript got smaller; replaying its last 2 MiB again',
    );
  });

  it(`first read from its tail (longer than ${REPLAY_TAIL_BYTES} bytes): once smaller, replayed from its tail, as without it`, () => {
    writeFileSync(
      file('a'),
      lines([
        { type: 'prompt' },
        ...fillers(Math.ceil(REPLAY_TAIL_BYTES / 1000) + 10),
      ]),
    );
    const { emitted } = start();
    watcher.on().ready();
    const count = emitted.length;
    writeFileSync(file('a'), lines([{ type: 'prompt' }]));
    watcher.on().changed(file('a'));
    expect(after(emitted, count)).toStrictEqual(['codex:a turn.start replay']);
    expect(consoleCalls()).toContain(
      '[detection] core-test: a transcript got smaller; replaying its last 2 MiB again',
    );
  });

  it('without it, a transcript that got smaller is replayed from its tail', () => {
    const { emitted } = startAdapter();
    watcher.on().ready();
    write('a', [{ type: 'prompt' }, { type: 'other', pad: 'x'.repeat(100) }]);
    const count = emitted.length;
    writeFileSync(file('a'), lines([{ type: 'prompt' }]));
    watcher.on().changed(file('a'));
    expect(after(emitted, count)).toStrictEqual(['codex:a turn.start replay']);
  });
});
