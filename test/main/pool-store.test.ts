/**
 * main/pool (Story 2.8): assignments.json, the released keys, the start-up
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
import { poolFileSchema, stagePoolSchema } from '../../src/shared/pool';
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

describe('loading assignments.json', () => {
  it('starts with nothing released, creating nothing, when there is no file', () => {
    const store = load();

    expect(store.get()).toStrictEqual({ pool: { released: [] } });
    expect(store.canWrite).toBe(true);
    vi.runAllTimers();
    expect(files()).toStrictEqual([]);
    expect(poolLines()).toStrictEqual([
      '[pool] no assignments.json; nothing released',
    ]);
  });

  it('I/O matrix 啟動恢復: the released keys of a valid file are released from the start, sorted; the file is left as it was', () => {
    const text = writeFile({ schemaVersion: 1, released: [B, A] });

    const store = load();

    expect(releasedOf(store)).toStrictEqual([A, B]);
    expect(stagePoolSchema.safeParse(store.get().pool).success).toBe(true);
    vi.runAllTimers();
    expect(files()).toStrictEqual(['assignments.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(poolLines()).toStrictEqual([
      '[pool] loaded assignments.json: 2 released',
    ]);
  });

  it('reads a key listed twice once', () => {
    writeFile({ schemaVersion: 1, released: [A, A, DEMO] });

    expect(releasedOf(load())).toStrictEqual([A, DEMO]);
  });

  it('reads a file saved with a UTF-8 BOM', () => {
    writeFile(
      String.fromCharCode(0xfeff) +
        JSON.stringify({ schemaVersion: 1, released: [A] }),
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
        '{"schemaVersion": 2, "released": []}',
        'schemaVersion 2 is newer than this build supports (1)',
      ],
      [
        'no released list',
        '{"schemaVersion": 1}',
        'does not match the schema (fields: released)',
      ],
      [
        'a key of an unknown source',
        '{"schemaVersion": 1, "released": ["demo:1", "vim:1"]}',
        'does not match the schema (fields: released.1)',
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

        expect(store.get()).toStrictEqual({ pool: { released: [] } });
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
      expect(readFile()).toStrictEqual({ schemaVersion: 1, released: [A] });
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
    const text = writeFile({ schemaVersion: 1, released: [A] });
    const store = load({ fs: fsWith({ readFileSync: failWith('EACCES') }) });

    expect(store.get()).toStrictEqual({ pool: { released: [] } });
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
    it('has none while the file is at version 1', () => {
      expect(POOL_MIGRATIONS).toStrictEqual({});
      expect(Object.isFrozen(POOL_MIGRATIONS)).toBe(true);
    });

    it('runs each step up to the current version, then reads the result', () => {
      writeFile({ schemaVersion: 1, hidden: [B, A] });

      const store = load({
        schemaVersion: 2,
        migrations: {
          1: ({ hidden, ...rest }) => ({ ...rest, released: hidden }),
        },
      });

      expect(releasedOf(store)).toStrictEqual([A, B]);
      expect(poolLines('info')).toContain(
        '[pool] migrated assignments.json from schemaVersion 1 to 2',
      );
      expect(files()).toStrictEqual(['assignments.json']);
    });

    it('treats the file as broken when a step is missing', () => {
      writeFile({ schemaVersion: 1, released: [A] });

      const store = load({ schemaVersion: 2, migrations: {} });

      expect(store.get()).toStrictEqual({ pool: { released: [] } });
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

    expect(store.get()).toStrictEqual({ pool: { released: [A, B] } });
    expect(onChange.mock.calls).toStrictEqual([
      [{ pool: { released: [B] } }],
      [{ pool: { released: [A, B] } }],
    ]);
    expect(poolLines('info').slice(-2)).toStrictEqual([
      '[pool] released a session (1 released)',
      '[pool] released a session (2 released)',
    ]);
    expect(poolLines().join('\n')).not.toMatch(/claude-code:|codex:/);
  });

  it('I/O matrix 改回顯示: the key leaves the pool section', () => {
    writeFile({ schemaVersion: 1, released: [A, B] });
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    expect(store.setReleased(A, false)).toBe(true);

    expect(store.get()).toStrictEqual({ pool: { released: [B] } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      pool: { released: [B] },
    });
    expect(poolLines('info').at(-1)).toBe(
      '[pool] showed a session again (1 released)',
    );
  });

  it('I/O matrix 沒有變化: releasing a released key, or showing a shown one, changes nothing: no change heard, nothing written', () => {
    writeFile({ schemaVersion: 1, released: [A] });
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

    expect(readFile()).toStrictEqual({ schemaVersion: 1, released: [DEMO] });
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

    expect(store.get()).toStrictEqual({ pool: { released: [] } });
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
    expect(written).toStrictEqual({ schemaVersion: 1, released: [B, DEMO] });
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
    expect(readFile()).toStrictEqual({ schemaVersion: 1, released: [] });
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
      '[pool] cannot write assignments.json (EBUSY); keeping the released sessions in memory and retrying on the next flush',
    ]);

    store.flushSync();

    expect(files()).toStrictEqual(['assignments.json']);
    expect(readFile()).toStrictEqual({ schemaVersion: 1, released: [A] });
  });

  it('flushSync only logs when the write fails', () => {
    const store = load({ fs: fsWith({ writeFileSync: failWith('EROFS') }) });
    store.setReleased(A, true);

    expect(() => store.flushSync()).not.toThrow();

    expect(files()).toStrictEqual([]);
    expect(poolLines('error')).toStrictEqual([
      '[pool] cannot write assignments.json (EROFS); keeping the released sessions in memory and retrying on the next flush',
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

    expect(readFile()).toStrictEqual({ schemaVersion: 1, released: [A] });
    vi.runAllTimers();
    expect(files()).toStrictEqual(['assignments.json']);
  });
});

describe('the start-up sweep', () => {
  it('I/O matrix 啟動清理: keeps the released keys reported since start, drops the rest from memory and the file; logged by count', () => {
    writeFile({ schemaVersion: 1, released: [A, B] });
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    store.sweep(new Set([A, DEMO]), new Set());

    expect(store.get()).toStrictEqual({ pool: { released: [A] } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      pool: { released: [A] },
    });
    expect(poolLines('info').at(-1)).toBe(
      '[pool] start-up sweep: kept 1, dropped 1 (2 sessions reported)',
    );
    vi.advanceTimersByTime(POOL_FLUSH_DEBOUNCE_MS);
    expect(readFile()).toStrictEqual({ schemaVersion: 1, released: [A] });
  });

  it('changes nothing, and writes nothing, when every released key was reported', () => {
    writeFile({ schemaVersion: 1, released: [A] });
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
    writeFile({ schemaVersion: 1, released: [A, B] });
    const store = load();

    store.sweep(new Set([A, B]), new Set());
    store.sweep(new Set(), new Set());

    expect(releasedOf(store)).toStrictEqual([A, B]);
  });

  it('a demo session released last run is dropped: demo mode is off at start, so it is not reported', () => {
    writeFile({ schemaVersion: 1, released: [A, DEMO] });
    const store = load();

    store.sweep(new Set([A]), new Set());
    store.flushSync();

    expect(readFile()).toStrictEqual({ schemaVersion: 1, released: [A] });
  });

  it('keeps every released key of an unconfirmed source, reported or not; logs counts and source codes only', () => {
    const C: SessionKey = 'cursor:00000000-0000-4000-8000-00000000000c';
    const D: SessionKey = 'cursor:00000000-0000-4000-8000-00000000000d';
    writeFile({ schemaVersion: 1, released: [A, B, C, D, DEMO] });
    const store = load();

    store.sweep(new Set([A, C]), new Set(['cursor']));

    expect(releasedOf(store)).toStrictEqual([A, C, D]);
    expect(poolLines('info').at(-1)).toBe(
      '[pool] start-up sweep: kept 3, dropped 2 (2 sessions reported; 1 kept unreported from unconfirmed sources: cursor)',
    );
    expect(poolLines().join('\n')).not.toMatch(/0000000/);
  });

  it('with no unconfirmed source the log line reads as before', () => {
    writeFile({ schemaVersion: 1, released: [A] });
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
    writeFile({ schemaVersion: 1, released: [a, b] });
    const { clock, detection, store, emit } = wire();

    emit([codexEvent('a', 'session.start', clock.wall() - MINUTE, true)]);
    expect(releasedOf(store)).toStrictEqual([a, b]);

    emit([{ type: 'sync.ready', source: 'codex' }], 'ok');

    expect(detection.get().sessions.map((s) => s.sessionKey)).toStrictEqual([
      a,
    ]);
    expect(releasedOf(store)).toStrictEqual([a]);
    store.flushSync();
    expect(readFile()).toStrictEqual({ schemaVersion: 1, released: [a] });
  });

  it(`I/O matrix 同步逾時: an adapter that never sends sync.ready gets the sweep at syncTimeoutMs (${SETTINGS_DEFAULTS.syncTimeoutMs} ms), which keeps its source's releases (Epic 2 close-out B1)`, () => {
    writeFile({ schemaVersion: 1, released: ['codex:a', 'codex:b'] });
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
    writeFile({
      schemaVersion: 1,
      released: [CLAUDE_A, CLAUDE_B, CURSOR_C, CURSOR_D],
    });
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
