/**
 * main/detection/adapters/claude-code/read: reading a transcript file a
 * piece at a time (Story 2.4), read-only. A transcript is JSON Lines that
 * Claude Code appends to; a read takes the bytes from where the last one
 * stopped to the file's end. A line is complete once its `\n` is there;
 * the bytes after the last `\n` wait for the next read.
 *
 * A tail read (replay) starts REPLAY_TAIL_BYTES before the end, in the
 * middle of a line unless the byte before it is `\n`; that partial line is
 * skipped up to its `\n`.
 */
import { Buffer } from 'node:buffer';

/** The parts of a file's stats the adapter reads. */
export interface TranscriptStats {
  readonly size: number;
  readonly mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** A directory entry, as `readdirSync(dir, { withFileTypes: true })` gives it. */
export interface TranscriptDirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/**
 * The parts of node:fs the adapter uses: listing folders, stats, and
 * opening files to read. Nothing here writes. Tests inject failures.
 */
export interface TranscriptFs {
  readdirSync(
    dir: string,
    options: { withFileTypes: true },
  ): readonly TranscriptDirent[];
  statSync(file: string): TranscriptStats;
  /** The path with symbolic links resolved (for the projects folder). */
  realpathSync(file: string): string;
  openSync(file: string, flags: 'r'): number;
  fstatSync(fd: number): TranscriptStats;
  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  closeSync(fd: number): void;
}

const NEWLINE = 0x0a;

/** Where an unread line stands between two reads. */
export interface LineCarry {
  /** Bytes after the last `\n` read: the start of an incomplete line. */
  readonly rest: Buffer;
  /**
   * The line being read started before the bytes read (a tail read starts
   * mid-line): everything up to its `\n` is skipped.
   */
  readonly skipping: boolean;
}

/** Nothing pending: the next byte starts a line. */
export const NO_CARRY: LineCarry = Object.freeze({
  rest: Buffer.alloc(0),
  skipping: false,
});

/**
 * Where a tail read of a file of `size` bytes starts reading, and whether
 * the first line there is partial. It starts one byte early so that a tail
 * beginning right after a `\n` keeps its first line: that `\n` ends the
 * skipped part at once.
 */
export function tailRead(
  size: number,
  tailBytes: number,
): { readonly from: number; readonly carry: LineCarry } {
  const start = Math.max(0, size - tailBytes);
  return start === 0
    ? { from: 0, carry: NO_CARRY }
    : { from: start - 1, carry: { rest: Buffer.alloc(0), skipping: true } };
}

/**
 * The complete lines in `carry` followed by `chunk`, decoded as UTF-8 with
 * a trailing `\r` removed and empty lines left out, and what is pending
 * after them.
 */
export function splitLines(
  carry: LineCarry,
  chunk: Uint8Array,
): { readonly lines: readonly string[]; readonly carry: LineCarry } {
  const data =
    carry.rest.length === 0
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.concat([carry.rest, chunk]);
  let start = 0;
  if (carry.skipping) {
    const end = data.indexOf(NEWLINE);
    if (end === -1) {
      return { lines: [], carry: { rest: Buffer.alloc(0), skipping: true } };
    }
    start = end + 1;
  }
  const lines: string[] = [];
  for (;;) {
    const end = data.indexOf(NEWLINE, start);
    if (end === -1) {
      break;
    }
    const line = data.toString('utf8', start, end).replace(/\r$/, '');
    if (line !== '') {
      lines.push(line);
    }
    start = end + 1;
  }
  return {
    lines,
    carry: {
      // A copy: the pending bytes outlive this read's buffer.
      rest: Buffer.from(data.subarray(start)),
      skipping: false,
    },
  };
}

/**
 * Bytes `from` up to `to` of the open file `fd` (fewer if the file ends
 * sooner).
 */
export function readRange(
  fs: Pick<TranscriptFs, 'readSync'>,
  fd: number,
  from: number,
  to: number,
): Buffer {
  const length = Math.max(0, to - from);
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = fs.readSync(fd, buffer, done, length - done, from + done);
    if (read <= 0) {
      break;
    }
    done += read;
  }
  return buffer.subarray(0, done);
}
