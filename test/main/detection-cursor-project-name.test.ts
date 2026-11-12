/**
 * A Cursor session's display name, read back from its project folder's
 * slug with stats only (Story 2.7). A fake `stat` stands in for the file
 * system: nothing real is touched, and the paths are POSIX or Windows ones
 * whatever the platform the tests run on.
 */
import { describe, expect, it } from 'vitest';
import {
  createProjectNames,
  findProjectFolder,
  PROJECT_NAME_MAX_STATS,
  type StatPath,
} from '../../src/main/detection/adapters/cursor/project-name';

/** A stat that knows `folders` (and `files`); records every path asked. */
function fakeStat(folders: readonly string[], files: readonly string[] = []) {
  const asked: string[] = [];
  const stat: StatPath = (file) => {
    asked.push(file);
    if (folders.includes(file)) {
      return { isDirectory: () => true };
    }
    if (files.includes(file)) {
      return { isDirectory: () => false };
    }
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  return { stat, asked };
}

const HOME = ['/Users', '/Users/me', '/Users/me/code'];

describe('findProjectFolder', () => {
  it('reads each - back as /, -, _, . or a space, by stats of folders', () => {
    const { stat } = fakeStat([...HOME, '/Users/me/code/my_app.v2 beta-x']);
    expect(
      findProjectFolder('Users-me-code-my-app-v2-beta-x', stat, 'darwin'),
    ).toBe('/Users/me/code/my_app.v2 beta-x');
  });

  it('a hidden folder: two - in a row', () => {
    const { stat } = fakeStat(['/Users', '/Users/me', '/Users/me/.config']);
    expect(findProjectFolder('Users-me--config', stat, 'darwin')).toBe(
      '/Users/me/.config',
    );
  });

  it('the whole path must be a folder: a folder named after a prefix does not end the search', () => {
    const { stat } = fakeStat([
      ...HOME,
      '/Users/me/code/gundam',
      '/Users/me/code/gundam-pet',
    ]);
    expect(findProjectFolder('Users-me-code-gundam-pet', stat, 'darwin')).toBe(
      '/Users/me/code/gundam-pet',
    );
  });

  it('tries / first, depth first: of two folders that both fit, the deeper one', () => {
    const { stat } = fakeStat([
      ...HOME,
      '/Users/me/code/gundam',
      '/Users/me/code/gundam/pet',
      '/Users/me/code/gundam-pet',
    ]);
    expect(findProjectFolder('Users-me-code-gundam-pet', stat, 'darwin')).toBe(
      '/Users/me/code/gundam/pet',
    );
  });

  it('goes folder by folder: a name of 1 token, then of 2 with each separator, ...; a stat each', () => {
    const { stat, asked } = fakeStat([]);
    expect(findProjectFolder('a-b', stat, 'darwin')).toBeNull();
    expect(asked).toStrictEqual(['/a', '/a-b', '/a_b', '/a.b', '/a b']);

    const deeper = fakeStat(['/a']);
    expect(findProjectFolder('a-b', deeper.stat, 'darwin')).toBeNull();
    expect(deeper.asked).toStrictEqual([
      '/a',
      '/a/b',
      '/a-b',
      '/a_b',
      '/a.b',
      '/a b',
    ]);
  });

  it.each([
    [
      'a home folder with underscores, a project name of several parts',
      'Users-a-b-c-code-my-app',
      [
        '/Users',
        '/Users/a_b_c',
        '/Users/a_b_c/code',
        '/Users/a_b_c/code/my-app',
      ],
      '/Users/a_b_c/code/my-app',
    ],
    [
      'the same home folder, a longer project name',
      'Users-a-b-c-code-xx-yyyy-parent',
      [
        '/Users',
        '/Users/a_b_c',
        '/Users/a_b_c/code',
        '/Users/a_b_c/code/xx-yyyy-parent',
      ],
      '/Users/a_b_c/code/xx-yyyy-parent',
    ],
    [
      'a dot in a folder halfway',
      'Users-a-b-work-x-y-z',
      ['/Users', '/Users/a.b', '/Users/a.b/work', '/Users/a.b/work/x-y-z'],
      '/Users/a.b/work/x-y-z',
    ],
  ])('%s: found, with few stats', (_label, slug, folders, expected) => {
    const { stat, asked } = fakeStat(folders);
    expect(findProjectFolder(slug, stat, 'darwin')).toBe(expected);
    expect(asked.length).toBeLessThan(40);
  });

  it('a file is not a folder', () => {
    const { stat } = fakeStat(['/Users', '/Users/me'], ['/Users/me/notes']);
    expect(findProjectFolder('Users-me-notes', stat, 'darwin')).toBeNull();
  });

  it(`gives up after ${PROJECT_NAME_MAX_STATS} stats`, () => {
    const { stat, asked } = fakeStat([]);
    expect(
      findProjectFolder('a-b-c-d-e-f-g-h-i-j-k-l', stat, 'darwin'),
    ).toBeNull();
    expect(asked).toHaveLength(PROJECT_NAME_MAX_STATS);

    // A folder name of 6 tokens is within reach; one of 7 is not.
    const six = fakeStat(['/a-b-c-d-e-f']);
    expect(findProjectFolder('a-b-c-d-e-f', six.stat, 'darwin')).toBe(
      '/a-b-c-d-e-f',
    );
    expect(six.asked).toHaveLength(1 + 4 + 16 + 64 + 256 + 1);
    const seven = fakeStat(['/a-b-c-d-e-f-g']);
    expect(findProjectFolder('a-b-c-d-e-f-g', seven.stat, 'darwin')).toBeNull();
    expect(seven.asked).toHaveLength(PROJECT_NAME_MAX_STATS);
  });

  it('a leading - (a path from the root) is left out', () => {
    const { stat } = fakeStat(['/Users', '/Users/me']);
    expect(findProjectFolder('-Users-me', stat, 'darwin')).toBe('/Users/me');
  });

  it('a stat that throws is a missing folder', () => {
    const stat: StatPath = () => {
      throw new Error('EACCES');
    };
    expect(findProjectFolder('Users-me', stat, 'darwin')).toBeNull();
  });

  it('nothing to read back: no stat at all', () => {
    const { stat, asked } = fakeStat([]);
    expect(findProjectFolder('', stat, 'darwin')).toBeNull();
    expect(findProjectFolder('---', stat, 'darwin')).toBeNull();
    expect(asked).toStrictEqual([]);
  });

  it('on Windows, the drive letter first', () => {
    const { stat } = fakeStat([
      'C:\\Users',
      'C:\\Users\\me',
      'C:\\Users\\me\\gundam-pet',
    ]);
    expect(findProjectFolder('c--Users-me-gundam-pet', stat, 'win32')).toBe(
      'C:\\Users\\me\\gundam-pet',
    );
    expect(findProjectFolder('C-Users-me-gundam-pet', stat, 'win32')).toBe(
      'C:\\Users\\me\\gundam-pet',
    );
  });
});

describe('createProjectNames', () => {
  it("names a session after the found folder's name, else after the slug", () => {
    const { stat } = fakeStat([...HOME, '/Users/me/code/gundam-pet']);
    const nameOf = createProjectNames(stat, 'darwin');
    expect(nameOf('Users-me-code-gundam-pet')).toBe('gundam-pet');
    expect(nameOf('Users-me-code-gone-project')).toBe(
      'Users-me-code-gone-project',
    );
  });

  it('works each slug out once', () => {
    const { stat, asked } = fakeStat([...HOME, '/Users/me/code/gundam-pet']);
    const nameOf = createProjectNames(stat, 'darwin');
    nameOf('Users-me-code-gundam-pet');
    nameOf('Users-me-code-gone');
    const count = asked.length;
    expect(nameOf('Users-me-code-gundam-pet')).toBe('gundam-pet');
    expect(nameOf('Users-me-code-gone')).toBe('Users-me-code-gone');
    expect(asked).toHaveLength(count);
  });
});
