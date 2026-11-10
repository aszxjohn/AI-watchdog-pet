import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSettingsHandlers } from '../../src/main/settings/ipc';
import {
  SETTINGS_MIGRATIONS,
  migrateSettings,
} from '../../src/main/settings/migrations';
import {
  flushSettingsOnQuit,
  loadSettings,
  type SettingsFs,
  type SettingsStoreOptions,
} from '../../src/main/settings/store';
import { SETTINGS_FLUSH_DEBOUNCE_MS } from '../../src/shared/constants';
import { settingsGet, settingsPatch } from '../../src/shared/ipc';
import {
  SETTINGS_DEFAULTS,
  settingsFileSchema,
  type SettingsPatch,
} from '../../src/shared/settings';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

/** Local time, so the backup suffix below is the same in every time zone. */
const NOW = new Date(2026, 10, 5, 17, 4, 9).getTime();
const BACKUP = 'settings.json.broken-20261105-170409';
const DISPLAY_ID = 69733632;

/** A complete set of values, none of them the default. */
const CUSTOM_VALUES = {
  canvasDisplayId: DISPLAY_ID,
  doneMs: 8000,
  idleMs: 600_000,
  errorHoldMs: 45_000,
  approvalInferMs: 20_000,
  sessionExpireMs: 10_800_000,
  discoveryWindowMs: 3_600_000,
  syncTimeoutMs: 20_000,
} as const;

let dir: string;
let file: string;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-settings-'));
  file = path.join(dir, 'settings.json');
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

function settingsLines(): string[] {
  return logged().filter((line) => line.startsWith('[settings] '));
}

