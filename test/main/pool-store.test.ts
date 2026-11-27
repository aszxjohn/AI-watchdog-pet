/**
 * main/pool (Story 2.8): assignments.json, the released keys (and, since
 * the session bulk-lock, the locked keys and 鎖定展示), the start-up
 * sweep, and the pool section as StageView carries it. Real files in a temp
 * folder; fake timers for the debounce.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext } from '../../src/main/detection/adapter';
import { createDetection } from '../../src/main/detection/detection';
import { flushOnQuit } from '../../src/main/persist/quit';
import {
  loadPool,
  POOL_MIGRATIONS,
  type PoolFs,
  type PoolStoreOptions,
} from '../../src/main/pool/store';
import { POOL_FLUSH_DEBOUNCE_MS } from '../../src/shared/constants';
import {
  confidenceFor,
  detectionEventSchema,
  type DetectionEvent,
  type SessionKey,
  splitSessionKey,
} from '../../src/shared/detection-events';
import {
  POOL_SET_RELEASED_MANY_MAX_KEYS,
  poolFileSchema,
  stagePoolSchema,
} from '../../src/shared/pool';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import type { SourceCode } from '../../src/shared/sources';
import { fakeClock } from '../helpers/fake-clock';

/** Local time, so the backup suffix below is the same in every time zone. */
const NOW = new Date(2026, 10, 12, 9, 30, 5).getTime();
const BACKUP = 'assignments.json.broken-20261112-093005';
const A: SessionKey = 'claude-code:00000000-0000-4000-8000-00000000000a';
const B: SessionKey = 'codex:0199a3c2-7f1e-0000-0000-00000000000b';
const DEMO: SessionKey = 'demo:1';

