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
  loadSettings,
  type SettingsFs,
  type SettingsStoreOptions,
} from '../../src/main/settings/store';
import {
  FIXED_OVERRIDES_MAX_ENTRIES,
  PACK_ENABLED_MAX_ENTRIES,
  SETTINGS_FLUSH_DEBOUNCE_MS,
} from '../../src/shared/constants';
import { settingsGet, settingsPatch } from '../../src/shared/ipc';
import {
  isInPool,
  isPackEnabled,
  SETTINGS_DEFAULTS,
  settingsFileSchema,
  type SettingsOp,
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
  packEnabled: { 'pack-a': false },
  fixedOverrides: { 'pack-a/char-a': { inPool: false } },
  demoCharacter: 'pack-a/char-a',
} as const;

/** A StageView batch that only runs the patch, for the IPC tests. */
const NO_BATCH = { batch: <T>(run: () => T): T => run() };

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

  it('reads a file from before demoCharacter: it takes null, nothing is backed up or written', () => {
    const { demoCharacter: _added, ...before } = CUSTOM_VALUES;
    const text = writeFile({ schemaVersion: 1, ...before });

    const store = load();

    expect(store.get()).toStrictEqual({
      rev: 0,
      values: { ...before, demoCharacter: null },
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

  it('gives sessionExpireMs of 60 minutes (no longer above the longest idleMs) its default of 2 hours', () => {
    const text = writeFile({
      schemaVersion: 1,
      ...CUSTOM_VALUES,
      sessionExpireMs: 3_600_000,
    });

    const store = load();

    const expected = { ...CUSTOM_VALUES, sessionExpireMs: 7_200_000 };
    expect(store.get().values).toStrictEqual(expected);
    expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe(text);
    expect(readFile()).toStrictEqual({ schemaVersion: 1, ...expected });
    expect(logged('warn')).toStrictEqual([
      `[settings] settings.json has bad fields (invalid: sessionExpireMs); copied it to ${BACKUP}, using defaults for invalid fields, dropping unknown ones`,
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

      expect(result).toStrictEqual({ rev: 1, merged: false, saved: false });
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

    expect(result).toStrictEqual({ rev: 1, merged: false, saved: true });
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

    expect(result).toStrictEqual({ rev: 3, merged: true, saved: true });
    expect(store.get()).toStrictEqual({
      rev: 3,
      values: { ...SETTINGS_DEFAULTS, canvasDisplayId: 3 },
    });
  });

  it('merges a patch whose baseRev is ahead of the current rev, with a warning', () => {
    const store = load();

    const result = store.patch(setDisplay(5, 1));

    expect(result).toStrictEqual({ rev: 1, merged: true, saved: true });
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
      saved: true,
    });
    store.patch(setDisplay(0, 4));
    expect(store.patch(setDisplay(0, 4))).toStrictEqual({
      rev: 1,
      merged: true,
      saved: true,
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

describe('the patch reply says whether settings.json is kept (saved)', () => {
  /** An fs whose writes fail while `failing.on` is true. */
  function flakyFs() {
    const failing = { on: false };
    return {
      failing,
      fs: fsWith({
        writeFileSync: (target, data, options) => {
          if (failing.on) {
            throw Object.assign(new Error('read-only'), { code: 'EROFS' });
          }
          fs.writeFileSync(target, data, options);
        },
      }),
    };
  }

  it('is true while settings.json can be written, also for a patch that changes nothing', () => {
    const store = load();

    expect(store.patch(setDisplay(0, 1)).saved).toBe(true);
    vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS);
    expect(store.patch(setDisplay(1, 2)).saved).toBe(true);
    expect(store.patch(setDisplay(2, 2))).toStrictEqual({
      rev: 2,
      merged: false,
      saved: true,
    });
  });

  it.each([
    [
      'cannot be read',
      () => {
        writeFile({ schemaVersion: 1, canvasDisplayId: 7 });
        return { fs: fsWith({ readFileSync: failWith('EACCES') }) };
      },
    ],
    [
      'is broken and cannot be renamed',
      () => {
        writeFile('not json');
        return { fs: fsWith({ renameSync: failWith('EPERM') }) };
      },
    ],
    [
      'has bad fields and cannot be backed up',
      () => {
        writeFile({ schemaVersion: 1, canvasDisplayId: 'main' });
        return { fs: fsWith({ copyFileSync: failWith('ENOSPC') }) };
      },
    ],
  ])(
    'is false all run when settings.json %s (canWrite false); the values still apply',
    (_label, arrange) => {
      const store = load(arrange());
      expect(store.canWrite).toBe(false);

      const changed = store.patch(setDisplay(0, DISPLAY_ID));
      const unchanged = store.patch(setDisplay(1, DISPLAY_ID));

      expect(changed).toStrictEqual({ rev: 1, merged: false, saved: false });
      expect(unchanged).toStrictEqual({ rev: 1, merged: false, saved: false });
      expect(store.get().values.canvasDisplayId).toBe(DISPLAY_ID);
    },
  );

  it('is false after a write fails, until a later write succeeds', () => {
    const flaky = flakyFs();
    const store = load({ fs: flaky.fs });

    flaky.failing.on = true;
    // Answered before the debounced write: that failure is only logged.
    expect(store.patch(setDisplay(0, 1)).saved).toBe(true);
    vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS);
    expect(logged('error')).toStrictEqual([
      '[settings] cannot write settings.json (EROFS); keeping the values in memory and retrying on the next flush',
    ]);

    expect(store.patch(setDisplay(1, 2)).saved).toBe(false);
    expect(store.patch(setDisplay(2, 2)).saved).toBe(false);
    vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS);
    expect(store.patch(setDisplay(2, 3)).saved).toBe(false);

    flaky.failing.on = false;
    vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS);

    expect(readFile()).toStrictEqual({
      schemaVersion: 1,
      ...SETTINGS_DEFAULTS,
      canvasDisplayId: 3,
    });
    expect(store.patch(setDisplay(3, 3)).saved).toBe(true);
    expect(store.patch(setDisplay(3, 4)).saved).toBe(true);
  });

  it('is false after flushSync fails, and true again once it succeeds', () => {
    const flaky = flakyFs();
    const store = load({ fs: flaky.fs });
    store.patch(setDisplay(0, 1));

    flaky.failing.on = true;
    store.flushSync();
    expect(store.patch(setDisplay(1, 1)).saved).toBe(false);

    flaky.failing.on = false;
    store.flushSync();
    expect(store.patch(setDisplay(1, 1)).saved).toBe(true);
  });

  it('is false when writing back a fixed file at load fails, until a write succeeds', () => {
    writeFile({ schemaVersion: 1, canvasDisplayId: 'main' });
    const flaky = flakyFs();
    flaky.failing.on = true;
    const store = load({ fs: flaky.fs });
    expect(store.canWrite).toBe(true);

    expect(store.patch(setDisplay(0, null)).saved).toBe(false);

    flaky.failing.on = false;
    store.flushSync();
    expect(store.patch(setDisplay(0, null)).saved).toBe(true);
  });
});

describe('settings IPC', () => {
  beforeEach(() => {
    fake.resetFakeElectron();
  });

  it('answers settings:get and settings:patch', async () => {
    const store = load();
    registerSettingsHandlers(store, NO_BATCH);

    expect(await fake.ipcRenderer.invoke(settingsGet.channel)).toStrictEqual({
      ok: true,
      data: { rev: 0, values: SETTINGS_DEFAULTS },
    });
    expect(
      await fake.ipcRenderer.invoke(
        settingsPatch.channel,
        setDisplay(0, DISPLAY_ID),
      ),
    ).toStrictEqual({
      ok: true,
      data: { rev: 1, merged: false, saved: true },
    });
    expect(store.get().values.canvasDisplayId).toBe(DISPLAY_ID);
  });

  it('runs a settings:patch inside one StageView batch (Story 3.6): the change is heard while the batch is open', async () => {
    const store = load();
    const events: string[] = [];
    store.onChange(() => {
      events.push('changed');
    });
    registerSettingsHandlers(store, {
      batch<T>(run: () => T): T {
        events.push('batch opens');
        try {
          return run();
        } finally {
          events.push('batch ends');
        }
      },
    });

    const reply = await fake.ipcRenderer.invoke(
      settingsPatch.channel,
      setDisplay(0, DISPLAY_ID),
    );

    expect(reply).toStrictEqual({
      ok: true,
      data: { rev: 1, merged: false, saved: true },
    });
    expect(events).toStrictEqual(['batch opens', 'changed', 'batch ends']);
    expect(await fake.ipcRenderer.invoke(settingsGet.channel)).toMatchObject({
      ok: true,
    });
    expect(events).toHaveLength(3);
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
    [
      'an idleMs above its maximum (bypassing the panel)',
      { baseRev: 0, ops: [{ op: 'set', field: 'idleMs', value: 3_600_001 }] },
    ],
    [
      'a fractional doneMs',
      { baseRev: 0, ops: [{ op: 'set', field: 'doneMs', value: 1500.5 }] },
    ],
  ])(
    'answers invalid-input to a patch with %s and changes nothing',
    async (_label, patch) => {
      const store = load();
      const onChange = vi.fn();
      store.onChange(onChange);
      registerSettingsHandlers(store, NO_BATCH);

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

/** 上場 of `packId` set to `value`, alone in a patch at `baseRev`. */
function setPack(
  baseRev: number,
  packId: string,
  value: boolean,
): SettingsPatch {
  return { baseRev, ops: [{ op: 'setPackEnabled', packId, value }] };
}

/** 加入池子 of `key` set to `value`, as an op. */
function poolOp(key: string, value: boolean): SettingsOp {
  return {
    op: 'setFixed',
    characterKey: key as `${string}/${string}`,
    param: 'inPool',
    value,
  };
}

/** 加入池子 of `key` set to `value`, alone in a patch at `baseRev`. */
function setPool(baseRev: number, key: string, value: boolean): SettingsPatch {
  return { baseRev, ops: [poolOp(key, value)] };
}

/** settings.json after the pending write. */
function flushedFile(): Record<string, unknown> {
  vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS);
  return readFile() as Record<string, unknown>;
}

describe('the keyed settings (Story 3.3)', () => {
  it('logs only the field changed, never the pack id, character key or value', () => {
    const store = load();

    store.patch(setPack(0, 'secret-pack', false));
    store.patch(setPool(1, 'secret-pack/hidden-char', false));

    expect(logged('info')).toStrictEqual([
      '[settings] changed packEnabled (rev 1)',
      '[settings] changed fixedOverrides (rev 2)',
    ]);
    expect(settingsLines().join('\n')).not.toContain('secret');
    expect(settingsLines().join('\n')).not.toContain('hidden');
  });

  it('changes nothing when the value is already the effective one: no rev, no event, no write', () => {
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    expect(store.patch(setPack(0, 'pack-a', true))).toStrictEqual({
      rev: 0,
      merged: false,
      saved: true,
    });
    expect(store.patch(setPool(0, 'pack-a/char-a', true)).rev).toBe(0);

    expect(onChange).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(files()).toStrictEqual([]);
  });

  it('lets the later op on the same key win within one patch', () => {
    const store = load();

    store.patch({
      baseRev: 0,
      ops: [
        { op: 'setPackEnabled', packId: 'pack-a', value: false },
        poolOp('pack-a/char-a', false),
        { op: 'setPackEnabled', packId: 'pack-a', value: true },
      ],
    });

    expect(store.get().values.packEnabled).toStrictEqual({});
    expect(store.get().values.fixedOverrides).toStrictEqual({
      'pack-a/char-a': { inPool: false },
    });
  });

  it('a patch that ends where it started changes nothing, whatever order the file lists the keys in', () => {
    writeFile({
      schemaVersion: 1,
      packEnabled: { 'pack-b': false, 'pack-a': false },
    });
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    const result = store.patch({
      baseRev: 0,
      ops: [
        { op: 'setPackEnabled', packId: 'pack-b', value: true },
        { op: 'setPackEnabled', packId: 'pack-b', value: false },
      ],
    });

    expect(result.rev).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('writes each keyed setting with its keys sorted', () => {
    const store = load();

    store.patch({
      baseRev: 0,
      ops: [
        { op: 'setPackEnabled', packId: 'pack-c', value: false },
        { op: 'setPackEnabled', packId: 'pack-a', value: false },
        poolOp('pack-b/char-z', false),
        poolOp('pack-b/char-a', false),
      ],
    });

    const written = flushedFile();
    expect(Object.keys(written.packEnabled as object)).toStrictEqual([
      'pack-a',
      'pack-c',
    ]);
    expect(Object.keys(written.fixedOverrides as object)).toStrictEqual([
      'pack-b/char-a',
      'pack-b/char-z',
    ]);
    expect(settingsFileSchema.safeParse(written).success).toBe(true);
  });

  it('freezes the keyed settings and each of their entries, at load and after a patch', () => {
    writeFile({
      schemaVersion: 1,
      packEnabled: { 'pack-a': false },
      fixedOverrides: { 'pack-a/char-a': { inPool: false } },
    });
    const store = load();
    function expectFrozen() {
      const { values } = store.get();
      expect(Object.isFrozen(values)).toBe(true);
      expect(Object.isFrozen(values.packEnabled)).toBe(true);
      expect(Object.isFrozen(values.fixedOverrides)).toBe(true);
      const entries = Object.values(values.fixedOverrides);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(Object.isFrozen(entry)).toBe(true);
      }
    }

    expectFrozen();
    store.patch({
      baseRev: 0,
      ops: [
        { op: 'setPackEnabled', packId: 'pack-b', value: false },
        poolOp('pack-b/char-b', false),
      ],
    });
    expectFrozen();

    const { values } = store.get();
    expect(() => {
      (values.packEnabled as Record<string, boolean>)['pack-c'] = false;
    }).toThrow(TypeError);
    expect(() => {
      (values.fixedOverrides['pack-b/char-b'] as { inPool?: boolean }).inPool =
        true;
    }).toThrow(TypeError);
    expect(isPackEnabled(store.get().values, 'pack-c')).toBe(true);
    expect(isInPool(store.get().values, 'pack-b', 'char-b')).toBe(false);
  });

  it('keeps a pack id named like an Object key as an ordinary key', () => {
    const store = load();

    store.patch(setPack(0, 'constructor', false));

    expect(isPackEnabled(store.get().values, 'constructor')).toBe(false);
    expect(flushedFile().packEnabled).toStrictEqual({ constructor: false });

    store.patch(setPack(1, 'constructor', true));
    expect(store.get().values.packEnabled).toStrictEqual({});
  });
});

/** settings.json with packEnabled and fixedOverrides at their most entries. */
function fullFile() {
  return {
    schemaVersion: 1,
    packEnabled: Object.fromEntries(
      Array.from({ length: PACK_ENABLED_MAX_ENTRIES }, (_, i) => [
        `pack-${i}`,
        false,
      ]),
    ),
    fixedOverrides: Object.fromEntries(
      Array.from({ length: FIXED_OVERRIDES_MAX_ENTRIES }, (_, i) => [
        `pack-${i % 64}/char-${i}`,
        { inPool: false },
      ]),
    ),
  };
}

describe('I/O matrix', () => {
  it('切換上場: turning a pack off adds one false entry to settings.json, nothing else', () => {
    const store = load();
    const onChange = vi.fn();
    store.onChange(onChange);

    const result = store.patch(setPack(0, 'pack-a', false));

    expect(result).toStrictEqual({ rev: 1, merged: false, saved: true });
    expect(store.get().values).toStrictEqual({
      ...SETTINGS_DEFAULTS,
      packEnabled: { 'pack-a': false },
    });
    expect(isPackEnabled(store.get().values, 'pack-a')).toBe(false);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(store.get());
    expect(flushedFile()).toStrictEqual({
      schemaVersion: 1,
      ...SETTINGS_DEFAULTS,
      packEnabled: { 'pack-a': false },
    });
  });

  it('改回預設: turning 上場 back on removes the entry from settings.json', () => {
    const store = load();
    store.patch(setPack(0, 'pack-a', false));
    store.patch(setPack(1, 'pack-b', false));
    vi.advanceTimersByTime(SETTINGS_FLUSH_DEBOUNCE_MS);

    store.patch(setPack(2, 'pack-a', true));

    expect(store.get().values.packEnabled).toStrictEqual({ 'pack-b': false });
    const written = flushedFile();
    expect(written.packEnabled).toStrictEqual({ 'pack-b': false });
    expect(JSON.stringify(written)).not.toContain('pack-a');
  });

  it('改回預設: putting a character back in the pool removes its entry, which held nothing else', () => {
    const store = load();
    store.patch(setPool(0, 'pack-a/char-a', false));

    store.patch(setPool(1, 'pack-a/char-a', true));

    expect(store.get().values.fixedOverrides).toStrictEqual({});
    expect(flushedFile().fixedOverrides).toStrictEqual({});
  });

  it('改回預設: putting one character back removes only its entry; a neighbour is kept as it was', () => {
    writeFile({
      schemaVersion: 1,
      fixedOverrides: {
        'pack-a/char-a': { inPool: false },
        'pack-a/char-b': {},
      },
    });
    const store = load();

    store.patch(setPool(0, 'pack-a/char-a', true));

    expect(store.get().values.fixedOverrides).toStrictEqual({
      'pack-a/char-b': {},
    });
  });

  it('加入池子: taking one character out of the pool changes only <packId>/<characterId>', () => {
    writeFile({
      schemaVersion: 1,
      fixedOverrides: {
        'pack-b/char-a': { inPool: false },
      },
    });
    const store = load();

    store.patch(setPool(0, 'pack-a/char-a', false));

    const { values } = store.get();
    expect(values.fixedOverrides).toStrictEqual({
      'pack-a/char-a': { inPool: false },
      'pack-b/char-a': { inPool: false },
    });
    expect(isInPool(values, 'pack-a', 'char-a')).toBe(false);
    expect(isInPool(values, 'pack-a', 'char-b')).toBe(true);
    expect(isInPool(values, 'pack-b', 'char-a')).toBe(false);
    expect(values.packEnabled).toStrictEqual({});
    expect(flushedFile().fixedOverrides).toStrictEqual({
      'pack-a/char-a': { inPool: false },
      'pack-b/char-a': { inPool: false },
    });
  });

  it('加入池子: works the same while the pack is not 上場', () => {
    const store = load();
    store.patch(setPack(0, 'pack-a', false));

    store.patch(setPool(1, 'pack-a/char-a', false));

    expect(store.get().values.fixedOverrides).toStrictEqual({
      'pack-a/char-a': { inPool: false },
    });
    expect(store.get().values.packEnabled).toStrictEqual({ 'pack-a': false });
  });

  it('舊值合併: a patch at an old baseRev changes only its own key and keeps the newer change of another', () => {
    const store = load();
    store.patch(setPack(0, 'pack-a', false));
    store.patch(setPool(1, 'pack-a/char-a', false));

    const result = store.patch(setPack(0, 'pack-b', false));
    const pool = store.patch(setPool(1, 'pack-a/char-b', false));

    expect(result).toStrictEqual({ rev: 3, merged: true, saved: true });
    expect(pool).toStrictEqual({ rev: 4, merged: true, saved: true });
    expect(store.get().values.packEnabled).toStrictEqual({
      'pack-a': false,
      'pack-b': false,
    });
    expect(store.get().values.fixedOverrides).toStrictEqual({
      'pack-a/char-a': { inPool: false },
      'pack-a/char-b': { inPool: false },
    });
  });

  it('舊值合併: on the same key, the later patch wins even at an older baseRev', () => {
    const store = load();
    store.patch(setPack(0, 'pack-a', false));

    store.patch(setPack(0, 'pack-a', true));

    expect(store.get()).toStrictEqual({ rev: 2, values: SETTINGS_DEFAULTS });
  });

  it('換版本: settings of a character gone from the new version are kept while other keys change', () => {
    // main/settings does not know what is installed: a pack replaced by
    // a version without char-old keeps that character's entry.
    writeFile({
      schemaVersion: 1,
      packEnabled: { 'pack-a': false },
      fixedOverrides: { 'pack-a/char-old': { inPool: false } },
    });
    const store = load();

    store.patch(setPool(0, 'pack-a/char-new', false));

    expect(flushedFile()).toStrictEqual({
      schemaVersion: 1,
      ...SETTINGS_DEFAULTS,
      packEnabled: { 'pack-a': false },
      fixedOverrides: {
        'pack-a/char-new': { inPool: false },
        'pack-a/char-old': { inPool: false },
      },
    });
  });

  it('沒安裝的設定: entries of packs that are not installed load, stay and are written back as they are', () => {
    const text = writeFile({
      schemaVersion: 1,
      packEnabled: { 'gone-pack': false },
      fixedOverrides: { 'gone-pack/char-a': { inPool: false } },
    });
    const store = load();

    expect(store.get().values.packEnabled).toStrictEqual({
      'gone-pack': false,
    });
    expect(files()).toStrictEqual(['settings.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);

    store.patch(setPack(0, 'pack-a', false));

    const written = flushedFile();
    expect(written.packEnabled).toStrictEqual({
      'gone-pack': false,
      'pack-a': false,
    });
    expect(written.fixedOverrides).toStrictEqual({
      'gone-pack/char-a': { inPool: false },
    });
  });

  it('舊設定檔: a schemaVersion 1 file without the two fields loads with them empty, nothing backed up or rewritten', () => {
    const { packEnabled: _p, fixedOverrides: _f, ...before } = CUSTOM_VALUES;
    const text = writeFile({ schemaVersion: 1, ...before });

    const store = load();

    expect(store.get()).toStrictEqual({
      rev: 0,
      values: { ...before, packEnabled: {}, fixedOverrides: {} },
    });
    expect(isPackEnabled(store.get().values, 'pack-a')).toBe(true);
    expect(isInPool(store.get().values, 'pack-a', 'char-a')).toBe(true);
    expect(store.canWrite).toBe(true);
    vi.runAllTimers();
    expect(files()).toStrictEqual(['settings.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(settingsLines()).toStrictEqual([]);
  });

  it.each([
    ['packEnabled', 'a bad pack id', { 'pack-a': false, Bad_Key: false }],
    ['packEnabled', 'a value that is not a boolean', { 'pack-a': 'off' }],
    ['packEnabled', 'an own __proto__ key', '{"__proto__": false}'],
    [
      'packEnabled',
      `more than ${PACK_ENABLED_MAX_ENTRIES} entries`,
      Object.fromEntries(
        Array.from({ length: PACK_ENABLED_MAX_ENTRIES + 1 }, (_, i) => [
          `pack-${i}`,
          false,
        ]),
      ),
    ],
    [
      'fixedOverrides',
      'a key that is not <packId>/<characterId>',
      { 'pack-a/char-a': { inPool: false }, 'pack-a': { inPool: false } },
    ],
    [
      'fixedOverrides',
      'an unknown parameter',
      { 'pack-a/char-a': { inPool: false, speed: 'fast' } },
    ],
    [
      'fixedOverrides',
      'a non-boolean inPool',
      { 'pack-a/char-a': { inPool: 0 } },
    ],
  ])(
    '壞設定: %s with %s takes its default whole and is backed up; the other fields are kept',
    (field, _label, bad) => {
      const good = {
        packEnabled: { 'pack-z': false },
        fixedOverrides: { 'pack-z/char-z': { inPool: false } },
      };
      const text =
        typeof bad === 'string'
          ? `{"schemaVersion": 1, "doneMs": 8000, ${JSON.stringify(field === 'packEnabled' ? 'fixedOverrides' : 'packEnabled')}: ${JSON.stringify(field === 'packEnabled' ? good.fixedOverrides : good.packEnabled)}, ${JSON.stringify(field)}: ${bad}}`
          : JSON.stringify({
              schemaVersion: 1,
              doneMs: 8000,
              ...good,
              [field]: bad,
            });
      writeFile(text);

      const store = load();

      const expected = {
        ...SETTINGS_DEFAULTS,
        doneMs: 8000,
        ...good,
        [field]: {},
      };
      expect(store.get().values).toStrictEqual(expected);
      expect(files()).toStrictEqual(['settings.json', BACKUP]);
      expect(fs.readFileSync(path.join(dir, BACKUP), 'utf8')).toBe(text);
      expect(readFile()).toStrictEqual({ schemaVersion: 1, ...expected });
      expect(logged('warn')).toStrictEqual([
        `[settings] settings.json has bad fields (invalid: ${field}); copied it to ${BACKUP}, using defaults for invalid fields, dropping unknown ones`,
      ]);
      expect(settingsLines().join('\n')).not.toContain('Bad_Key');
    },
  );

  it.each([
    ['an upper-case pack id', setPack(0, 'Pack-A', false)],
    ['an all-digit pack id', setPack(0, '123', false)],
    ['a character key as a pack id', setPack(0, 'pack-a/char-a', false)],
    ['a pack id as a character key', setPool(0, 'pack-a', false)],
    ['a character key with three parts', setPool(0, 'pack-a/b/c', false)],
    ['a bad character id', setPool(0, 'pack-a/Char', false)],
    [
      'a setPackEnabled value that is not a boolean',
      {
        baseRev: 0,
        ops: [{ op: 'setPackEnabled', packId: 'pack-a', value: 'false' }],
      },
    ],
    [
      'a setFixed value that is not a boolean',
      {
        baseRev: 0,
        ops: [
          {
            op: 'setFixed',
            characterKey: 'pack-a/char-a',
            param: 'inPool',
            value: 0,
          },
        ],
      },
    ],
    [
      'a setFixed of a parameter not kept yet',
      {
        baseRev: 0,
        ops: [
          {
            op: 'setFixed',
            characterKey: 'pack-a/char-a',
            param: 'scale',
            value: 1.5,
          },
        ],
      },
    ],
    [
      'a set overwriting packEnabled whole',
      {
        baseRev: 0,
        ops: [{ op: 'set', field: 'packEnabled', value: { 'pack-a': false } }],
      },
    ],
    [
      'a set overwriting fixedOverrides whole',
      {
        baseRev: 0,
        ops: [{ op: 'set', field: 'fixedOverrides', value: {} }],
      },
    ],
    [
      'a good op next to a bad one',
      {
        baseRev: 0,
        ops: [
          { op: 'setPackEnabled', packId: 'pack-a', value: false },
          { op: 'setPackEnabled', packId: 'Pack-B', value: false },
        ],
      },
    ],
  ])(
    '壞輸入: answers invalid-input to a patch with %s and changes nothing',
    async (_label, patch) => {
      fake.resetFakeElectron();
      const store = load();
      const onChange = vi.fn();
      store.onChange(onChange);
      registerSettingsHandlers(store, NO_BATCH);

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

  it.each([
    ['a pack over the most 上場 entries', setPack(0, 'pack-new', false)],
    [
      'a character over the most fixed-parameter entries',
      setPool(0, 'pack-new/char-new', false),
    ],
    [
      'a patch whose first op fits and whose second does not',
      {
        baseRev: 0,
        ops: [
          { op: 'setPackEnabled', packId: 'pack-0', value: true },
          { op: 'setPackEnabled', packId: 'pack-new', value: false },
          { op: 'setPackEnabled', packId: 'pack-newer', value: false },
        ],
      } satisfies SettingsPatch,
    ],
  ])(
    '超過上限: the store throws on %s and changes nothing',
    (_label, patch) => {
      writeFile(fullFile());
      const store = load();
      const before = store.get();
      const onChange = vi.fn();
      store.onChange(onChange);

      expect(() => store.patch(patch)).toThrow();

      expect(store.get().rev).toBe(0);
      expect(store.get().values).toBe(before.values);
      expect(onChange).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(readFile()).toStrictEqual(fullFile());
      expect(logged('warn')).toHaveLength(1);
      expect(logged('warn')[0]).toMatch(
        /^\[settings\] patch refused: it would leave (packEnabled|fixedOverrides) failing the schema/,
      );
      expect(logged('warn')[0]).not.toContain('pack-new');
    },
  );

  it('超過上限: answers handler-failed over IPC, the values unchanged', async () => {
    fake.resetFakeElectron();
    writeFile(fullFile());
    const store = load();
    registerSettingsHandlers(store, NO_BATCH);

    const reply = await fake.ipcRenderer.invoke(
      settingsPatch.channel,
      setPack(0, 'pack-new', false),
    );

    expect(reply).toStrictEqual({
      ok: false,
      error: { code: 'handler-failed', message: 'handler failed' },
    });
    expect(store.get().rev).toBe(0);
    expect(isPackEnabled(store.get().values, 'pack-new')).toBe(true);
  });

  it('超過上限: a patch with a set and a keyed op over the limit throws whole; neither field changes (values, rev, file)', () => {
    writeFile(fullFile());
    const store = load();
    const before = store.get();
    const onChange = vi.fn();
    store.onChange(onChange);

    expect(() =>
      store.patch({
        baseRev: 0,
        ops: [
          { op: 'set', field: 'doneMs', value: 8000 },
          { op: 'setPackEnabled', packId: 'pack-new', value: false },
        ],
      }),
    ).toThrow();

    expect(store.get().rev).toBe(0);
    expect(store.get().values).toBe(before.values);
    expect(store.get().values.doneMs).toBe(SETTINGS_DEFAULTS.doneMs);
    expect(isPackEnabled(store.get().values, 'pack-new')).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(readFile()).toStrictEqual(fullFile());
    expect(logged('warn')).toStrictEqual([
      '[settings] patch refused: it would leave packEnabled failing the schema; nothing changed',
    ]);
  });

  it('超過上限: still changes a key already there, or removes one, at the most entries', () => {
    writeFile(fullFile());
    const store = load();

    store.patch(setPack(0, 'pack-0', true));
    store.patch(setPack(1, 'pack-new', false));
    store.patch(setPool(2, 'pack-0/char-0', true));
    store.patch(setPool(3, 'pack-new/char-new', false));

    const { values } = store.get();
    expect(Object.keys(values.packEnabled)).toHaveLength(
      PACK_ENABLED_MAX_ENTRIES,
    );
    expect(isPackEnabled(values, 'pack-0')).toBe(true);
    expect(isPackEnabled(values, 'pack-new')).toBe(false);
    expect(Object.keys(values.fixedOverrides)).toHaveLength(
      FIXED_OVERRIDES_MAX_ENTRIES,
    );
    expect(isInPool(values, 'pack-new', 'char-new')).toBe(false);
  });
});
