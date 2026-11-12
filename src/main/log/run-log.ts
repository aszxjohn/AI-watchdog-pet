/**
 * The run log (FR22). main/log is the only writer under `userData/logs/`.
 *
 * - One file per local hour, named `YYYY-MM-DD-HH.log`. A DST change can put
 *   two clock hours into one file; that is accepted.
 * - One line per event: `<local ISO time with offset>\t<category>\t<message>`.
 *   Line breaks, tabs and other control characters in the message are
 *   escaped, and the line is cut at RUN_LOG_MAX_LINE_LENGTH.
 * - Lines are appended synchronously, so they land in call order. The first
 *   write to a file (each new hour, and the first write of a run) deletes the
 *   log files whose hour started more than RUN_LOG_RETENTION_MS ago; only
 *   names in the format above are touched, and one that cannot be deleted is
 *   skipped.
 * - Writing never throws. Every event also goes to the console; before
 *   initRunLog, or while the file cannot be written, the console is all
 *   there is.
 *
 * Callers log field names and reasons only: never settings values or file
 * contents.
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import {
  RUN_LOG_MAX_LINE_LENGTH,
  RUN_LOG_RETENTION_MS,
} from '../../shared/constants';
import { localHourStamp, localIsoTimestamp } from './local-time';

/** English codes only; the display layer translates. */
export type RunLogCategory =
  | 'app'
  | 'detection'
  | 'ipc'
  | 'pool'
  | 'settings'
  | 'stage-view'
  | 'windows';

export type ConsoleLevel = 'info' | 'warn' | 'error';

/** The parts of node:fs the run log uses; tests inject failures. */
export interface RunLogFs {
  appendFileSync(file: string, data: string, encoding: 'utf8'): void;
  mkdirSync(dir: string, options: { recursive: true }): unknown;
  readdirSync(dir: string): string[];
  unlinkSync(file: string): void;
}

export interface RunLogOptions {
  readonly dir: string;
  readonly now?: () => number;
  readonly fs?: RunLogFs;
}

export type RunLogWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface RunLog {
  /** Appends one line. Never throws. */
  write(category: RunLogCategory, message: string): RunLogWriteResult;
}

const LOG_FILE_NAME = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.log$/;
const TRUNCATION_MARK = '…[truncated]';

export function createRunLog({
  dir,
  now = Date.now,
  fs = nodeFs,
}: RunLogOptions): RunLog {
  let currentFile: string | undefined;

  return {
    write(category, message) {
      try {
        const at = new Date(now());
        const fileName = `${localHourStamp(at)}.log`;
        const opensFile = fileName !== currentFile;
        if (opensFile) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(
          path.join(dir, fileName),
          `${formatRunLogLine(at, category, message)}\n`,
          'utf8',
        );
        if (opensFile) {
          currentFile = fileName;
          removeExpiredLogs(fs, dir, at.getTime());
        }
        return { ok: true };
      } catch (error) {
        // Open the file again next time (mkdir included), in case the
        // folder was removed mid-hour.
        currentFile = undefined;
        return { ok: false, reason: errorCode(error) };
      }
    },
  };
}

/** One run log line, without the trailing newline. */
export function formatRunLogLine(
  at: Date,
  category: RunLogCategory,
  message: string,
): string {
  const prefix = `${localIsoTimestamp(at)}\t${category}\t`;
  return (
    prefix + escapeAndCut(message, RUN_LOG_MAX_LINE_LENGTH - prefix.length)
  );
}

/**
 * Escapes the message and cuts it to `room` UTF-16 code units, ending with
 * TRUNCATION_MARK when cut. Cuts fall between escaped characters, so neither
 * an escape sequence nor a surrogate pair is split.
 */
function escapeAndCut(message: string, room: number): string {
  const limit = Math.max(0, room - TRUNCATION_MARK.length);
  let out = '';
  let cutAt = -1;
  for (const char of message) {
    const piece = escapeChar(char);
    if (cutAt < 0 && out.length + piece.length > limit) {
      cutAt = out.length;
    }
    out += piece;
    if (out.length > room) {
      return out.slice(0, cutAt) + TRUNCATION_MARK;
    }
  }
  return out;
}

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** C0 and C1 controls, DEL, and the Unicode line and paragraph separators. */
function isControlChar(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

function escapeChar(char: string): string {
  const named = NAMED_ESCAPES[char];
  if (named !== undefined) {
    return named;
  }
  const code = char.charCodeAt(0);
  if (isControlChar(code)) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return char;
}

/** Start of the local hour a log file name stands for, or undefined. */
export function logFileStart(name: string): number | undefined {
  const match = LOG_FILE_NAME.exec(name);
  if (match === null) {
    return undefined;
  }
  const [year, month, day, hour] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) {
    return undefined;
  }
  return new Date(year, month - 1, day, hour).getTime();
}

function removeExpiredLogs(fs: RunLogFs, dir: string, nowMs: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const start = logFileStart(name);
    if (start === undefined || nowMs - start <= RUN_LOG_RETENTION_MS) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // Cannot delete it now; the next new file tries again.
    }
  }
}

/**
 * A short, content-free description of a thrown value for the log: the
 * Node error code (`ENOENT`, `EACCES`…) when there is one, else the error's
 * name. Never the message, which can quote file contents.
 */
export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') {
      return code;
    }
  }
  if (error instanceof Error) {
    return error.name;
  }
  return typeof error;
}

// ---------------------------------------------------------------------------
// The process-wide run log that main's modules write to.

let runLog: RunLog | undefined;
let failing = false;

/** Starts writing the run log under `dir` (`userData/logs`). */
export function initRunLog(dir: string): void {
  runLog = createRunLog({ dir });
  failing = false;
}

/**
 * Logs one event to the console at `consoleLevel` and, once initRunLog has
 * run, to the run log file. Never throws.
 */
export function logEvent(
  category: RunLogCategory,
  message: string,
  consoleLevel: ConsoleLevel = 'info',
): void {
  try {
    console[consoleLevel](`[${category}] ${message}`);
  } catch {
    // A console that throws must not take the caller down.
  }
  if (runLog === undefined) {
    return;
  }
  const result = runLog.write(category, message);
  if (!result.ok && !failing) {
    try {
      console.error(
        `[log] cannot write the run log (${result.reason}); logging to the console only`,
      );
    } catch {
      // As above.
    }
  }
  failing = !result.ok;
}