let dir: string;
let file: string;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-pool-'));
  file = path.join(dir, 'assignments.json');
  consoleSpies = (['info', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every console line logged so far at `level` (all levels when omitted). */
function logged(level?: 'info' | 'warn' | 'error'): string[] {
  const spies =
    level === undefined
      ? consoleSpies
      : [consoleSpies[['info', 'warn', 'error'].indexOf(level)]!];
  return spies.flatMap((spy) =>
    spy.mock.calls.map((call: unknown[]) => String(call[0])),
  );
}

function poolLines(level?: 'info' | 'warn' | 'error'): string[] {
  return logged(level).filter((line) => line.startsWith('[pool] '));
}

function load(options: Partial<PoolStoreOptions> = {}) {
  return loadPool({ file, now: () => NOW, ...options });
}

function writeFile(content: unknown): string {
  const text =
    typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(file, text);
  return text;
}

function readFile(): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function files(): string[] {
  return fs.readdirSync(dir).sort();
}

function fsWith(overrides: Partial<PoolFs>): PoolFs {
  return { ...fs, ...overrides } as unknown as PoolFs;
}

function failWith(code: string) {
  return () => {
    throw Object.assign(new Error(`${code}: ${file}`), { code });
  };
}

function countingFs() {
  const writeFileSync = vi.fn(fs.writeFileSync);
  const renameSync = vi.fn(fs.renameSync);
  return {
    writeFileSync,
    renameSync,
    fs: fsWith({
      writeFileSync: writeFileSync as PoolFs['writeFileSync'],
      renameSync,
    }),
  };
}

function releasedOf(store: ReturnType<typeof load>): readonly SessionKey[] {
  return store.get().pool.released;
}

/**
 * assignments.json at this build's version: nothing released or locked,
 * 鎖定展示 off and no assignment, but for `fields`.
 */
function poolFile(fields: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3,
    released: [],
    locked: [],
    lockOn: false,
    assignments: [],
    ...fields,
  };
}

/** The store's `pool` section. */
function section(
  released: readonly SessionKey[],
  locked: readonly SessionKey[] = [],
  lockOn = false,
) {
  return { pool: { released, locked, lockOn } };
}

describe('loading assignments.json', () => {
  it('starts with nothing released, creating nothing, when there is no file', () => {
    const store = load();

    expect(store.get()).toStrictEqual(section([]));
    expect(store.canWrite).toBe(true);
    vi.runAllTimers();
    expect(files()).toStrictEqual([]);
    expect(poolLines()).toStrictEqual([
      '[pool] no assignments.json; nothing released',
    ]);
  });

  it('I/O matrix 啟動恢復: the released keys of a valid file are released from the start, sorted; the file is left as it was', () => {
    const text = writeFile(poolFile({ released: [B, A] }));

    const store = load();

    expect(releasedOf(store)).toStrictEqual([A, B]);
    expect(stagePoolSchema.safeParse(store.get().pool).success).toBe(true);
    vi.runAllTimers();
    expect(files()).toStrictEqual(['assignments.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(poolLines()).toStrictEqual([
      '[pool] loaded assignments.json: 2 released, 0 assignments, 0 locked',
    ]);
  });

  it('reads a key listed twice once', () => {
    writeFile(poolFile({ released: [A, A, DEMO] }));

    expect(releasedOf(load())).toStrictEqual([A, DEMO]);
  });

  it('reads a file saved with a UTF-8 BOM', () => {
    writeFile(
      String.fromCharCode(0xfeff) + JSON.stringify(poolFile({ released: [A] })),
    );

    const store = load();

    expect(releasedOf(store)).toStrictEqual([A]);
    expect(files()).toStrictEqual(['assignments.json']);
  });

  describe('I/O matrix 壞檔', () => {
    it.each([
      ['not JSON', '{"schemaVersion": 1, "released": [', 'not valid JSON'],
      ['empty', '', 'not valid JSON'],
      ['a JSON array', '[1]', 'not a JSON object'],
      ['JSON null', 'null', 'not a JSON object'],
      ['missing schemaVersion', '{"released": []}', 'schemaVersion is missing'],
      [
        'schemaVersion 0',
        '{"schemaVersion": 0, "released": []}',
        'schemaVersion is not a positive integer',
      ],
      [
        'a string schemaVersion',
        '{"schemaVersion": "1", "released": []}',
        'schemaVersion is not a positive integer',
      ],
      [
        'a newer schemaVersion',
        '{"schemaVersion": 4, "released": [], "assignments": []}',
        'schemaVersion 4 is newer than this build supports (3)',
      ],
      [
        'no released list',
        '{"schemaVersion": 1}',
        'does not match the schema (fields: released)',
      ],
      [
        'no assignments list (Story 3.4)',
        '{"schemaVersion": 2, "released": []}',
        'does not match the schema (fields: assignments)',
      ],
      [
        'assignments that are not a list (Story 3.4)',
        '{"schemaVersion": 2, "released": [], "assignments": {}}',
        'does not match the schema (fields: assignments)',
      ],
      [
        'no locked list (session bulk-lock)',
        '{"schemaVersion": 3, "released": [], "lockOn": false, "assignments": []}',
        'does not match the schema (fields: locked)',
      ],
      [
        'a lockOn that is not a boolean (session bulk-lock)',
        '{"schemaVersion": 3, "released": [], "locked": [], "lockOn": 1, "assignments": []}',
        'does not match the schema (fields: lockOn)',
      ],
      [
        'released keys that are not a list',
        '{"schemaVersion": 2, "released": "demo:1", "assignments": []}',
        'does not match the schema (fields: released)',
      ],
      [
        'an unknown field',
        '{"schemaVersion": 1, "released": [], "actors": {}}',
        'does not match the schema (fields: actors)',
      ],
    ])(
      'is renamed to .broken-<time> when it is %s, and nothing is released',
      (_label, text, reason) => {
        writeFile(text);

        const store = load();

        expect(store.get()).toStrictEqual(section([]));
        expect(store.canWrite).toBe(true);
        expect(files()).toStrictEqual([BACKUP]);
        expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe(text);
        expect(poolLines('error')).toStrictEqual([
          `[pool] assignments.json is unusable (${reason}); renamed it to ${BACKUP} and starting with nothing released`,
        ]);
      },
    );

    it('does not quote the file in the log', () => {
      writeFile(`{"schemaVersion": 1, "released": ["${A}", "vim:secret"]}`);

      load();

      const text = poolLines().join('\n');
      expect(text).not.toContain(A);
      expect(text).not.toContain('secret');
    });

    it('adds -2 when a backup from the same second exists', () => {
      fs.writeFileSync(path.join(dir, BACKUP), 'first');
      writeFile('not json');

      load();

      expect(files()).toStrictEqual([BACKUP, `${BACKUP}-2`]);
      expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe('first');
    });

    it('is written again once something is released', () => {
      writeFile('not json');
      const store = load();

      store.setReleased(A, true);
      vi.advanceTimersByTime(POOL_FLUSH_DEBOUNCE_MS);

      expect(files()).toStrictEqual(['assignments.json', BACKUP]);
      expect(readFile()).toStrictEqual(poolFile({ released: [A] }));
    });

    it('is left alone, and never written this run, when it cannot be renamed', () => {
      writeFile('not json');
      const store = load({ fs: fsWith({ renameSync: failWith('EPERM') }) });

      expect(store.canWrite).toBe(false);
      expect(poolLines('error')).toStrictEqual([
        '[pool] assignments.json is unusable (not valid JSON) and could not be renamed (EPERM); starting with nothing released and not writing assignments.json this run',
      ]);

      // Released for this run all the same.
      expect(store.setReleased(A, true)).toBe(true);
      vi.runAllTimers();
      store.flushSync();

      expect(releasedOf(store)).toStrictEqual([A]);
      expect(files()).toStrictEqual(['assignments.json']);
      expect(fs.readFileSync(file, 'utf8')).toBe('not json');
    });
  });

  it('starts with nothing released, and never writes this run, when the file cannot be read', () => {
    const text = writeFile(poolFile({ released: [A] }));
    const store = load({ fs: fsWith({ readFileSync: failWith('EACCES') }) });

    expect(store.get()).toStrictEqual(section([]));
    expect(store.canWrite).toBe(false);
    expect(poolLines('error')).toStrictEqual([
      '[pool] cannot read assignments.json (EACCES); starting with nothing released and not writing assignments.json this run',
    ]);

    store.setReleased(B, true);
    vi.runAllTimers();
    store.flushSync();

    expect(files()).toStrictEqual(['assignments.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  describe('migrations', () => {
    it('has two steps, 1 → 2 (Story 3.4): the released keys stay, with no assignment; 2 → 3 (session bulk-lock): nothing locked, 鎖定展示 off', () => {
      expect(Object.keys(POOL_MIGRATIONS)).toStrictEqual(['1', '2']);
      expect(Object.isFrozen(POOL_MIGRATIONS)).toBe(true);
      expect(
        POOL_MIGRATIONS[1]?.({ schemaVersion: 1, released: [A] }),
      ).toStrictEqual({ schemaVersion: 1, released: [A], assignments: [] });
      expect(
        POOL_MIGRATIONS[2]?.({
          schemaVersion: 2,
          released: [A],
          assignments: [],
        }),
      ).toStrictEqual({
        schemaVersion: 2,
        released: [A],
        assignments: [],
        locked: [],
        lockOn: false,
      });
    });

    it('runs each step up to the current version, then reads the result', () => {
      writeFile({
        schemaVersion: 3,
        hidden: [B, A],
        locked: [],
        lockOn: false,
        assignments: [],
      });

      const store = load({
        schemaVersion: 4,
        migrations: {
          3: ({ hidden, ...rest }) => ({ ...rest, released: hidden }),
        },
      });

      expect(releasedOf(store)).toStrictEqual([A, B]);
      expect(poolLines('info')).toContain(
        '[pool] migrated assignments.json from schemaVersion 3 to 4',
      );
      expect(files()).toStrictEqual(['assignments.json']);
    });

    it('treats the file as broken when a step is missing', () => {
      writeFile({ schemaVersion: 1, released: [A] });

      const store = load({ schemaVersion: 2, migrations: {} });

      expect(store.get()).toStrictEqual(section([]));
      expect(files()).toStrictEqual([BACKUP]);
      expect(poolLines('error')).toStrictEqual([
        `[pool] assignments.json is unusable (no migration from schemaVersion 1); renamed it to ${BACKUP} and starting with nothing released`,
      ]);
    });
  });
});

describe('releasing and showing again', () => {
  it('I/O matrix 釋放: the key joins the pool section, sorted; one change heard; logged by count only', () => {
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    expect(store.setReleased(B, true)).toBe(true);
    expect(store.setReleased(A, true)).toBe(true);

    expect(store.get()).toStrictEqual(section([A, B]));
    expect(onChange.mock.calls).toStrictEqual([
      [section([B])],
      [section([A, B])],
    ]);
    expect(poolLines('info').slice(-2)).toStrictEqual([
      '[pool] released a session (1 released)',
      '[pool] released a session (2 released)',
    ]);
    expect(poolLines().join('\n')).not.toMatch(/claude-code:|codex:/);
  });

  it('I/O matrix 改回顯示: the key leaves the pool section', () => {
    writeFile(poolFile({ released: [A, B] }));
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    expect(store.setReleased(A, false)).toBe(true);

    expect(store.get()).toStrictEqual(section([B]));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(section([B]));
    expect(poolLines('info').at(-1)).toBe(
      '[pool] showed a session again (1 released)',
    );
  });

  it('I/O matrix 沒有變化: releasing a released key, or showing a shown one, changes nothing: no change heard, nothing written', () => {
    writeFile(poolFile({ released: [A] }));
    const counting = countingFs();
    const store = load({ fs: counting.fs });
    const onChange = vi.fn();
    store.onChange(onChange);
    const before = store.get();

    expect(store.setReleased(A, true)).toBe(false);
    expect(store.setReleased(B, false)).toBe(false);
    vi.runAllTimers();
    store.flushSync();

    expect(store.get()).toBe(before);
    expect(onChange).not.toHaveBeenCalled();
    expect(counting.writeFileSync).not.toHaveBeenCalled();
  });

  it('a demo session can be released and is saved like any other', () => {
    const store = load();

    store.setReleased(DEMO, true);
    store.flushSync();

    expect(readFile()).toStrictEqual(poolFile({ released: [DEMO] }));
  });

  it('I/O matrix 壞輸入: throws on a key that fails the shared schema, changing nothing', () => {
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    for (const bad of ['vim:1', 'demo:', 'demo', 'demo:1\n', 42]) {
      expect(() =>
        store.setReleased(bad as unknown as SessionKey, true),
      ).toThrow();
    }

    expect(store.get()).toStrictEqual(section([]));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops calling a listener once unsubscribed, and survives one that throws', () => {
    const store = load();
    const throwing = vi.fn(() => {
      throw new Error('listener bug');
    });
    const later = vi.fn();
    const stop = store.onChange(throwing);
    store.onChange(later);

    store.setReleased(A, true);
    stop();
    store.setReleased(B, true);

    expect(throwing).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledTimes(2);
    expect(poolLines('error')).toStrictEqual([
      '[pool] a change listener failed (Error)',
    ]);
  });
});

describe('writing assignments.json', () => {
  it(`I/O matrix 合併寫入: writes once, ${POOL_FLUSH_DEBOUNCE_MS} ms after the first unsaved change, with the last state`, () => {
    const counting = countingFs();
    const store = load({ fs: counting.fs });

    store.setReleased(A, true);
    vi.advanceTimersByTime(POOL_FLUSH_DEBOUNCE_MS - 100);
    store.setReleased(B, true);
    store.setReleased(A, false);
    vi.advanceTimersByTime(99);
    store.setReleased(DEMO, true);
    expect(files()).toStrictEqual([]);

    vi.advanceTimersByTime(1);

    expect(counting.writeFileSync).toHaveBeenCalledOnce();
    expect(counting.writeFileSync.mock.calls[0]?.[0]).toBe(`${file}.tmp`);
    expect(counting.writeFileSync.mock.calls[0]?.[2]).toStrictEqual({
      encoding: 'utf8',
      flush: true,
    });
    expect(counting.renameSync).toHaveBeenCalledExactlyOnceWith(
      `${file}.tmp`,
      file,
    );
    const written = readFile();
    expect(written).toStrictEqual(poolFile({ released: [B, DEMO] }));
    expect(poolFileSchema.safeParse(written).success).toBe(true);
    expect(files()).toStrictEqual(['assignments.json']);

    vi.runAllTimers();
    expect(counting.writeFileSync).toHaveBeenCalledOnce();
  });

  it('starts a new window for the next change after a write', () => {
    const counting = countingFs();
    const store = load({ fs: counting.fs });

    store.setReleased(A, true);
    vi.advanceTimersByTime(POOL_FLUSH_DEBOUNCE_MS);
    store.setReleased(A, false);
    vi.advanceTimersByTime(POOL_FLUSH_DEBOUNCE_MS);

    expect(counting.writeFileSync).toHaveBeenCalledTimes(2);
    expect(readFile()).toStrictEqual(poolFile());
  });

  it('I/O matrix 寫入失敗: a failed rename is logged, its temp file removed, the keys kept in memory; the next flush writes them', () => {
    let failures = 1;
    const store = load({
      fs: fsWith({
        renameSync: (from: string, to: string) => {
          if (failures > 0) {
            failures -= 1;
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
          }
          fs.renameSync(from, to);
        },
      }),
    });

    store.setReleased(A, true);
    vi.advanceTimersByTime(POOL_FLUSH_DEBOUNCE_MS);

    expect(files()).toStrictEqual([]);
    expect(releasedOf(store)).toStrictEqual([A]);
    expect(poolLines('error')).toStrictEqual([
      '[pool] cannot write assignments.json (EBUSY); keeping the released and locked sessions in memory and retrying on the next flush',
    ]);

    store.flushSync();

    expect(files()).toStrictEqual(['assignments.json']);
    expect(readFile()).toStrictEqual(poolFile({ released: [A] }));
  });

  it('flushSync only logs when the write fails', () => {
    const store = load({ fs: fsWith({ writeFileSync: failWith('EROFS') }) });
    store.setReleased(A, true);

    expect(() => store.flushSync()).not.toThrow();

    expect(files()).toStrictEqual([]);
    expect(poolLines('error')).toStrictEqual([
      '[pool] cannot write assignments.json (EROFS); keeping the released and locked sessions in memory and retrying on the next flush',
    ]);
  });

  it('flushSync writes nothing when nothing is pending', () => {
    const counting = countingFs();
    const store = load({ fs: counting.fs });

    store.flushSync();

    expect(counting.writeFileSync).not.toHaveBeenCalled();
  });

  it('I/O matrix 結束: a change just before quitting is written on will-quit, without waiting for the debounce', () => {
    const app = new EventEmitter();
    const store = load();
    flushOnQuit(app, store);
    store.setReleased(A, true);
    expect(files()).toStrictEqual([]);

    app.emit('will-quit');

    expect(readFile()).toStrictEqual(poolFile({ released: [A] }));
    vi.runAllTimers();
    expect(files()).toStrictEqual(['assignments.json']);
  });
});

describe('the start-up sweep', () => {
  it('I/O matrix 啟動清理: keeps the released keys reported since start, drops the rest from memory and the file; logged by count', () => {
    writeFile(poolFile({ released: [A, B] }));
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    store.sweep(new Set([A, DEMO]), new Set());

    expect(store.get()).toStrictEqual(section([A]));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(section([A]));
    expect(poolLines('info').at(-1)).toBe(
      '[pool] start-up sweep: kept 1, dropped 1 (2 sessions reported)',
    );
    vi.advanceTimersByTime(POOL_FLUSH_DEBOUNCE_MS);
    expect(readFile()).toStrictEqual(poolFile({ released: [A] }));
  });

  it('changes nothing, and writes nothing, when every released key was reported', () => {
    writeFile(poolFile({ released: [A] }));
    const counting = countingFs();
    const store = load({ fs: counting.fs });
    const onChange = vi.fn();
    store.onChange(onChange);

    store.sweep(new Set([A]), new Set());
    vi.runAllTimers();

    expect(releasedOf(store)).toStrictEqual([A]);
    expect(onChange).not.toHaveBeenCalled();
    expect(counting.writeFileSync).not.toHaveBeenCalled();
  });

  it('runs once: a later sweep does nothing', () => {
    writeFile(poolFile({ released: [A, B] }));
    const store = load();

    store.sweep(new Set([A, B]), new Set());
    store.sweep(new Set(), new Set());

    expect(releasedOf(store)).toStrictEqual([A, B]);
  });

  it('a demo session released last run is dropped: demo mode is off at start, so it is not reported', () => {
    writeFile(poolFile({ released: [A, DEMO] }));
    const store = load();

    store.sweep(new Set([A]), new Set());
    store.flushSync();

    expect(readFile()).toStrictEqual(poolFile({ released: [A] }));
  });

  it('keeps every released key of an unconfirmed source, reported or not; logs counts and source codes only', () => {
    const C: SessionKey = 'cursor:00000000-0000-4000-8000-00000000000c';
    const D: SessionKey = 'cursor:00000000-0000-4000-8000-00000000000d';
    writeFile(poolFile({ released: [A, B, C, D, DEMO] }));
    const store = load();

    store.sweep(new Set([A, C]), new Set(['cursor']));

    expect(releasedOf(store)).toStrictEqual([A, C, D]);
    expect(poolLines('info').at(-1)).toBe(
      '[pool] start-up sweep: kept 3, dropped 2 (2 sessions reported; 1 kept unreported from unconfirmed sources: cursor)',
    );
    expect(poolLines().join('\n')).not.toMatch(/0000000/);
  });

  it('with no unconfirmed source the log line reads as before', () => {
    writeFile(poolFile({ released: [A] }));
    const store = load();

    store.sweep(new Set(), new Set());

    expect(poolLines('info').at(-1)).toBe(
      '[pool] start-up sweep: kept 0, dropped 1 (0 sessions reported)',
    );
  });
});

describe('with main/detection, as main.ts wires them', () => {
  const MINUTE = 60_000;

  function settings() {
    const state = { rev: 0, values: { ...SETTINGS_DEFAULTS } };
    return { get: () => state, onChange: () => () => {} };
  }

  function codexEvent(
    nativeId: string,
    type: DetectionEvent['type'],
    ts: number,
    replay = false,
  ): DetectionEvent {
    return detectionEventSchema.parse({
      type,
      source: 'codex',
      sessionKey: `codex:${nativeId}`,
      ts,
      via: 'log',
      confidence: confidenceFor('log'),
      ...(replay ? { replay: true } : {}),
    });
  }

  function wire() {
    const clock = fakeClock();
    let context: AdapterContext | undefined;
    const detection = createDetection({
      settings: settings(),
      monotonic: clock.monotonic,
      wall: clock.wall,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      adapters: [
        {
          source: 'codex',
          start(given) {
            context = given;
          },
          stop() {},
        },
      ],
    });
    const store = load();
    detection.onSynced((reported, unconfirmed) => {
      store.sweep(reported, unconfirmed);
    });
    const emit: AdapterContext['emit'] = (outputs, health) => {
      context?.emit(outputs, health);
    };
    return { clock, detection, store, emit };
  }

  it('I/O matrix 啟動恢復 + 啟動清理: A, replayed at start, is released as soon as it shows; B, not reported, is swept at sync', () => {
    const a = 'codex:a' as const;
    const b = 'codex:b' as const;
    writeFile(poolFile({ released: [a, b] }));
    const { clock, detection, store, emit } = wire();

    emit([codexEvent('a', 'session.start', clock.wall() - MINUTE, true)]);
    expect(releasedOf(store)).toStrictEqual([a, b]);

    emit([{ type: 'sync.ready', source: 'codex' }], 'ok');

    expect(detection.get().sessions.map((s) => s.sessionKey)).toStrictEqual([
      a,
    ]);
    expect(releasedOf(store)).toStrictEqual([a]);
    store.flushSync();
    expect(readFile()).toStrictEqual(poolFile({ released: [a] }));
  });

  it(`I/O matrix 同步逾時: an adapter that never sends sync.ready gets the sweep at syncTimeoutMs (${SETTINGS_DEFAULTS.syncTimeoutMs} ms), which keeps its source's releases (Epic 2 close-out B1)`, () => {
    writeFile(poolFile({ released: ['codex:a', 'codex:b'] }));
    const { clock, store, emit } = wire();
    emit([codexEvent('b', 'session.start', clock.wall(), true)], 'ok');

    clock.advance(SETTINGS_DEFAULTS.syncTimeoutMs - 1);
    expect(releasedOf(store)).toStrictEqual(['codex:a', 'codex:b']);
    expect(poolLines('info').at(-1)).not.toMatch(/start-up sweep/);
    clock.advance(1);

    expect(releasedOf(store)).toStrictEqual(['codex:a', 'codex:b']);
    expect(poolLines('info').at(-1)).toBe(
      '[pool] start-up sweep: kept 2, dropped 0 (1 sessions reported; 1 kept unreported from unconfirmed sources: codex)',
    );
  });

  it('I/O matrix 執行中回來: a released session that ends and comes back with the same key is still released', () => {
    const { clock, detection, store, emit } = wire();
    emit([{ type: 'sync.ready', source: 'codex' }], 'ok');
    emit([codexEvent('a', 'session.start', clock.wall())]);
    store.setReleased('codex:a', true);

    emit([codexEvent('a', 'session.end', clock.wall())]);
    expect(detection.get().sessions).toStrictEqual([]);
    expect(releasedOf(store)).toStrictEqual(['codex:a']);

    emit([codexEvent('a', 'session.start', clock.wall())]);

    expect(detection.get().sessions.map((s) => s.sessionKey)).toStrictEqual([
      'codex:a',
    ]);
    expect(releasedOf(store)).toStrictEqual(['codex:a']);
  });

  it('a released session is still detected: its state goes on changing', () => {
    const { clock, detection, store, emit } = wire();
    emit([{ type: 'sync.ready', source: 'codex' }], 'ok');
    emit([codexEvent('a', 'session.start', clock.wall())]);
    store.setReleased('codex:a', true);

    emit([codexEvent('a', 'turn.start', clock.wall())]);

    expect(detection.get().sessions.map((s) => s.state)).toStrictEqual([
      'thinking',
    ]);
  });
});

describe('I/O matrix', () => {
  const CLAUDE_A: SessionKey = 'claude-code:a';
  const CLAUDE_B: SessionKey = 'claude-code:b';
  const CURSOR_C: SessionKey = 'cursor:c';
  const CURSOR_D: SessionKey = 'cursor:d';

  function settings() {
    const state = { rev: 0, values: { ...SETTINGS_DEFAULTS } };
    return { get: () => state, onChange: () => () => {} };
  }

  function replayed(sessionKey: SessionKey, ts: number): DetectionEvent {
    return detectionEventSchema.parse({
      type: 'session.start',
      source: splitSessionKey(sessionKey).source,
      sessionKey,
      ts,
      via: 'log',
      confidence: confidenceFor('log'),
      replay: true,
    });
  }

  /**
   * main/detection with a Claude Code and a Cursor adapter (Cursor's start
   * throws when `cursorFails`), its sync wired to the store as main.ts does.
   */
  function wire({ cursorFails = false } = {}) {
    writeFile(poolFile({ released: [CLAUDE_A, CLAUDE_B, CURSOR_C, CURSOR_D] }));
    const clock = fakeClock();
    const contexts = new Map<SourceCode, AdapterContext>();
    const detection = createDetection({
      settings: settings(),
      monotonic: clock.monotonic,
      wall: clock.wall,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      adapters: (['claude-code', 'cursor'] as const).map((source) => ({
        source,
        start(given: AdapterContext) {
          if (source === 'cursor' && cursorFails) {
            throw Object.assign(new Error('x'), { code: 'EBROKEN' });
          }
          contexts.set(source, given);
        },
        stop() {},
      })),
    });
    const store = load();
    detection.onSynced((reported, unconfirmed) => {
      store.sweep(reported, unconfirmed);
    });
    const ctx = (source: SourceCode): AdapterContext => {
      const context = contexts.get(source);
      if (context === undefined) {
        throw new Error(`${source} did not start`);
      }
      return context;
    };
    return { clock, detection, store, ctx };
  }

  it('全部同步: every adapter sent sync.ready: only the reported releases are kept, as before', () => {
    const { clock, store, ctx } = wire();
    ctx('claude-code').emit([
      replayed(CLAUDE_A, clock.wall()),
      { type: 'sync.ready', source: 'claude-code' },
    ]);
    ctx('cursor').emit([
      replayed(CURSOR_C, clock.wall()),
      { type: 'sync.ready', source: 'cursor' },
    ]);

    expect(releasedOf(store)).toStrictEqual([CLAUDE_A, CURSOR_C]);
    expect(poolLines('info').at(-1)).toBe(
      '[pool] start-up sweep: kept 2, dropped 2 (2 sessions reported)',
    );
  });

  it(`同步逾時: cursor has not sent sync.ready at syncTimeoutMs (${SETTINGS_DEFAULTS.syncTimeoutMs} ms): every cursor release is kept, the other sources are swept as before, and the log names cursor`, () => {
    const { clock, store, ctx } = wire();
    ctx('claude-code').emit([
      replayed(CLAUDE_A, clock.wall()),
      { type: 'sync.ready', source: 'claude-code' },
    ]);
    ctx('cursor').emit([replayed(CURSOR_C, clock.wall())], 'ok');

    clock.advance(SETTINGS_DEFAULTS.syncTimeoutMs);

    expect(releasedOf(store)).toStrictEqual([CLAUDE_A, CURSOR_C, CURSOR_D]);
    expect(poolLines('info').at(-1)).toBe(
      '[pool] start-up sweep: kept 3, dropped 1 (2 sessions reported; 1 kept unreported from unconfirmed sources: cursor)',
    );
  });

  it('啟動失敗: cursor’s start() throws: the sweep comes once Claude Code is ready, not at the deadline; every cursor release is kept; cursor’s health is degraded', () => {
    const { clock, detection, store, ctx } = wire({ cursorFails: true });

    ctx('claude-code').emit(
      [
        replayed(CLAUDE_A, clock.wall()),
        { type: 'sync.ready', source: 'claude-code' },
      ],
      'ok',
    );

    expect(releasedOf(store)).toStrictEqual([CLAUDE_A, CURSOR_C, CURSOR_D]);
    expect(poolLines('info').at(-1)).toBe(
      '[pool] start-up sweep: kept 3, dropped 1 (1 sessions reported; 2 kept unreported from unconfirmed sources: cursor)',
    );
    expect(
      detection.get().adapters.find((adapter) => adapter.source === 'cursor')
        ?.health,
    ).toBe('degraded');
  });
});

describe('I/O matrix', () => {
  const ASSIGNED_A = {
    sessionKey: A,
    actorId: 'actor-a',
    characterKey: 'sample-pack/probe-one',
  };
  const ASSIGNED_DEMO = {
    sessionKey: DEMO,
    actorId: 'actor-demo',
    characterKey: 'sample-pack/probe-two',
  };

  it('舊檔: a version-1 file is migrated to 3: its released keys kept, no assignment, nothing locked; the next write is version 3', () => {
    const text = writeFile({ schemaVersion: 1, released: [B, A] });

    const store = load();

    expect(releasedOf(store)).toStrictEqual([A, B]);
    expect(store.assignments()).toStrictEqual([]);
    expect(poolLines('info')).toStrictEqual([
      '[pool] migrated assignments.json from schemaVersion 1 to 3',
      '[pool] loaded assignments.json: 2 released, 0 assignments, 0 locked',
    ]);
    vi.runAllTimers();
    // Migrating alone writes nothing, and nothing is backed up.
    expect(files()).toStrictEqual(['assignments.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);

    store.setReleased(DEMO, true);
    store.flushSync();

    const written = readFile();
    expect(written).toStrictEqual(poolFile({ released: [A, B, DEMO] }));
    expect(poolFileSchema.safeParse(written).success).toBe(true);
  });

  it('壞資料: a bad released key is dropped, the rest kept; the original is copied to .broken-, the corrected file written back at once; counts only in the log', () => {
    const text = writeFile(
      `{"schemaVersion": 3, "released": ["${A}", "vim:secret", 7], "locked": [], "lockOn": false, "assignments": [${JSON.stringify(ASSIGNED_DEMO)}]}`,
    );

    const store = load();

    expect(releasedOf(store)).toStrictEqual([A]);
    expect(store.assignments()).toStrictEqual([ASSIGNED_DEMO]);
    expect(store.canWrite).toBe(true);
    expect(files()).toStrictEqual(['assignments.json', BACKUP]);
    expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe(text);
    expect(readFile()).toStrictEqual(
      poolFile({ released: [A], assignments: [ASSIGNED_DEMO] }),
    );
    expect(poolLines('warn')).toStrictEqual([
      `[pool] assignments.json has bad entries (2 released, 0 assignments, 0 locked); copied it to ${BACKUP} and dropping them: 1 released, 1 assignment, 0 locked kept`,
    ]);
    const lines = poolLines().join('\n');
    expect(lines).not.toContain('secret');
    expect(lines).not.toContain(A);
  });

  it('壞資料: 鎖定展示 on with only bad locked keys reads as off; the original is copied to .broken-, the corrected file written back with it off', () => {
    const text = writeFile(
      '{"schemaVersion": 3, "released": [], "locked": ["vim:1"], "lockOn": true, "assignments": []}',
    );

    const store = load();

    expect(store.get()).toStrictEqual(section([]));
    expect(files()).toStrictEqual(['assignments.json', BACKUP]);
    expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe(text);
    expect(readFile()).toStrictEqual(poolFile());
    expect(poolLines('warn')).toStrictEqual([
      `[pool] assignments.json has bad entries (0 released, 0 assignments, 1 locked); copied it to ${BACKUP} and dropping them: 0 released, 0 assignments, 0 locked kept`,
    ]);
  });

  it.each<[string, unknown]>([
    ['an unknown source', { ...ASSIGNED_DEMO, sessionKey: 'vim:1' }],
    ['the actor id __proto__', { ...ASSIGNED_DEMO, actorId: '__proto__' }],
    ['an empty actor id', { ...ASSIGNED_DEMO, actorId: '' }],
    ['a character key with no pack', { ...ASSIGNED_DEMO, characterKey: 'x' }],
    ['no character key', { sessionKey: DEMO, actorId: 'actor-demo' }],
    ['an extra field', { ...ASSIGNED_DEMO, state: 'idle' }],
    ['a session key named before', { ...ASSIGNED_A, actorId: 'actor-2' }],
    ['an actor id named before', { ...ASSIGNED_DEMO, actorId: 'actor-a' }],
    ['not an object', 'actor-a'],
  ])(
    '壞資料: an assignment with %s is dropped, the others kept (the first of a repeat wins)',
    (_label, bad) => {
      writeFile(poolFile({ released: [B], assignments: [ASSIGNED_A, bad] }));

      const store = load();

      expect(releasedOf(store)).toStrictEqual([B]);
      expect(store.assignments()).toStrictEqual([ASSIGNED_A]);
      expect(files()).toStrictEqual(['assignments.json', BACKUP]);
      expect(readFile()).toStrictEqual(
        poolFile({ released: [B], assignments: [ASSIGNED_A] }),
      );
      expect(poolLines('warn')).toStrictEqual([
        `[pool] assignments.json has bad entries (0 released, 1 assignment, 0 locked); copied it to ${BACKUP} and dropping them: 1 released, 1 assignment, 0 locked kept`,
      ]);
    },
  );

  it('壞資料: when the original cannot be backed up, the good entries are kept and nothing is written this run', () => {
    const text = writeFile(
      poolFile({ released: [A, 'vim:1'], assignments: [ASSIGNED_DEMO] }),
    );
    const store = load({ fs: fsWith({ copyFileSync: failWith('EACCES') }) });

    expect(store.canWrite).toBe(false);
    expect(releasedOf(store)).toStrictEqual([A]);
    expect(store.assignments()).toStrictEqual([ASSIGNED_DEMO]);
    expect(poolLines('error')).toStrictEqual([
      '[pool] assignments.json has bad entries (1 released, 0 assignments, 0 locked) and could not be backed up (EACCES); dropping them and not writing assignments.json this run',
    ]);

    store.setReleased(B, true);
    vi.runAllTimers();
    store.flushSync();

    expect(files()).toStrictEqual(['assignments.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });
});

describe('the saved assignments (Story 3.4)', () => {
  const ONE = {
    sessionKey: 'codex:b',
    actorId: 'actor-1',
    characterKey: 'sample-pack/probe-one',
  } as const;
  const TWO = {
    sessionKey: 'claude-code:a',
    actorId: 'actor-2',
    characterKey: 'sample-pack/probe-one',
  } as const;

  it('reads them from the file, sorted by session key, with the released keys', () => {
    writeFile(poolFile({ released: [DEMO], assignments: [ONE, TWO] }));

    const store = load();

    expect(store.assignments()).toStrictEqual([TWO, ONE]);
    expect(releasedOf(store)).toStrictEqual([DEMO]);
    expect(poolLines()).toStrictEqual([
      '[pool] loaded assignments.json: 1 released, 2 assignments, 0 locked',
    ]);
  });

  it('starts with none when there is no file', () => {
    expect(load().assignments()).toStrictEqual([]);
  });

  it('setAssignments takes them sorted and writes them with the released keys after the debounce; nobody is told', () => {
    const counting = countingFs();
    const store = load({ fs: counting.fs });
    const onChange = vi.fn();
    store.onChange(onChange);
    store.setReleased(DEMO, true);
    onChange.mockClear();

    expect(store.setAssignments([ONE, TWO])).toBe(true);

    expect(store.assignments()).toStrictEqual([TWO, ONE]);
    expect(onChange).not.toHaveBeenCalled();
    expect(files()).toStrictEqual([]);
    vi.advanceTimersByTime(POOL_FLUSH_DEBOUNCE_MS);
    expect(counting.writeFileSync).toHaveBeenCalledOnce();
    const written = readFile();
    expect(written).toStrictEqual(
      poolFile({ released: [DEMO], assignments: [TWO, ONE] }),
    );
    expect(poolFileSchema.safeParse(written).success).toBe(true);
  });

  it('setAssignments with the same assignments, in any order, changes nothing and writes nothing', () => {
    writeFile(poolFile({ assignments: [ONE, TWO] }));
    const counting = countingFs();
    const store = load({ fs: counting.fs });
    const before = store.assignments();

    expect(store.setAssignments([ONE, TWO])).toBe(false);
    vi.runAllTimers();
    store.flushSync();

    expect(store.assignments()).toBe(before);
    expect(counting.writeFileSync).not.toHaveBeenCalled();
  });

  it('setAssignments throws, changing nothing, on assignments that fail the file schema', () => {
    const store = load();
    store.setAssignments([ONE]);

    for (const bad of [
      [ONE, { ...TWO, sessionKey: ONE.sessionKey }],
      [ONE, { ...TWO, actorId: ONE.actorId }],
      [{ ...ONE, actorId: '__proto__' }],
      [{ ...ONE, characterKey: 'probe-one' }],
    ]) {
      expect(() =>
        store.setAssignments(bad as unknown as (typeof ONE)[]),
      ).toThrow();
    }

    expect(store.assignments()).toStrictEqual([ONE]);
  });

  it('the assignments handed it are frozen copies: a later change to the list given does not reach them', () => {
    const store = load();
    const given = [{ ...ONE }];

    store.setAssignments(given);
    (given[0] as { actorId: string }).actorId = 'changed';

    expect(store.assignments()).toStrictEqual([ONE]);
    expect(Object.isFrozen(store.assignments())).toBe(true);
    expect(Object.isFrozen(store.assignments()[0])).toBe(true);
  });

  it('a failed write keeps them in memory; the next flush writes them', () => {
    let failures = 1;
    const store = load({
      fs: fsWith({
        renameSync: (from: string, to: string) => {
          if (failures > 0) {
            failures -= 1;
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
          }
          fs.renameSync(from, to);
        },
      }),
    });

    store.setAssignments([ONE]);
    vi.advanceTimersByTime(POOL_FLUSH_DEBOUNCE_MS);
    expect(files()).toStrictEqual([]);

    store.flushSync();

    expect(readFile()).toStrictEqual(poolFile({ assignments: [ONE] }));
  });
});

describe('I/O matrix', () => {
  // Session bulk-lock: 全部釋放 / 全部顯示, 鎖定 and 鎖定展示.
  const C: SessionKey = 'cursor:00000000-0000-4000-8000-00000000000c';

  it('全部釋放: setReleasedMany releases every key given as one change, written once; logged by count only', () => {
    writeFile(poolFile({ released: [B] }));
    const counting = countingFs();
    const store = load({ fs: counting.fs });
    const onChange = vi.fn();
    store.onChange(onChange);

    expect(store.setReleasedMany([DEMO, A, B, A], true)).toBe(true);

    expect(store.get()).toStrictEqual(section([A, B, DEMO]));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(section([A, B, DEMO]));
    vi.runAllTimers();
    expect(counting.writeFileSync).toHaveBeenCalledOnce();
    expect(readFile()).toStrictEqual(poolFile({ released: [A, B, DEMO] }));
    expect(poolLines('info').at(-1)).toBe(
      '[pool] released 2 sessions at once (3 released)',
    );
    expect(poolLines().join('\n')).not.toMatch(/claude-code:|codex:|demo:/);
  });

  it('全部顯示: setReleasedMany(false) shows every key given again as one change; again, it changes nothing', () => {
    writeFile(poolFile({ released: [A, B, DEMO] }));
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    expect(store.setReleasedMany([A, DEMO], false)).toBe(true);
    expect(store.setReleasedMany([A, DEMO], false)).toBe(false);

    expect(store.get()).toStrictEqual(section([B]));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(section([B]));
    expect(poolLines('info').at(-1)).toBe(
      '[pool] showed 2 sessions again at once (1 released)',
    );
  });

  it('打開鎖定: keys are locked and unlocked at any time, 鎖定展示 goes on with a locked key; written, and read back at the next start', () => {
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    expect(store.setLocked(B, true)).toBe(true);
    expect(store.setLocked(A, true)).toBe(true);
    expect(store.setLocked(A, true)).toBe(false);
    expect(store.setLockOn(true)).toBe(true);
    expect(store.setLocked(B, false)).toBe(true);

    expect(store.get()).toStrictEqual(section([], [A], true));
    expect(stagePoolSchema.safeParse(store.get().pool).success).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(poolLines('info').slice(-4)).toStrictEqual([
      '[pool] locked a session (1 locked)',
      '[pool] locked a session (2 locked)',
      '[pool] lock turned on (2 locked)',
      '[pool] unlocked a session (1 locked, lock on)',
    ]);
    store.flushSync();
    expect(readFile()).toStrictEqual(poolFile({ locked: [A], lockOn: true }));
    expect(load().get()).toStrictEqual(section([], [A], true));
  });

  it('取消最後一勾: unlocking the last locked key turns 鎖定展示 off in the same change', () => {
    writeFile(poolFile({ locked: [A], lockOn: true }));
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);
    expect(store.get()).toStrictEqual(section([], [A], true));

    expect(store.setLocked(A, false)).toBe(true);

    expect(onChange).toHaveBeenCalledExactlyOnceWith(section([]));
    expect(poolLines('info').at(-1)).toBe(
      '[pool] unlocked a session (0 locked; lock turned off: nothing locked)',
    );
  });

  it('重啟: the start-up sweep drops a locked key not reported, keeps one of an unconfirmed source; 鎖定展示 stays on while one is left', () => {
    writeFile(poolFile({ locked: [A, B, C], lockOn: true }));
    const store = load();

    store.sweep(new Set([B]), new Set(['cursor']));

    expect(store.get()).toStrictEqual(section([], [B, C], true));
  });

  it('重啟: with no locked key left after the sweep, 鎖定展示 goes off in the same change; counts only in the log', () => {
    writeFile(poolFile({ released: [B], locked: [A], lockOn: true }));
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);
    expect(store.get()).toStrictEqual(section([B], [A], true));

    store.sweep(new Set([B]), new Set());

    expect(onChange).toHaveBeenCalledExactlyOnceWith(section([B]));
    expect(poolLines('info').at(-1)).toBe(
      '[pool] start-up sweep: kept 1, dropped 0 (1 sessions reported); locked: kept 0, dropped 1, lock turned off: nothing locked',
    );
    store.flushSync();
    expect(readFile()).toStrictEqual(poolFile({ released: [B] }));
  });

  it('舊檔: a version-2 file is migrated to 3: its released keys and assignments kept, nothing locked, 鎖定展示 off; the next write is version 3', () => {
    const assigned = {
      sessionKey: A,
      actorId: 'actor-a',
      characterKey: 'sample-pack/probe-one',
    };
    writeFile({ schemaVersion: 2, released: [B], assignments: [assigned] });

    const store = load();

    expect(store.get()).toStrictEqual(section([B]));
    expect(store.assignments()).toStrictEqual([assigned]);
    expect(poolLines('info')).toStrictEqual([
      '[pool] migrated assignments.json from schemaVersion 2 to 3',
      '[pool] loaded assignments.json: 1 released, 1 assignment, 0 locked',
    ]);
    store.setLocked(A, true);
    store.flushSync();
    const written = readFile();
    expect(written).toStrictEqual(
      poolFile({ released: [B], locked: [A], assignments: [assigned] }),
    );
    expect(poolFileSchema.safeParse(written).success).toBe(true);
  });

  it('壞輸入: a bad key, no key or too many keys throws; 鎖定展示 does not go on with nothing locked; nothing changes or is written', () => {
    const counting = countingFs();
    const store = load({ fs: counting.fs });
    const onChange = vi.fn();
    store.onChange(onChange);
    const tooMany = Array.from(
      { length: POOL_SET_RELEASED_MANY_MAX_KEYS + 1 },
      (_, i): SessionKey => `demo:${i}`,
    );

    for (const bad of [[A, 'vim:1'], [], tooMany]) {
      expect(() => store.setReleasedMany(bad as SessionKey[], true)).toThrow();
    }
    expect(() =>
      store.setLocked('vim:1' as unknown as SessionKey, true),
    ).toThrow();
    expect(store.setLockOn(true)).toBe(false);
    vi.runAllTimers();

    expect(store.get()).toStrictEqual(section([]));
    expect(onChange).not.toHaveBeenCalled();
    expect(counting.writeFileSync).not.toHaveBeenCalled();
    expect(poolLines('warn')).toStrictEqual([
      '[pool] lock not turned on: nothing locked',
    ]);
  });
});
