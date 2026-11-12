/**
 * main/persist's file helpers on an injected fake fs: what main/settings'
 * and main/pool's own tests cannot reach with real files.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  brokenBackupPath,
  renameBroken,
  writeFileAtomic,
  type AtomicWriteFs,
} from '../../src/main/persist/files';

/** Local time, so the suffix below is the same in every time zone. */
const NOW = new Date(2026, 10, 12, 9, 30, 5).getTime();
const FILE = '/data/assignments.json';
const BASE = `${FILE}.broken-20261112-093005`;

/** An AtomicWriteFs that records its calls; overrides make one fail. */
function fakeFs(overrides: Partial<AtomicWriteFs> = {}) {
  const calls: string[] = [];
  const fs: AtomicWriteFs = {
    mkdirSync: vi.fn((dir: string, options: { recursive: true }) => {
      calls.push(`mkdir ${dir} ${JSON.stringify(options)}`);
    }),
    writeFileSync: vi.fn((file: string) => {
      calls.push(`write ${file}`);
    }),
    renameSync: vi.fn((from: string, to: string) => {
      calls.push(`rename ${from} ${to}`);
    }),
    unlinkSync: vi.fn((file: string) => {
      calls.push(`unlink ${file}`);
    }),
    ...overrides,
  };
  return { fs, calls };
}

describe('writeFileAtomic', () => {
  it('creates the folder if needed, writes the temp file with flush, then renames it over the file', () => {
    const { fs, calls } = fakeFs();

    writeFileAtomic(fs, FILE, '{}\n');

    expect(calls).toStrictEqual([
      'mkdir /data {"recursive":true}',
      `write ${FILE}.tmp`,
      `rename ${FILE}.tmp ${FILE}`,
    ]);
    expect(fs.writeFileSync).toHaveBeenCalledWith(`${FILE}.tmp`, '{}\n', {
      encoding: 'utf8',
      flush: true,
    });
  });

  it('removes the temp file and throws the original error when the rename fails', () => {
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const { fs, calls } = fakeFs({
      renameSync: () => {
        throw busy;
      },
    });

    expect(() => writeFileAtomic(fs, FILE, '{}\n')).toThrow(busy);
    expect(calls.at(-1)).toBe(`unlink ${FILE}.tmp`);
  });

  it('still throws the original error when removing the temp file fails too', () => {
    const full = Object.assign(new Error('full'), { code: 'ENOSPC' });
    const { fs } = fakeFs({
      writeFileSync: () => {
        throw full;
      },
      unlinkSync: () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      },
    });

    expect(() => writeFileAtomic(fs, FILE, '{}\n')).toThrow(full);
  });
});

describe('brokenBackupPath and renameBroken', () => {
  it('names the local second, then -2, -3… when that name is taken', () => {
    const taken = new Set([BASE, `${BASE}-2`]);
    const fs = { existsSync: (file: string) => taken.has(file) };

    expect(brokenBackupPath({ existsSync: () => false }, FILE, NOW)).toBe(BASE);
    expect(brokenBackupPath(fs, FILE, NOW)).toBe(`${BASE}-3`);
  });

  it('throws "no free backup name" once every suffix up to -999 is taken', () => {
    const existsSync = vi.fn(() => true);

    expect(() => brokenBackupPath({ existsSync }, FILE, NOW)).toThrow(
      'no free backup name',
    );
    // The bare name, then -2 to -999.
    expect(existsSync).toHaveBeenCalledTimes(999);
    expect(existsSync).toHaveBeenLastCalledWith(`${BASE}-999`);
  });

  it('renameBroken moves the file to the free name and answers it; with none free it renames nothing', () => {
    const renameSync = vi.fn();

    expect(
      renameBroken({ existsSync: () => false, renameSync }, FILE, NOW),
    ).toBe(BASE);
    expect(renameSync).toHaveBeenCalledExactlyOnceWith(FILE, BASE);

    renameSync.mockClear();
    expect(() =>
      renameBroken({ existsSync: () => true, renameSync }, FILE, NOW),
    ).toThrow('no free backup name');
    expect(renameSync).not.toHaveBeenCalled();
  });
});
