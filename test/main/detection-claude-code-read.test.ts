/**
 * The Claude Code adapter's file reading (lines across reads, tails) and
 * which paths under the projects folder are transcripts (Story 2.4).
 */
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  shouldWatch,
  transcriptAt,
} from '../../src/main/detection/adapters/claude-code/paths';
import {
  type LineCarry,
  NO_CARRY,
  readRange,
  splitLines,
  tailRead,
} from '../../src/main/detection/adapters/claude-code/read';

const bytes = (text: string) => Buffer.from(text, 'utf8');

/** splitLines over `chunks`, one read each; the lines of each read. */
function readAll(
  chunks: readonly Uint8Array[],
  carry: LineCarry = NO_CARRY,
): { lines: string[][]; carry: LineCarry } {
  const lines: string[][] = [];
  let current = carry;
  for (const chunk of chunks) {
    const split = splitLines(current, chunk);
    lines.push([...split.lines]);
    current = split.carry;
  }
  return { lines, carry: current };
}

describe('splitLines', () => {
  it('gives the complete lines and keeps an incomplete last line for the next read', () => {
    const { lines, carry } = readAll([
      bytes('{"a":1}\n{"b"'),
      bytes(':2}\n{"c":'),
      bytes('3}\n'),
    ]);
    expect(lines).toStrictEqual([['{"a":1}'], ['{"b":2}'], ['{"c":3}']]);
    expect(carry.rest.length).toBe(0);
    expect(carry.skipping).toBe(false);
  });

  it('leaves out empty lines and a trailing \\r', () => {
    expect(readAll([bytes('a\r\n\n\r\nb\n')]).lines).toStrictEqual([
      ['a', 'b'],
    ]);
  });

  it('decodes a multi-byte character split across two reads', () => {
    const all = bytes('{"t":"標題"}\n');
    const cut = 7; // inside 標
    expect(
      readAll([all.subarray(0, cut), all.subarray(cut)]).lines,
    ).toStrictEqual([[], ['{"t":"標題"}']]);
  });

  it('skipping: drops everything up to the first \\n, even across reads', () => {
    const skipping: LineCarry = { rest: Buffer.alloc(0), skipping: true };
    expect(
      readAll([bytes('tail of a line'), bytes(' still\n{"a":1}\n')], skipping)
        .lines,
    ).toStrictEqual([[], ['{"a":1}']]);
  });

  it('keeps the pending bytes as a copy, not a view of the chunk', () => {
    const chunk = bytes('x\npending');
    const { carry } = splitLines(NO_CARRY, chunk);
    chunk.fill(0);
    expect(carry.rest.toString()).toBe('pending');
  });
});

describe('tailRead', () => {
  it('a file no longer than the tail: from its start, nothing skipped', () => {
    expect(tailRead(100, 100)).toStrictEqual({ from: 0, carry: NO_CARRY });
    expect(tailRead(0, 100)).toStrictEqual({ from: 0, carry: NO_CARRY });
  });

  it('a longer one: one byte before the tail, skipping up to the first \\n', () => {
    const { from, carry } = tailRead(1000, 100);
    expect(from).toBe(899);
    expect(carry.skipping).toBe(true);
  });

  it('a tail starting right after a \\n keeps its first line', () => {
    const file = bytes('{"a":1}\n{"b":2}\n{"c":3}\n');
    // The last 16 bytes start exactly at {"b":2}.
    const { from, carry } = tailRead(file.length, 16);
    expect(splitLines(carry, file.subarray(from)).lines).toStrictEqual([
      '{"b":2}',
      '{"c":3}',
    ]);
  });

  it('a tail starting mid-line skips that line', () => {
    const file = bytes('{"a":1}\n{"b":2}\n{"c":3}\n');
    const { from, carry } = tailRead(file.length, 12);
    expect(splitLines(carry, file.subarray(from)).lines).toStrictEqual([
      '{"c":3}',
    ]);
  });
});

describe('readRange', () => {
  /** A file of `content` whose reads return at most `step` bytes each. */
  function fakeFile(content: Buffer, step: number) {
    return {
      readSync(
        _fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) {
        const n = Math.max(
          0,
          Math.min(length, step, content.length - position),
        );
        buffer.set(content.subarray(position, position + n), offset);
        return n;
      },
    };
  }

  it('reads the range in as many reads as it takes', () => {
    const content = bytes('0123456789');
    expect(readRange(fakeFile(content, 3), 1, 2, 9).toString()).toBe('2345678');
  });

  it('stops where the file ends', () => {
    const content = bytes('0123');
    expect(readRange(fakeFile(content, 10), 1, 2, 9).toString()).toBe('23');
    expect(readRange(fakeFile(content, 10), 1, 5, 3).length).toBe(0);
  });
});

