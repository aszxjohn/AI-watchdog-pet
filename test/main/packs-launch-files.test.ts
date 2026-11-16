/**
 * main/packs/launch-files.ts (Story 3.2): which launch argument is a
 * `.awpet` to import, and the files held until the app is ready (macOS
 * `open-file` may come first). Real files in a temp folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLaunchFileQueue,
  isPackFile,
  PACK_FILE_EXTENSION,
  packFileFromArgv,
} from '../../src/main/packs/launch-files';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-launch-files-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An existing file `name` in the temp folder; answers its path. */
function file(name: string): string {
  const at = path.join(dir, name);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, 'zip');
  return at;
}

describe('isPackFile', () => {
  it('takes an existing regular file named .awpet, in any case', () => {
    expect(PACK_FILE_EXTENSION).toBe('.awpet');
    expect(isPackFile(file('a.awpet'))).toBe(true);
    expect(isPackFile(file('b.AWPET'))).toBe(true);
  });

  it.each([
    ['a missing file', () => path.join(dir, 'missing.awpet')],
    [
      'a folder',
      () => {
        fs.mkdirSync(path.join(dir, 'folder.awpet'));
        return path.join(dir, 'folder.awpet');
      },
    ],
    ['another extension', () => file('a.zip')],
    ['.awpet inside the name only', () => file('a.awpet.zip')],
    ['no extension', () => file('awpet')],
  ])('refuses %s', (_label, make) => {
    expect(isPackFile(make())).toBe(false);
  });

  it('refuses a file it cannot stat', () => {
    const fsImpl = {
      statSync: vi.fn(() => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
    };
    expect(isPackFile('/x/a.awpet', fsImpl)).toBe(false);
    expect(fsImpl.statSync).toHaveBeenCalledOnce();
  });

  it('does not stat a name that is not .awpet', () => {
    const fsImpl = { statSync: vi.fn(() => ({ isFile: () => true })) };
    expect(isPackFile('/x/a.txt', fsImpl)).toBe(false);
    expect(fsImpl.statSync).not.toHaveBeenCalled();
  });
});

describe('I/O matrix', () => {
  it('第二實例: the .awpet among a second launch arguments, the executable and switches skipped', () => {
    const pack = file('sample.awpet');

    expect(
      packFileFromArgv(['/Applications/App', '--inspect', '.', pack], '/repo'),
    ).toBe(pack);
  });

  it('第二實例: a relative argument is taken from the launch working folder', () => {
    const pack = file('sub/sample.awpet');

    expect(packFileFromArgv(['app', 'sub/sample.awpet'], dir)).toBe(pack);
  });

  it('啟動參數: only the first .awpet counts', () => {
    const first = file('first.awpet');
    file('second.awpet');

    expect(packFileFromArgv(['app', first, 'second.awpet'], dir)).toBe(first);
  });

  it.each<[string, () => unknown[]]>([
    ['no arguments but the executable', () => ['app']],
    ['other arguments', () => ['electron', '.', '--flag', file('notes.txt')]],
    ['a path that does not exist', () => ['app', 'missing.awpet']],
    [
      'a folder named .awpet',
      () => {
        fs.mkdirSync(path.join(dir, 'folder.awpet'));
        return ['app', 'folder.awpet'];
      },
    ],
    [
      'a .awpet given as a switch value',
      () => {
        file('x.awpet');
        return ['app', '--open=x.awpet', '-x.awpet'];
      },
    ],
    ['an empty argument and things that are not strings', () => ['', 1, null]],
  ])('不是 .awpet: none in %s', (_label, argv) => {
    expect(packFileFromArgv(argv(), dir)).toBeNull();
  });

  it('open-file: files added before ready wait, then go in the order they came; after ready, at once', () => {
    const opened: string[] = [];
    const queue = createLaunchFileQueue((at) => {
      opened.push(at);
    });

    queue.add('/a.awpet');
    queue.add('/b.awpet');
    expect(opened).toStrictEqual([]);

    queue.ready();
    expect(opened).toStrictEqual(['/a.awpet', '/b.awpet']);

    queue.add('/c.awpet');
    expect(opened).toStrictEqual(['/a.awpet', '/b.awpet', '/c.awpet']);

    // A second ready() hands nothing again.
    queue.ready();
    expect(opened).toHaveLength(3);
  });

  it('open-file: one that throws is reported and does not stop the others', () => {
    const opened: string[] = [];
    const errors: unknown[] = [];
    const queue = createLaunchFileQueue(
      (at) => {
        opened.push(at);
        if (at === '/a.awpet') {
          throw new Error('cannot open');
        }
      },
      (error) => {
        errors.push(error);
      },
    );

    queue.add('/a.awpet');
    queue.add('/b.awpet');
    queue.ready();
    queue.add('/a.awpet');

    expect(opened).toStrictEqual(['/a.awpet', '/b.awpet', '/a.awpet']);
    expect(errors).toHaveLength(2);
  });
});
