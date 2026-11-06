import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUN_LOG_MAX_LINE_LENGTH,
  RUN_LOG_RETENTION_MS,
} from '../../src/shared/constants';
import {
  createRunLog,
  errorCode,
  logFileStart,
  type RunLogFs,
} from '../../src/main/log/run-log';

const HOUR = 60 * 60 * 1000;

/** Local time; the expectations below are built from local time as well. */
const T0 = new Date(2026, 10, 5, 17, 4, 9, 123).getTime();

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-run-log-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function clock(start: number) {
  let current = start;
  return {
    now: () => current,
    set(ms: number) {
      current = ms;
    },
  };
}

function offsetText(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${offset >= 0 ? '+' : '-'}${hh}:${mm}`;
}

function read(name: string): string {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

function lines(name: string): string[] {
  return read(name).split('\n').slice(0, -1);
}

/** Creates an (empty) log file named for the local hour starting at `ms`. */
function touchLogFor(ms: number): string {
  const at = new Date(ms);
  const name =
    `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-` +
    `${String(at.getDate()).padStart(2, '0')}-${String(at.getHours()).padStart(2, '0')}.log`;
  fs.writeFileSync(path.join(dir, name), 'old\n');
  return name;
}

describe('createRunLog', () => {
  it('names the file after the local hour and writes one tab-separated line', () => {
    const log = createRunLog({ dir, now: () => T0 });

    expect(log.write('app', 'start version=1.0.0')).toStrictEqual({
      ok: true,
    });

    expect(fs.readdirSync(dir)).toStrictEqual(['2026-11-05-17.log']);
    expect(read('2026-11-05-17.log')).toBe(
      `2026-11-05T17:04:09.123${offsetText(new Date(T0))}\tapp\tstart version=1.0.0\n`,
    );
  });

  it('creates the log directory when it does not exist', () => {
    const nested = path.join(dir, 'logs');
    const log = createRunLog({ dir: nested, now: () => T0 });

    expect(log.write('app', 'x').ok).toBe(true);
    expect(fs.readdirSync(nested)).toStrictEqual(['2026-11-05-17.log']);
  });

  it('appends later lines of the same hour to the same file, in order', () => {
    const time = clock(T0);
    const log = createRunLog({ dir, now: time.now });

    log.write('app', 'one');
    time.set(T0 + 30 * 60 * 1000);
    log.write('settings', 'two');
    log.write('ipc', 'three');

    expect(fs.readdirSync(dir)).toStrictEqual(['2026-11-05-17.log']);
    expect(
      lines('2026-11-05-17.log').map((line) => line.split('\t').slice(1)),
    ).toStrictEqual([
      ['app', 'one'],
      ['settings', 'two'],
      ['ipc', 'three'],
    ]);
  });

  it('escapes line breaks, tabs and other control characters', () => {
    const log = createRunLog({ dir, now: () => T0 });

    log.write('app', 'a\nb\r\nc\td\u0000e\u001bf\u2028g\\h');

    const [line] = lines('2026-11-05-17.log');
    expect(line?.split('\t')).toHaveLength(3);
    expect(line?.split('\t')[2]).toBe(
      'a\\nb\\r\\nc\\td\\u0000e\\u001bf\\u2028g\\h',
    );
  });

  it('escapes DEL, C1 controls and the paragraph separator', () => {
    const log = createRunLog({ dir, now: () => T0 });
    const del = String.fromCharCode(0x7f);
    const c1 = String.fromCharCode(0x9b);
    const paragraph = String.fromCharCode(0x2029);

    log.write('app', `a${del}b${c1}c${paragraph}d`);

    expect(lines('2026-11-05-17.log')[0]?.split('\t')[2]).toBe(
      'a\\u007fb\\u009bc\\u2029d',
    );
  });

  it(`cuts a long line at ${RUN_LOG_MAX_LINE_LENGTH} characters`, () => {
    const log = createRunLog({ dir, now: () => T0 });

    log.write('app', 'x'.repeat(RUN_LOG_MAX_LINE_LENGTH * 2));

    const [line] = lines('2026-11-05-17.log');
    expect(line).toHaveLength(RUN_LOG_MAX_LINE_LENGTH);
    expect(line?.endsWith('…[truncated]')).toBe(true);
  });

  it('keeps a line that is exactly at the limit whole', () => {
    const log = createRunLog({ dir, now: () => T0 });
    const prefixLength = `${'2026-11-05T17:04:09.123+00:00'}\tapp\t`.length;
    const message = 'y'.repeat(RUN_LOG_MAX_LINE_LENGTH - prefixLength);

    log.write('app', message);

    expect(lines('2026-11-05-17.log')[0]?.endsWith(message)).toBe(true);
  });

  it('never splits a surrogate pair or an escape sequence when cutting', () => {
    const log = createRunLog({ dir, now: () => T0 });

    log.write('app', '😀\n'.repeat(RUN_LOG_MAX_LINE_LENGTH));

    const [line = ''] = lines('2026-11-05-17.log');
    expect(line.length).toBeLessThanOrEqual(RUN_LOG_MAX_LINE_LENGTH);
    expect(line.isWellFormed()).toBe(true);
    const body = line.split('\t')[2]?.replace('…[truncated]', '') ?? '';
    expect(body).toMatch(/^(?:😀\\n)*(?:😀)?$/u);
  });

  describe('a new hour', () => {
    it('writes to a new file', () => {
      const time = clock(T0);
      const log = createRunLog({ dir, now: time.now });

      log.write('app', 'before');
      time.set(new Date(2026, 10, 5, 18, 0, 0, 0).getTime());
      log.write('app', 'after');

      expect(fs.readdirSync(dir).sort()).toStrictEqual([
        '2026-11-05-17.log',
        '2026-11-05-18.log',
      ]);
      expect(lines('2026-11-05-18.log')[0]?.endsWith('\tapp\tafter')).toBe(
        true,
      );
    });

    it('deletes log files whose hour started more than 24 hours ago, and nothing else', () => {
      const time = clock(T0);
      const log = createRunLog({ dir, now: time.now });
      log.write('app', 'first');
      const nextHour = new Date(2026, 10, 5, 18, 0, 0, 0).getTime();
      const expired = [
        touchLogFor(nextHour - RUN_LOG_RETENTION_MS - HOUR),
        touchLogFor(nextHour - 3 * RUN_LOG_RETENTION_MS),
      ];
      const kept = [
        touchLogFor(nextHour - RUN_LOG_RETENTION_MS),
        touchLogFor(nextHour - HOUR * 5),
      ];
      const others = [
        'notes.txt',
        '2026-11-01-01.log.bak',
        'x2026-11-01-01.log',
        '2026-13-01-01.log',
        '2026-11-01-24.log',
        '2026-11-1-01.log',
      ];
      for (const name of others) {
        fs.writeFileSync(path.join(dir, name), 'keep\n');
      }

      time.set(nextHour);
      log.write('app', 'second');

      const remaining = fs.readdirSync(dir).sort();
      for (const name of expired) {
        expect(remaining, name).not.toContain(name);
      }
      expect(remaining).toStrictEqual(
        ['2026-11-05-17.log', '2026-11-05-18.log', ...kept, ...others].sort(),
      );
    });

    it('also cleans up on the first write of a run', () => {
      const old = touchLogFor(T0 - 2 * RUN_LOG_RETENTION_MS);
      const log = createRunLog({ dir, now: () => T0 });

      log.write('app', 'start');

      expect(fs.readdirSync(dir)).not.toContain(old);
    });

    it('does not scan the folder again within the same hour', () => {
      const readdirSync = vi.fn((target: string) => fs.readdirSync(target));
      const log = createRunLog({
        dir,
        now: () => T0,
        fs: { ...fs, readdirSync } as unknown as RunLogFs,
      });

      log.write('app', 'one');
      log.write('app', 'two');

      expect(readdirSync).toHaveBeenCalledOnce();
    });

    it('skips a file it cannot delete and still deletes the others', () => {
      const first = touchLogFor(T0 - 2 * RUN_LOG_RETENTION_MS);
      const second = touchLogFor(T0 - 3 * RUN_LOG_RETENTION_MS);
      const unlinkSync = vi.fn((file: string) => {
        if (path.basename(file) === first) {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        fs.unlinkSync(file);
      });
      const log = createRunLog({
        dir,
        now: () => T0,
        fs: { ...fs, unlinkSync } as unknown as RunLogFs,
      });

      expect(log.write('app', 'start')).toStrictEqual({ ok: true });

      const remaining = fs.readdirSync(dir);
      expect(remaining).toContain(first);
      expect(remaining).not.toContain(second);
    });

    it('still writes when the folder cannot be listed', () => {
      const log = createRunLog({
        dir,
        now: () => T0,
        fs: {
          ...fs,
          readdirSync: () => {
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          },
        } as unknown as RunLogFs,
      });

      expect(log.write('app', 'start')).toStrictEqual({ ok: true });
      expect(lines('2026-11-05-17.log')).toHaveLength(1);
    });
  });

  it('answers { ok: false } instead of throwing when the file cannot be written', () => {
    const log = createRunLog({
      dir,
      now: () => T0,
      fs: {
        ...fs,
        appendFileSync: () => {
          throw Object.assign(new Error('full'), { code: 'ENOSPC' });
        },
      } as unknown as RunLogFs,
    });

    expect(log.write('app', 'x')).toStrictEqual({
      ok: false,
      reason: 'ENOSPC',
    });
  });

  it('recreates the folder when it disappears mid-hour', () => {
    const time = clock(T0);
    const log = createRunLog({ dir, now: time.now });
    expect(log.write('app', 'one').ok).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
    time.set(T0 + 60 * 1000);
    expect(log.write('app', 'lost').ok).toBe(false);
    expect(log.write('app', 'two').ok).toBe(true);

    expect(
      lines('2026-11-05-17.log').map((line) => line.split('\t')[2]),
    ).toStrictEqual(['two']);
  });

  it('retries opening the file after a failed first write', () => {
    let fail = true;
    const appendFileSync = vi.fn(
      (file: string, data: string, encoding: 'utf8') => {
        if (fail) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        fs.appendFileSync(file, data, encoding);
      },
    );
    const readdirSync = vi.fn((target: string) => fs.readdirSync(target));
    const log = createRunLog({
      dir,
      now: () => T0,
      fs: { ...fs, appendFileSync, readdirSync } as unknown as RunLogFs,
    });

    expect(log.write('app', 'one').ok).toBe(false);
    fail = false;
    expect(log.write('app', 'two').ok).toBe(true);

    expect(readdirSync).toHaveBeenCalledOnce();
    expect(lines('2026-11-05-17.log')).toHaveLength(1);
  });
});

describe('logFileStart', () => {
  it('reads the local start of the hour from a log file name', () => {
    expect(logFileStart('2026-11-05-17.log')).toBe(
      new Date(2026, 10, 5, 17).getTime(),
    );
  });

  it.each([
    'notes.txt',
    '2026-11-05-17.log.tmp',
    '2026-11-05-17.LOG',
    '2026-00-05-17.log',
    '2026-11-32-17.log',
    '2026-11-05-24.log',
  ])('ignores %s', (name) => {
    expect(logFileStart(name)).toBeUndefined();
  });
});

describe('errorCode', () => {
  it.each([
    [
      'a Node error code',
      Object.assign(new Error('x'), { code: 'EACCES' }),
      'EACCES',
    ],
    [
      'an error name',
      new SyntaxError('Unexpected token "secret"'),
      'SyntaxError',
    ],
    ['a thrown string', 'secret', 'string'],
  ])('gives %s, never the message', (_label, error, expected) => {
    expect(errorCode(error)).toBe(expected);
  });
});

describe('logEvent', () => {
  async function freshModule() {
    vi.resetModules();
    return import('../../src/main/log/run-log');
  }

  it('prints to the console only before initRunLog', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { logEvent } = await freshModule();

    logEvent('app', 'hello');
    logEvent('ipc', 'careful', 'warn');

    expect(info).toHaveBeenCalledExactlyOnceWith('[app] hello');
    expect(warn).toHaveBeenCalledExactlyOnceWith('[ipc] careful');
    expect(fs.readdirSync(dir)).toStrictEqual([]);
  });

  it('writes every event to the current hour file and the console after initRunLog', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initRunLog, logEvent } = await freshModule();
    const logs = path.join(dir, 'logs');

    initRunLog(logs);
    logEvent('app', 'start');
    logEvent('settings', 'cannot write settings.json (EACCES)', 'error');

    const [file] = fs.readdirSync(logs);
    expect(file).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}\.log$/);
    const written = fs
      .readFileSync(path.join(logs, file ?? ''), 'utf8')
      .split('\n')
      .slice(0, -1)
      .map((line) => line.split('\t').slice(1));
    expect(written).toStrictEqual([
      ['app', 'start'],
      ['settings', 'cannot write settings.json (EACCES)'],
    ]);
    expect(info).toHaveBeenCalledExactlyOnceWith('[app] start');
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '[settings] cannot write settings.json (EACCES)',
    );
  });

  it('falls back to the console without throwing when the log cannot be written', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initRunLog, logEvent } = await freshModule();
    const notADirectory = path.join(dir, 'file');
    fs.writeFileSync(notADirectory, '');

    initRunLog(path.join(notADirectory, 'logs'));
    expect(() => logEvent('app', 'one')).not.toThrow();
    expect(() => logEvent('app', 'two')).not.toThrow();

    expect(info.mock.calls).toStrictEqual([['[app] one'], ['[app] two']]);
    // The failure itself is reported once, not once per event.
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).toMatch(
      /^\[log\] cannot write the run log \(E[A-Z]+\)/,
    );
  });
});