describe('transcriptAt', () => {
  const root = path.join(path.sep, 'home-dir', '.claude', 'projects');
  const ID = '0a1b2c3d-0000-4000-8000-00000000abcd';
  const at = (...parts: string[]) => path.join(root, ...parts);

  it("a session's transcript: <cwd>/<uuid>.jsonl", () => {
    expect(transcriptAt(root, at('-work-gundam', `${ID}.jsonl`))).toStrictEqual(
      { kind: 'main', sessionId: ID },
    );
    expect(
      transcriptAt(root, at('-work-gundam', `${ID.toUpperCase()}.jsonl`)),
    ).toStrictEqual({ kind: 'main', sessionId: ID.toUpperCase() });
  });

  it("a subagent's transcript belongs to its session: <cwd>/<uuid>/subagents/<name>.jsonl", () => {
    expect(
      transcriptAt(root, at('-work-gundam', ID, 'subagents', 'agent-a1.jsonl')),
    ).toStrictEqual({ kind: 'subagent', sessionId: ID });
  });

  it.each([
    ['the root', []],
    ['a cwd folder', ['-work-gundam']],
    ['a file not named by a uuid', ['-work-gundam', 'agent-a1.jsonl']],
    ['not .jsonl', ['-work-gundam', `${ID}.json`]],
    ['at the root', [`${ID}.jsonl`]],
    ['too deep', ['-work-gundam', ID, 'subagents', 'x', 'a.jsonl']],
    ['not in subagents', ['-work-gundam', ID, 'tool-results', 'a.jsonl']],
    [
      'under a folder not named by a uuid',
      ['-work-gundam', 'x', 'subagents', 'a.jsonl'],
    ],
  ])('not a transcript: %s', (_label, parts) => {
    expect(transcriptAt(root, at(...parts))).toBeNull();
  });

  it('not below the root', () => {
    expect(
      transcriptAt(
        root,
        path.join(path.dirname(root), 'sessions', `${ID}.jsonl`),
      ),
    ).toBeNull();
    expect(
      transcriptAt(root, path.join(root, '..', 'x', `${ID}.jsonl`)),
    ).toBeNull();
  });
});

describe('shouldWatch', () => {
  const root = path.join(path.sep, 'home-dir', '.claude', 'projects');
  const ID = '0a1b2c3d-0000-4000-8000-00000000abcd';
  const at = (...parts: string[]) => path.join(root, ...parts);
  const file = (mtimeMs: number) => ({
    isFile: () => true,
    isDirectory: () => false,
    mtimeMs,
  });
  const dir = { isFile: () => false, isDirectory: () => true, mtimeMs: 0 };
  const recent = (mtimeMs: number) => mtimeMs >= 100;

  it('follows the root and the folders transcripts live in', () => {
    for (const entry of [
      root,
      at('-work-gundam'),
      at('-work-gundam', ID),
      at('-work-gundam', ID, 'subagents'),
    ]) {
      expect(shouldWatch(root, entry, dir, recent)).toBe(true);
      expect(shouldWatch(root, entry, undefined, recent)).toBe(true);
    }
  });

  it('follows transcripts only while they are recent', () => {
    for (const entry of [
      at('-work-gundam', `${ID}.jsonl`),
      at('-work-gundam', ID, 'subagents', 'agent-a1.jsonl'),
    ]) {
      expect(shouldWatch(root, entry, file(100), recent)).toBe(true);
      expect(shouldWatch(root, entry, file(99), recent)).toBe(false);
      // Asked by name first: kept until the stats say otherwise.
      expect(shouldWatch(root, entry, undefined, recent)).toBe(true);
    }
  });

  it.each([
    [
      'another folder in a session folder',
      ['-work-gundam', ID, 'tool-results'],
      dir,
    ],
    ['a folder not named by a uuid', ['-work-gundam', 'notes'], dir],
    ['another file', ['-work-gundam', 'notes.jsonl'], file(100)],
    [
      'a meta file next to a subagent',
      ['-work-gundam', ID, 'subagents', 'a.meta.json'],
      file(100),
    ],
    ['anything deeper', ['-work-gundam', ID, 'subagents', 'x', 'y'], dir],
    [
      'a transcript name that is a folder',
      ['-work-gundam', `${ID}.jsonl`],
      dir,
    ],
  ])('leaves alone %s', (_label, parts, stats) => {
    expect(shouldWatch(root, at(...parts), stats, recent)).toBe(false);
  });

  it('leaves alone what is outside the root, the folder holding it included', () => {
    expect(shouldWatch(root, path.dirname(root), dir, recent)).toBe(false);
    expect(
      shouldWatch(root, path.join(path.dirname(root), 'sessions'), dir, recent),
    ).toBe(false);
  });
});