function load(options: Partial<SettingsStoreOptions> = {}) {
  return loadSettings({ file, now: () => NOW, ...options });
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

function setDisplay(baseRev: number, value: number | null): SettingsPatch {
  return {
    baseRev,
    ops: [{ op: 'set', field: 'canvasDisplayId', value }],
  };
}

function fsWith(overrides: Partial<SettingsFs>): SettingsFs {
  return { ...fs, ...overrides } as unknown as SettingsFs;
}

function failWith(code: string) {
  return () => {
    throw Object.assign(new Error(`${code}: ${file}`), { code });
  };
}

describe('loading settings.json', () => {
  it('uses defaults without creating or backing up anything when there is no file', () => {
    const store = load();

    expect(store.get()).toStrictEqual({ rev: 0, values: SETTINGS_DEFAULTS });
    expect(store.canWrite).toBe(true);
    vi.runAllTimers();
    expect(files()).toStrictEqual([]);
    expect(settingsLines()).toStrictEqual([]);
  });

  it('reads a valid file as is, without backing it up or writing it', () => {
    const text = writeFile({ schemaVersion: 1, ...CUSTOM_VALUES });

    const store = load();

    expect(store.get()).toStrictEqual({ rev: 0, values: CUSTOM_VALUES });
    expect(files()).toStrictEqual(['settings.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('reads a valid file saved with a UTF-8 BOM, without backing it up or writing it', () => {
    const text = writeFile(
      String.fromCharCode(0xfeff) +
        JSON.stringify({ schemaVersion: 1, ...CUSTOM_VALUES }),
    );

    const store = load();

    expect(store.get().values).toStrictEqual(CUSTOM_VALUES);
    expect(store.canWrite).toBe(true);
    expect(files()).toStrictEqual(['settings.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(settingsLines()).toStrictEqual([]);
  });

  it('gives a missing field its default without counting it as an error', () => {
    const text = writeFile({ schemaVersion: 1 });

    const store = load();

    expect(store.get().values).toStrictEqual(SETTINGS_DEFAULTS);
    expect(files()).toStrictEqual(['settings.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(settingsLines()).toStrictEqual([]);
  });

  it('reads a file from before the detection timings: they take their defaults, nothing is backed up or written', () => {
    const text = writeFile({ schemaVersion: 1, canvasDisplayId: DISPLAY_ID });

    const store = load();

    expect(store.get()).toStrictEqual({
      rev: 0,
      values: { ...SETTINGS_DEFAULTS, canvasDisplayId: DISPLAY_ID },
    });
    expect(store.canWrite).toBe(true);
    vi.runAllTimers();
    expect(files()).toStrictEqual(['settings.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(settingsLines()).toStrictEqual([]);
  });

  it('reads a file from before approvalInferMs: it takes 10000, nothing is backed up or written', () => {
    const { approvalInferMs: _added, ...before } = CUSTOM_VALUES;
    const text = writeFile({ schemaVersion: 1, ...before });

    const store = load();

    expect(store.get()).toStrictEqual({
      rev: 0,
      values: { ...before, approvalInferMs: 10_000 },
    });
    expect(store.canWrite).toBe(true);
    vi.runAllTimers();
    expect(files()).toStrictEqual(['settings.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(settingsLines()).toStrictEqual([]);
  });

  it('fixes a detection timing outside its range like any bad field', () => {
    const text = writeFile({
      schemaVersion: 1,
      ...CUSTOM_VALUES,
      doneMs: 999,
      sessionExpireMs: 86_400_001,
    });

    const store = load();

    const expected = {
      ...CUSTOM_VALUES,
      doneMs: SETTINGS_DEFAULTS.doneMs,
      sessionExpireMs: SETTINGS_DEFAULTS.sessionExpireMs,
    };
    expect(store.get().values).toStrictEqual(expected);
    expect(files()).toStrictEqual(['settings.json', BACKUP]);
    expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe(text);
    expect(readFile()).toStrictEqual({ schemaVersion: 1, ...expected });
    expect(logged('warn')).toStrictEqual([
      `[settings] settings.json has bad fields (invalid: doneMs, sessionExpireMs); copied it to ${BACKUP}, using defaults for invalid fields, dropping unknown ones`,
    ]);
  });

  describe('a broken file', () => {
    it.each([
      [
        'not JSON',
        '{"schemaVersion": 1, "canvasDisplayId": 7',
        'not valid JSON',
      ],
      ['empty', '', 'not valid JSON'],
      ['a JSON array', '[1]', 'not a JSON object'],
      ['JSON null', 'null', 'not a JSON object'],
      ['a JSON number', '42', 'not a JSON object'],
      ['a JSON string', '"settings"', 'not a JSON object'],
      [
        'missing schemaVersion',
        '{"canvasDisplayId": 7}',
        'schemaVersion is missing',
      ],
      [
        'schemaVersion 0',
        '{"schemaVersion": 0}',
        'schemaVersion is not a positive integer',
      ],
      [
        'a negative schemaVersion',
        '{"schemaVersion": -1}',
        'schemaVersion is not a positive integer',
      ],
      [
        'a fractional schemaVersion',
        '{"schemaVersion": 1.5}',
        'schemaVersion is not a positive integer',
      ],
      [
        'a string schemaVersion',
        '{"schemaVersion": "1"}',
        'schemaVersion is not a positive integer',
      ],
      [
        'a null schemaVersion',
        '{"schemaVersion": null}',
        'schemaVersion is not a positive integer',
      ],
      [
        'a newer schemaVersion',
        '{"schemaVersion": 2, "canvasDisplayId": 7}',
        'schemaVersion 2 is newer than this build supports (1)',
      ],
    ])(
      'is renamed to .broken-<time> when it is %s, and defaults are used',
      (_label, text, reason) => {
        writeFile(text);

        const store = load();

        expect(store.get()).toStrictEqual({
          rev: 0,
          values: SETTINGS_DEFAULTS,
        });
        expect(store.canWrite).toBe(true);
        expect(files()).toStrictEqual([BACKUP]);
        expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe(text);
        expect(logged('error')).toStrictEqual([
          `[settings] settings.json is unusable (${reason}); renamed it to ${BACKUP} and using defaults`,
        ]);
      },
    );

    it('does not quote the file in the log', () => {
      writeFile('{"canvasDisplayId": 123456789, oops');

      load();

      expect(settingsLines().join('\n')).not.toContain('123456789');
      expect(settingsLines().join('\n')).not.toContain('oops');
    });

    it('is written again only once a patch changes something', () => {
      writeFile('not json');
      const store = load();

      store.patch(setDisplay(0, DISPLAY_ID));
      vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS);

      expect(files()).toStrictEqual(['settings.json', BACKUP]);
      expect(readFile()).toStrictEqual({
        schemaVersion: 1,
        ...SETTINGS_DEFAULTS,
        canvasDisplayId: DISPLAY_ID,
      });
    });

    it('adds -2, -3 when a backup from the same second exists', () => {
      fs.writeFileSync(path.join(dir, BACKUP), 'first');
      fs.writeFileSync(path.join(dir, `${BACKUP}-2`), 'second');
      writeFile('not json');

      load();

      expect(files()).toStrictEqual([BACKUP, `${BACKUP}-2`, `${BACKUP}-3`]);
      expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe('first');
      expect(fs.readFileSync(path.join(dir, `${BACKUP}-3`), 'utf8')).toBe(
        'not json',
      );
    });

    it('is left alone, and never written this run, when it cannot be renamed', () => {
      writeFile('not json');
      const store = load({ fs: fsWith({ renameSync: failWith('EPERM') }) });

      expect(store.get().values).toStrictEqual(SETTINGS_DEFAULTS);
      expect(store.canWrite).toBe(false);
      expect(logged('error')).toStrictEqual([
        '[settings] settings.json is unusable (not valid JSON) and could not be renamed (EPERM); using defaults and not writing settings.json this run',
      ]);

      const result = store.patch(setDisplay(0, DISPLAY_ID));
      vi.runAllTimers();
      store.flushSync();

      expect(result).toStrictEqual({ rev: 1, merged: false });
      expect(store.get().values.canvasDisplayId).toBe(DISPLAY_ID);
      expect(files()).toStrictEqual(['settings.json']);
      expect(fs.readFileSync(file, 'utf8')).toBe('not json');
    });
  });

  describe('migrations', () => {
    it('has no migrations while the schema is at version 1', () => {
      expect(SETTINGS_MIGRATIONS).toStrictEqual({});
      expect(Object.isFrozen(SETTINGS_MIGRATIONS)).toBe(true);
    });

    it('runs each step from the file version up to the current one', () => {
      writeFile({ schemaVersion: 1, display: 5 });
      const store = load({
        schemaVersion: 3,
        migrations: {
          1: ({ display, ...rest }) => ({ ...rest, monitor: display }),
          2: ({ monitor, ...rest }) => ({ ...rest, canvasDisplayId: monitor }),
        },
      });

      expect(store.get().values).toStrictEqual({
        ...SETTINGS_DEFAULTS,
        canvasDisplayId: 5,
      });
      expect(logged('info')).toContain(
        '[settings] migrated settings.json from schemaVersion 1 to 3',
      );
      expect(files()).toStrictEqual(['settings.json']);
    });

    it.each([
      [
        'throws',
        {
          1: () => {
            throw new Error('secret 123');
          },
        },
        'migration from schemaVersion 1 failed (Error)',
      ],
      [
        'returns a non-object',
        { 1: () => [] as unknown as Record<string, unknown> },
        'migration from schemaVersion 1 did not return an object',
      ],
      ['is missing', {}, 'no migration from schemaVersion 1'],
    ])(
      'treats the file as broken when a step %s',
      (_label, migrations, reason) => {
        const text = writeFile({ schemaVersion: 1, canvasDisplayId: 7 });

        const store = load({ schemaVersion: 2, migrations });

        expect(store.get().values).toStrictEqual(SETTINGS_DEFAULTS);
        expect(files()).toStrictEqual([BACKUP]);
        expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe(text);
        expect(logged('error')).toStrictEqual([
          `[settings] settings.json is unusable (${reason}); renamed it to ${BACKUP} and using defaults`,
        ]);
      },
    );

    it('migrateSettings gives each step a copy and sets schemaVersion itself', () => {
      const original = { schemaVersion: 1, list: [1] };
      const outcome = migrateSettings(original, 1, 2, {
        1: (data) => {
          (data.list as number[]).push(2);
          return { ...data, schemaVersion: 99 };
        },
      });

      expect(outcome).toStrictEqual({
        ok: true,
        data: { schemaVersion: 2, list: [1, 2] },
      });
      expect(original).toStrictEqual({ schemaVersion: 1, list: [1] });
    });

    it('backs up the pre-migration file and fixes it when the migrated data has a bad field', () => {
      const text = writeFile({ schemaVersion: 1, display: 'main' });

      const store = load({
        schemaVersion: 2,
        migrations: {
          1: ({ display, ...rest }) => ({ ...rest, canvasDisplayId: display }),
        },
      });

      expect(store.get().values).toStrictEqual(SETTINGS_DEFAULTS);
      expect(store.canWrite).toBe(true);
      expect(files()).toStrictEqual(['settings.json', BACKUP]);
      expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe(text);
      expect(readFile()).toStrictEqual({
        schemaVersion: 2,
        ...SETTINGS_DEFAULTS,
      });
      expect(settingsLines()).toStrictEqual([
        '[settings] migrated settings.json from schemaVersion 1 to 2',
        `[settings] settings.json has bad fields (invalid: canvasDisplayId); copied it to ${BACKUP}, using defaults for invalid fields, dropping unknown ones`,
      ]);
    });
  });

  describe('a file with bad fields', () => {
    it.each([
      [
        'a field of the wrong type',
        { schemaVersion: 1, canvasDisplayId: 'main' },
        'invalid: canvasDisplayId',
      ],
      [
        'an unknown field',
        { schemaVersion: 1, canvasDisplayId: 7, theme: 'dark' },
        'unknown: "theme"',
      ],
      [
        'both',
        { schemaVersion: 1, canvasDisplayId: -3, a: 1, b: 2 },
        'invalid: canvasDisplayId; unknown: "a", "b"',
      ],
    ])(
      'keeps a copy, fixes only those fields and writes the fixed file back (%s)',
      (_label, content, problems) => {
        const text = writeFile(content);
        const expected = {
          ...SETTINGS_DEFAULTS,
          canvasDisplayId:
            typeof content.canvasDisplayId === 'number' &&
            content.canvasDisplayId >= 0
              ? content.canvasDisplayId
              : null,
        };

        const store = load();

        expect(store.get()).toStrictEqual({ rev: 0, values: expected });
        expect(store.canWrite).toBe(true);
        expect(files()).toStrictEqual(['settings.json', BACKUP]);
        expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe(text);
        const written = readFile();
        expect(written).toStrictEqual({ schemaVersion: 1, ...expected });
        expect(settingsFileSchema.safeParse(written).success).toBe(true);
        expect(logged('warn')).toStrictEqual([
          `[settings] settings.json has bad fields (${problems}); copied it to ${BACKUP}, using defaults for invalid fields, dropping unknown ones`,
        ]);
      },
    );

    it('logs field names, never their values', () => {
      writeFile({ schemaVersion: 1, canvasDisplayId: 'secret-value', x: 42 });

      load();

      const text = settingsLines().join('\n');
      expect(text).toContain('canvasDisplayId');
      expect(text).not.toContain('secret-value');
      expect(text).not.toContain('42');
    });

    it('does not back it up again on the next start', () => {
      writeFile({ schemaVersion: 1, canvasDisplayId: 'main' });
      load();

      const store = load();

      expect(store.get().values).toStrictEqual(SETTINGS_DEFAULTS);
      expect(files()).toStrictEqual(['settings.json', BACKUP]);
    });

    it('keeps the original, and never writes this run, when the copy fails', () => {
      const text = writeFile({ schemaVersion: 1, canvasDisplayId: 'main' });
      const store = load({ fs: fsWith({ copyFileSync: failWith('ENOSPC') }) });

      expect(store.get().values).toStrictEqual(SETTINGS_DEFAULTS);
      expect(store.canWrite).toBe(false);
      expect(logged('error')).toStrictEqual([
        '[settings] settings.json has bad fields (invalid: canvasDisplayId) and could not be backed up (ENOSPC); using defaults for them and not writing settings.json this run',
      ]);

      store.patch(setDisplay(0, 1));
      vi.runAllTimers();
      store.flushSync();

      expect(files()).toStrictEqual(['settings.json']);
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
    });
  });

  it('uses defaults, and never writes this run, when the file cannot be read', () => {
    const text = writeFile({ schemaVersion: 1, canvasDisplayId: 7 });
    const store = load({ fs: fsWith({ readFileSync: failWith('EACCES') }) });

    expect(store.get().values).toStrictEqual(SETTINGS_DEFAULTS);
    expect(store.canWrite).toBe(false);
    expect(logged('error')).toStrictEqual([
      '[settings] cannot read settings.json (EACCES); using defaults and not writing settings.json this run',
    ]);

    store.patch(setDisplay(0, 1));
    vi.runAllTimers();
    store.flushSync();

    expect(files()).toStrictEqual(['settings.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });
});

describe('patching', () => {
  it('applies a patch at the current rev: rev + 1, one change event, not merged', () => {
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    const result = store.patch(setDisplay(0, DISPLAY_ID));

    expect(result).toStrictEqual({ rev: 1, merged: false });
    expect(store.get()).toStrictEqual({
      rev: 1,
      values: { ...SETTINGS_DEFAULTS, canvasDisplayId: DISPLAY_ID },
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(store.get());
  });

  it('lets the later op on the same field win', () => {
    const store = load();

    store.patch({
      baseRev: 0,
      ops: [
        { op: 'set', field: 'canvasDisplayId', value: 1 },
        { op: 'set', field: 'canvasDisplayId', value: 2 },
      ],
    });

    expect(store.get().values.canvasDisplayId).toBe(2);
  });

  it('merges a patch with an old baseRev into the current values', () => {
    const store = load();
    store.patch(setDisplay(0, 1));
    store.patch(setDisplay(1, 2));

    const result = store.patch(setDisplay(0, 3));

    expect(result).toStrictEqual({ rev: 3, merged: true });
    expect(store.get()).toStrictEqual({
      rev: 3,
      values: { ...SETTINGS_DEFAULTS, canvasDisplayId: 3 },
    });
  });

  it('merges a patch whose baseRev is ahead of the current rev, with a warning', () => {
    const store = load();

    const result = store.patch(setDisplay(5, 1));

    expect(result).toStrictEqual({ rev: 1, merged: true });
    expect(logged('warn')).toStrictEqual([
      '[settings] patch baseRev 5 is ahead of rev 0; applying it to the current values',
    ]);
  });

  it('changes nothing when the values are the same: no rev, no event, no write', () => {
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    expect(store.patch(setDisplay(0, null))).toStrictEqual({
      rev: 0,
      merged: false,
    });
    store.patch(setDisplay(0, 4));
    expect(store.patch(setDisplay(0, 4))).toStrictEqual({
      rev: 1,
      merged: true,
    });

    expect(onChange).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(files()).toStrictEqual(['settings.json']);
  });

  it('logs changed field names, not values', () => {
    const store = load();

    store.patch(setDisplay(0, DISPLAY_ID));

    expect(logged('info')).toStrictEqual([
      '[settings] changed canvasDisplayId (rev 1)',
    ]);
  });

  it('throws on a patch that fails the shared schema, changing nothing', () => {
    const store = load();

    expect(() =>
      store.patch({ baseRev: 0, ops: [] } as unknown as SettingsPatch),
    ).toThrow();
    expect(store.get()).toStrictEqual({ rev: 0, values: SETTINGS_DEFAULTS });
  });

  it('stops calling a listener once unsubscribed, and survives one that throws', () => {
    const store = load();
    const throwing = vi.fn(() => {
      throw new Error('listener bug');
    });
    const later = vi.fn();
    const stop = store.onChange(throwing);
    store.onChange(later);

    store.patch(setDisplay(0, 1));
    stop();
    store.patch(setDisplay(1, 2));

    expect(throwing).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledTimes(2);
    expect(logged('error')).toStrictEqual([
      '[settings] a change listener failed (Error)',
    ]);
  });
});

describe('writing settings.json', () => {
  function countingFs() {
    const writeFileSync = vi.fn(fs.writeFileSync);
    const renameSync = vi.fn(fs.renameSync);
    return {
      writeFileSync,
      renameSync,
      fs: fsWith({
        writeFileSync: writeFileSync as SettingsFs['writeFileSync'],
        renameSync,
      }),
    };
  }

  it(`writes once, ${SETTINGS_FLUSH_DEBOUNCE_MS} ms after the first unsaved change, however many patches follow`, () => {
    const counting = countingFs();
    const store = load({ fs: counting.fs });

    store.patch(setDisplay(0, 1));
    vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS - 100);
    store.patch(setDisplay(1, 2));
    vi.advanceTimersByTime(99);
    store.patch(setDisplay(2, 3));
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
    expect(files()).toStrictEqual(['settings.json']);
    expect(readFile()).toStrictEqual({
      schemaVersion: 1,
      ...SETTINGS_DEFAULTS,
      canvasDisplayId: 3,
    });

    vi.runAllTimers();
    expect(counting.writeFileSync).toHaveBeenCalledOnce();
  });

  it('starts a new window for the next change after a write', () => {
    const counting = countingFs();
    const store = load({ fs: counting.fs });

    store.patch(setDisplay(0, 1));
    vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS);
    store.patch(setDisplay(1, 2));
    vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS);

    expect(counting.writeFileSync).toHaveBeenCalledTimes(2);
    expect(readFile()).toStrictEqual({
      schemaVersion: 1,
      ...SETTINGS_DEFAULTS,
      canvasDisplayId: 2,
    });
  });

  it('keeps the values in memory, removes the temp file and retries on the next flush when a write fails', () => {
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

    store.patch(setDisplay(0, 1));
    vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS);

    expect(files()).toStrictEqual([]);
    expect(store.get().values.canvasDisplayId).toBe(1);
    expect(logged('error')).toStrictEqual([
      '[settings] cannot write settings.json (EBUSY); keeping the values in memory and retrying on the next flush',
    ]);

    store.patch(setDisplay(1, 2));
    vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS);

    expect(files()).toStrictEqual(['settings.json']);
    expect(readFile()).toStrictEqual({
      schemaVersion: 1,
      ...SETTINGS_DEFAULTS,
      canvasDisplayId: 2,
    });
  });

  it('flushSync writes pending changes at once and cancels the timer', () => {
    const counting = countingFs();
    const store = load({ fs: counting.fs });
    store.patch(setDisplay(0, DISPLAY_ID));

    store.flushSync();

    expect(readFile()).toStrictEqual({
      schemaVersion: 1,
      ...SETTINGS_DEFAULTS,
      canvasDisplayId: DISPLAY_ID,
    });
    vi.runAllTimers();
    expect(counting.writeFileSync).toHaveBeenCalledOnce();
  });

  it('flushSync writes nothing when nothing is pending', () => {
    const counting = countingFs();
    const store = load({ fs: counting.fs });

    store.flushSync();

    expect(counting.writeFileSync).not.toHaveBeenCalled();
    expect(files()).toStrictEqual([]);
  });

  it('flushSync only logs when the write fails', () => {
    const store = load({ fs: fsWith({ writeFileSync: failWith('EROFS') }) });
    store.patch(setDisplay(0, 1));

    expect(() => store.flushSync()).not.toThrow();

    expect(files()).toStrictEqual([]);
    expect(logged('error')).toStrictEqual([
      '[settings] cannot write settings.json (EROFS); keeping the values in memory and retrying on the next flush',
    ]);
  });

  it('retries writing back a fixed file on the next flush when the first write-back fails', () => {
    writeFile({ schemaVersion: 1, canvasDisplayId: 'main' });
    let failures = 1;
    const store = load({
      fs: fsWith({
        writeFileSync: (target, data, options) => {
          if (failures > 0) {
            failures -= 1;
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
          }
          fs.writeFileSync(target, data, options);
        },
      }),
    });
    expect(readFile()).toStrictEqual({
      schemaVersion: 1,
      canvasDisplayId: 'main',
    });

    store.flushSync();

    expect(readFile()).toStrictEqual({
      schemaVersion: 1,
      ...SETTINGS_DEFAULTS,
      canvasDisplayId: null,
    });
    expect(files()).toStrictEqual(['settings.json', BACKUP]);
  });
});

describe('flushSettingsOnQuit', () => {
  it('writes a pending patch on will-quit, without waiting for the debounce', () => {
    const app = new EventEmitter();
    const store = load();
    flushSettingsOnQuit(app, store);
    store.patch(setDisplay(0, DISPLAY_ID));
    expect(files()).toStrictEqual([]);

    app.emit('will-quit');

    expect(readFile()).toStrictEqual({
      schemaVersion: 1,
      ...SETTINGS_DEFAULTS,
      canvasDisplayId: DISPLAY_ID,
    });
  });
});

describe('settings IPC', () => {
  beforeEach(() => {
    fake.resetFakeElectron();
  });

  it('answers settings:get and settings:patch', async () => {
    const store = load();
    registerSettingsHandlers(store);

    expect(await fake.ipcRenderer.invoke(settingsGet.channel)).toStrictEqual({
      ok: true,
      data: { rev: 0, values: SETTINGS_DEFAULTS },
    });
    expect(
      await fake.ipcRenderer.invoke(
        settingsPatch.channel,
        setDisplay(0, DISPLAY_ID),
      ),
    ).toStrictEqual({ ok: true, data: { rev: 1, merged: false } });
    expect(store.get().values.canvasDisplayId).toBe(DISPLAY_ID);
  });

  it.each([
    [
      'an unknown field',
      { baseRev: 0, ops: [{ op: 'set', field: 'theme', value: 'dark' }] },
    ],
    [
      'a value of the wrong type',
      {
        baseRev: 0,
        ops: [{ op: 'set', field: 'canvasDisplayId', value: '1' }],
      },
    ],
    ['no ops', { baseRev: 0, ops: [] }],
    ['a whole-settings object', { canvasDisplayId: 1 }],
  ])(
    'answers invalid-input to a patch with %s and changes nothing',
    async (_label, patch) => {
      const store = load();
      const onChange = vi.fn();
      store.onChange(onChange);
      registerSettingsHandlers(store);

      const reply = await fake.ipcRenderer.invoke(settingsPatch.channel, patch);

      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
      expect(store.get()).toStrictEqual({
        rev: 0,
        values: SETTINGS_DEFAULTS,
      });
      expect(onChange).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(files()).toStrictEqual([]);
    },
  );
});
