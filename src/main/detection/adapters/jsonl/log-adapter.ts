/**
 * main/detection/adapters/jsonl/log-adapter: the part of an adapter that
 * follows an AI tool's transcripts, JSON Lines files the tool appends
 * records to, under one records folder (Story 2.4; shared since Story
 * 2.6). The source hands in what is its own (JsonlLogAdapterOptions):
 * which files are transcripts and what each one is, which paths the
 * watcher follows and how deep, the initial scan, the translation of a
 * record into shared events (one translation state per transcript), the
 * display name event, a gate before a transcript is read, and optionally
 * a transcript's starting state from its first line.
 *
 * Read-only: it lists folders, takes stats, and opens only the transcripts
 * `locate` names, to read. It writes nothing, runs nothing and connects to
 * nothing.
 *
 * - Start: with no records folder, health `missing` and `sync.ready` at
 *   once. Otherwise the folder (symbolic links resolved) is watched, and
 *   health is `ok` once the watcher started. When its initial scan is
 *   done, the adapter replays every transcript the source's scan found
 *   that was modified within discoveryWindowMs (the last REPLAY_TAIL_BYTES
 *   of each, events marked `replay: true`; group by group, in the scan's
 *   order), then sends `sync.ready`.
 * - While the folder is missing (at start, or removed while running: the
 *   watcher is closed then), the adapter checks for it every
 *   RECORDS_FOLDER_RECHECK_MS; once it is there, it is watched and replayed
 *   as at start (no second `sync.ready`).
 * - Then, each time a transcript changes, it reads from where it stopped
 *   to the end; an incomplete last line waits for the next read. A
 *   transcript it has not read yet is read from its start when it was
 *   created after the initial scan and is no longer than the tail, and
 *   replayed from its tail otherwise (a resumed session). One that got
 *   smaller is logged and replayed from its tail again (but see
 *   `rereadShrunk` below). A transcript the gate holds back is skipped,
 *   and not followed, until the gate lets it through.
 * - With `rereadShrunk` (Story 2.7: a source whose tool may write a
 *   transcript anew, whole), the adapter keeps a short hash of each
 *   complete line it has read from a transcript's start (of about its
 *   first REPLAY_TAIL_BYTES; none for a transcript first read from its
 *   tail). A transcript that got smaller, and is no longer than
 *   REPLAY_TAIL_BYTES, is then logged (with counts) and read again from
 *   its start, from the translation state it had, not replayed (`replay:
 *   false`): its lines are matched against those read before, in order,
 *   and the ones equal to them are skipped (their events were sent) until
 *   the first that differs; it and every line after it are translated.
 *   The matching ends with that read, unless the transcript was empty
 *   then (emptied, to be written anew): then it goes on at the next
 *   reads, until a line differs or every line read before has matched. A
 *   transcript first read from its tail, or longer than REPLAY_TAIL_BYTES
 *   once smaller, is replayed from its tail as above.
 * - A trailing read (Story 2.6): chokidar reports at most one `change` of
 *   a path per 50 ms, so a record written right after another would wait
 *   for the file's next write. After every read caused by a change, the
 *   file is read once more TRAILING_READ_MS later (one timer per file,
 *   moved later by each change of it); one that finds nothing new does
 *   nothing. The timers are cancelled when the watcher closes, the
 *   transcripts are forgotten, or the adapter stops, and one left from an
 *   older watcher reads nothing.
 * - With `startState` (Story 2.6), a transcript not followed yet is first
 *   read for its first line (at most FIRST_LINE_MAX_BYTES of its start,
 *   whatever part of it is read next), and the state it gives is the
 *   transcript's starting state; with none, the transcript is not
 *   followed and nothing is sent, and it is tried again at its next
 *   change (a first line that is a complete record but no start is logged,
 *   once per transcript). Without `startState`, every transcript starts at
 *   `initialState`.
 * - Everything one read produced reaches main/detection in one emit, so
 *   the panel is updated once per read. A read that produced events ends
 *   with the source's name event, so a session that comes back after
 *   expiring keeps its name.
 * - Health: `missing` while there is no records folder; otherwise
 *   `degraded` while the last BAD_LINE_STREAK_DEGRADED lines read (across
 *   transcripts) were all bad, or once the watcher failed to start or
 *   reported an error (until the folder is watched again); otherwise `ok`.
 *   Bad lines are skipped and counted, never thrown on; the next good
 *   record ends the streak.
 * - It never ends a session itself: it sends no `session.end` of its own
 *   (a session ends when main/detection/sessions expires it, or when a
 *   source's translation reads one ending in its records).
 * - The source's callbacks may throw; none of it reaches the watcher or
 *   stops a replay (Story 2.6). A `follow` that throws does not follow
 *   that path; a `scan` that throws finds no transcripts (`sync.ready` is
 *   still sent); a `locate`, `gate.allows` or `startState` that throws
 *   skips that transcript; a `translate` that throws counts that line as
 *   unreadable and reading goes on with the next; a `nameEvent`,
 *   `gate.read` or `gate.reset` that throws loses nothing else: the events
 *   read are still sent. Each is logged by callback and error code, once
 *   per pair.
 *
 * The log gets codes and counts only, never a path or a record's content.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';
import {
  BAD_LINE_STREAK_DEGRADED,
  FIRST_LINE_MAX_BYTES,
  RECORDS_FOLDER_RECHECK_MS,
  REPLAY_TAIL_BYTES,
  TRAILING_READ_MS,
} from '../../../../shared/constants';
import type { DetectionEvent } from '../../../../shared/detection-events';
import type { AdapterHealth, SourceCode } from '../../../../shared/sources';
import { errorCode, logEvent, type ConsoleLevel } from '../../../log/run-log';
import type { AdapterContext, DetectionAdapter } from '../../adapter';
import {
  type LineCarry,
  NO_CARRY,
  readRange,
  splitLines,
  tailRead,
  type TranscriptDirent,
  type TranscriptFs,
} from './read';
import { type Fields, parseRecordLine } from './records';
import {
  type TranscriptWatcher,
  type WatchedStats,
  type WatchTranscripts,
  watchWithChokidar,
} from './watcher';

/** REPLAY_TAIL_BYTES for the log. */
const TAIL_SIZE =
  REPLAY_TAIL_BYTES % (1024 * 1024) === 0
    ? `${REPLAY_TAIL_BYTES / (1024 * 1024)} MiB`
    : `${REPLAY_TAIL_BYTES} bytes`;

/** What every record of one read shares, besides which transcript it is. */
export interface ReadFacts {
  /** The records are replayed: their events carry `replay: true`. */
  readonly replay: boolean;
  /**
   * The `ts` of a record when neither it nor any earlier record of the
   * transcript has a timestamp: the file's modification time, epoch ms.
   */
  readonly fallbackTs: number;
}

/** Where the records of one read come from: `locate`'s answer and ReadFacts. */
export type ReadContext<Where> = Where & ReadFacts;

/** One record translated, and the transcript's state after it. */
export interface RecordTranslation<State> {
  readonly state: State;
  readonly events: readonly DetectionEvent[];
}

/** Transcripts the initial scan found, replayed together. */
export interface ScanGroup {
  /** What they are, for the log (`sessions`). */
  readonly label: string;
  readonly files: readonly string[];
}

/**
 * Decides, before a transcript is opened, whether it is read now (a source
 * may hold some back until others were read). The adapter tells it what
 * it read and when it forgot everything.
 */
export interface ReadGate<Where, State> {
  /**
   * Whether transcript `where` is read now; `tracked` when it is followed
   * already (read before).
   */
  allows(where: Where, tracked: boolean): boolean;
  /** Transcript `where` was read; its translation state is now `state`. */
  read(where: Where, state: State): void;
  /** Every transcript was forgotten (the folder went away, or a stop). */
  reset(): void;
}

export interface JsonlLogAdapterOptions<Where extends object, State> {
  /** The source whose transcripts these are; its events and health. */
  readonly source: SourceCode;
  /** Every run log line starts with `<logPrefix>: `. */
  readonly logPrefix: string;
  /** The records folder the transcripts are under. */
  readonly root: string;
  /** What the run log calls the records folder (`projects folder`). */
  readonly rootName: string;
  /** The file system, read-only (default node:fs). */
  readonly fs?: TranscriptFs | undefined;
  /** Starts the watcher (default chokidar). */
  readonly watch?: WatchTranscripts | undefined;
  /** How many folders below the root the watcher looks. */
  readonly watchDepth: number;
  /**
   * What transcript `file` (below `root`, symbolic links resolved) is: the
   * source's own facts about it, handed to the gate and the translation;
   * null when it is none (it is never opened).
   */
  readonly locate: (root: string, file: string) => Where | null;
  /**
   * Whether the watcher follows `entry` (stats as the watcher has them;
   * `recent(mtimeMs)` is the discovery window).
   */
  readonly follow: (
    root: string,
    entry: string,
    stats: WatchedStats | undefined,
    recent: (mtimeMs: number) => boolean,
  ) => boolean;
  /**
   * Every transcript under `root` (listed with `list`, which never
   * throws), in groups replayed one after the other.
   */
  readonly scan: (
    root: string,
    list: (dir: string) => readonly TranscriptDirent[],
  ) => readonly ScanGroup[];
  /**
   * The translation state of a transcript nothing has been read from, when
   * there is no `startState`.
   */
  readonly initialState: State;
  /**
   * The starting state of a transcript not followed yet, from its first
   * line: `first` is that line's record, null when the line is not a
   * record or not complete within FIRST_LINE_MAX_BYTES. Null when the
   * transcript is not to be followed yet: nothing is sent, and it is tried
   * again at its next change. Without it, every transcript starts at
   * `initialState`.
   */
  readonly startState?:
    | ((first: Fields | null, context: ReadContext<Where>) => State | null)
    | undefined;
  /** The events `record` stands for, and the transcript's state after it. */
  readonly translate: (
    record: Fields,
    state: State,
    context: ReadContext<Where>,
  ) => RecordTranslation<State>;
  /**
   * Sent at the end of a read that produced events: the session's current
   * display name; null when there is none to send.
   */
  readonly nameEvent: (
    state: State,
    context: ReadContext<Where>,
  ) => DetectionEvent | null;
  /** Before a transcript is opened (default: every one is read). */
  readonly gate?: ReadGate<Where, State> | undefined;
  /**
   * A transcript that got smaller is read again from its start, skipping
   * the lines read before (Story 2.7; see the module comment), instead of
   * replayed from its tail. Without it, it is replayed from its tail.
   */
  readonly rereadShrunk?: true | undefined;
}

/**
 * With `rereadShrunk`: the lines read from a transcript's start, as short
 * hashes, to tell the lines read before from new ones once it gets smaller.
 * Its arrays belong to that one transcript and grow as it is read.
 */
interface LineHashes {
  /**
   * The hash of each complete line read from the transcript's start, in
   * order, while `bytes` is within REPLAY_TAIL_BYTES: the lines a
   * transcript no longer than that can share with it.
   */
  readonly read: string[];
  /** The bytes of the lines hashed in `read` (newlines included). */
  bytes: number;
  /**
   * After the transcript got smaller: the hashes of the lines read before
   * that, which the lines read from its start again are matched against
   * (`read.length` of them matched so far); null when not matching.
   */
  before: readonly string[] | null;
}

/** A line's short hash, to compare lines with those read before. */
function lineHash(line: string): string {
  return createHash('sha256').update(line).digest('base64').slice(0, 12);
}

/** A transcript being followed. */
interface TrackedFile<State> {
  /** Where the next read starts. */
  readonly offset: number;
  readonly carry: LineCarry;
  readonly state: State;
  /**
   * With `rereadShrunk`, the lines read from the start; null without it,
   * or when the transcript was first read from its tail.
   */
  readonly hashes: LineHashes | null;
}

/** Why a transcript is read. */
type ReadReason = 'initial-replay' | 'change';

interface Found {
  readonly file: string;
  readonly mtimeMs: number;
}

/** Oldest first, then by path, so a replay always runs in the same order. */
function byAge(a: Found, b: Found): number {
  return a.mtimeMs - b.mtimeMs || (a.file < b.file ? -1 : 1);
}

export function createJsonlLogAdapter<Where extends object, State>({
  source,
  logPrefix,
  root,
  rootName,
  fs = nodeFs,
  watch = watchWithChokidar,
  watchDepth,
  locate,
  follow,
  scan,
  initialState,
  startState,
  translate,
  nameEvent,
  gate,
  rereadShrunk,
}: JsonlLogAdapterOptions<Where, State>): DetectionAdapter {
  let context: AdapterContext | undefined;
  let watcher: TranscriptWatcher | undefined;
  /** The current watcher's number: events from an older one are ignored. */
  let generation = 0;
  /** The records folder with symbolic links resolved, once watched. */
  let watchedRoot = root;
  let recheck: { readonly handle: unknown } | undefined;
  /** Each transcript's trailing read waiting to run: its timer, by path. */
  const trailing = new Map<string, unknown>();
  let stopped = false;
  /** `sync.ready` was sent (once per run). */
  let synced = false;
  /** The current watcher's initial scan and replay are done. */
  let scanned = false;
  /** The health main/detection last heard. */
  let reported: AdapterHealth | undefined;
  /** What the health is made of (see the module comment). */
  let rootMissing = false;
  let watchFailed = false;
  let badStreak = 0;
  /** Every transcript being followed, by path. */
  const files = new Map<string, TrackedFile<State>>();
  /** Transcripts that existed at the initial scan (read from the tail). */
  const existed = new Set<string>();
  /** The source's callbacks that threw, as `<callback> <code>`. */
  const failures = new Set<string>();
  /**
   * Transcripts whose first line is a record `startState` did not start
   * from: logged once each.
   */
  const unusableStarts = new Set<string>();

  function log(message: string, level: ConsoleLevel = 'info'): void {
    logEvent('detection', `${logPrefix}: ${message}`, level);
  }

  /**
   * The source's `callback` threw `error`, and the adapter does `instead`:
   * logged by error code, once per callback and code.
   */
  function callbackFailed(
    callback: string,
    error: unknown,
    instead: string,
  ): void {
    const code = errorCode(error);
    const key = `${callback} ${code}`;
    if (!failures.has(key)) {
      failures.add(key);
      log(`the source's ${callback} threw (${code}); ${instead}`, 'error');
    }
  }

  function health(): AdapterHealth {
    if (rootMissing) {
      return 'missing';
    }
    return watchFailed || badStreak >= BAD_LINE_STREAK_DEGRADED
      ? 'degraded'
      : 'ok';
  }

  /** Hands `outputs` and any health change to main/detection, once. */
  function deliver(outputs: readonly DetectionEvent[]): void {
    if (context === undefined || stopped) {
      return;
    }
    const now = health();
    const healthChanged = now !== reported;
    if (outputs.length === 0 && !healthChanged) {
      return;
    }
    reported = now;
    context.emit(outputs, healthChanged ? now : undefined);
  }

  function badLine(): void {
    badStreak += 1;
    if (badStreak === BAD_LINE_STREAK_DEGRADED) {
      log(
        `${BAD_LINE_STREAK_DEGRADED} unreadable lines in a row; health degraded`,
        'warn',
      );
    }
  }

  function goodRecord(): void {
    if (badStreak >= BAD_LINE_STREAK_DEGRADED) {
      log('read a record again after the unreadable lines');
    }
    badStreak = 0;
  }

  /** Whether a file modified at `mtimeMs` is within the discovery window. */
  function recent(mtimeMs: number): boolean {
    if (context === undefined) {
      return false;
    }
    return context.wallNow() - mtimeMs <= context.timings().discoveryWindowMs;
  }

  /**
   * The record on the first line of the open file `fd` of `size` bytes;
   * null when that line is not one, or not complete within
   * FIRST_LINE_MAX_BYTES.
   */
  function firstRecord(fd: number, size: number): Fields | null {
    const head = readRange(fs, fd, 0, Math.min(size, FIRST_LINE_MAX_BYTES));
    const end = head.indexOf(0x0a);
    return end === -1
      ? null
      : parseRecordLine(head.toString('utf8', 0, end).replace(/\r$/, ''));
  }

  /**
   * Reads transcript `file`, open as `fd`, from where the last read stopped
   * (or its start, or its tail: see the module comment) and delivers what
   * it stands for.
   */
  function readOpen(
    fd: number,
    file: string,
    where: Where,
    reason: ReadReason,
  ): void {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      return;
    }
    const tracked = files.get(file);
    let from: number;
    let carry: LineCarry;
    let state: State;
    let replay: boolean;
    let hashes: LineHashes | null;
    /** It got smaller and is read again from its start. */
    let rereading = false;
    if (tracked === undefined) {
      state = initialState;
      replay =
        reason === 'initial-replay' ||
        existed.has(file) ||
        stats.size > REPLAY_TAIL_BYTES;
      ({ from, carry } = replay
        ? tailRead(stats.size, REPLAY_TAIL_BYTES)
        : { from: 0, carry: NO_CARRY });
      hashes = startHashes(from, carry);
    } else if (stats.size < tracked.offset) {
      state = tracked.state;
      if (tracked.hashes !== null && stats.size <= REPLAY_TAIL_BYTES) {
        rereading = true;
        replay = false;
        from = 0;
        carry = NO_CARRY;
        // Matching already: the lines it matches against were all read.
        hashes = {
          read: [],
          bytes: 0,
          before: tracked.hashes.before ?? tracked.hashes.read,
        };
      } else {
        log(
          `a transcript got smaller; replaying its last ${TAIL_SIZE} again`,
          'warn',
        );
        replay = true;
        ({ from, carry } = tailRead(stats.size, REPLAY_TAIL_BYTES));
        hashes = startHashes(from, carry);
      }
    } else if (stats.size === tracked.offset) {
      return;
    } else {
      ({ offset: from, carry, state, hashes } = tracked);
      replay = false;
    }

    const readContext: ReadContext<Where> = {
      ...where,
      replay,
      fallbackTs: Math.max(0, Math.floor(stats.mtimeMs)),
    };
    if (tracked === undefined && startState !== undefined) {
      const first = firstRecord(fd, stats.size);
      let started: State | null;
      try {
        started = startState(first, readContext);
      } catch (error) {
        callbackFailed('startState', error, 'skipping that transcript');
        return;
      }
      if (started === null) {
        // An incomplete first line is not news; a complete one the source
        // cannot start from (its format changed?) is, once.
        if (first !== null && !unusableStarts.has(file)) {
          unusableStarts.add(file);
          log(
            "a transcript's first line is not a usable start; not followed",
            'warn',
          );
        }
        return;
      }
      state = started;
    }

    const chunk = readRange(fs, fd, from, stats.size);
    const split = splitLines(carry, chunk);
    const events: DetectionEvent[] = [];
    let skipped = 0;
    for (const line of split.lines) {
      if (hashes !== null && readBefore(hashes, line)) {
        skipped += 1;
        continue;
      }
      const record = parseRecordLine(line);
      if (record === null) {
        badLine();
        continue;
      }
      let translation: RecordTranslation<State>;
      try {
        translation = translate(record, state, readContext);
      } catch (error) {
        callbackFailed('translate', error, 'counting that line as unreadable');
        badLine();
        continue;
      }
      goodRecord();
      state = translation.state;
      events.push(...translation.events);
    }
    if (events.length > 0) {
      try {
        const name = nameEvent(state, readContext);
        if (name !== null) {
          events.push(name);
        }
      } catch (error) {
        callbackFailed('nameEvent', error, 'sending the read without it');
      }
    }
    if (rereading && stats.size > 0 && hashes !== null) {
      // Not emptied: a line equal to one read before, appended later, is new.
      hashes.before = null;
    }
    if (rereading) {
      log(
        `a transcript got smaller; read it again from its start (${skipped} lines read before skipped, ${split.lines.length - skipped} new)`,
      );
    }
    files.set(file, {
      offset: from + chunk.length,
      carry: split.carry,
      state,
      hashes,
    });
    if (gate !== undefined) {
      try {
        gate.read(where, state);
      } catch (error) {
        callbackFailed('gate.read', error, 'going on');
      }
    }
    deliver(events);
  }

  /**
   * With `rereadShrunk`, the line hashes of a read starting at `from` with
   * `carry`: empty ones for a read from the transcript's start; null for
   * one from its tail (what came before it is not known), or without it.
   */
  function startHashes(from: number, carry: LineCarry): LineHashes | null {
    return rereadShrunk === true && from === 0 && !carry.skipping
      ? { read: [], bytes: 0, before: null }
      : null;
  }

  /**
   * Whether `line`, the next complete line from the transcript's start,
   * was read before it got smaller (so it is skipped); hashes it, while
   * within REPLAY_TAIL_BYTES. The first line that differs, or comes after
   * every line read before, ends the matching.
   */
  function readBefore(hashes: LineHashes, line: string): boolean {
    if (hashes.bytes > REPLAY_TAIL_BYTES) {
      // Past what a transcript that got smaller can share: new.
      hashes.before = null;
      return false;
    }
    const hash = lineHash(line);
    const index = hashes.read.length;
    hashes.read.push(hash);
    hashes.bytes += Buffer.byteLength(line) + 1;
    if (hashes.before === null) {
      return false;
    }
    if (index < hashes.before.length && hashes.before[index] === hash) {
      return true;
    }
    hashes.before = null;
    return false;
  }

  /** Reads what is new in transcript `file`, if it is one. Never throws. */
  function read(file: string, reason: ReadReason): void {
    let where: Where | null;
    try {
      where = locate(watchedRoot, file);
    } catch (error) {
      callbackFailed('locate', error, 'skipping that transcript');
      return;
    }
    if (where === null) {
      return;
    }
    if (gate !== undefined) {
      let allowed: boolean;
      try {
        allowed = gate.allows(where, files.has(file));
      } catch (error) {
        callbackFailed('gate.allows', error, 'skipping that transcript');
        return;
      }
      if (!allowed) {
        return;
      }
    }
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') {
        files.delete(file);
      } else {
        log(`cannot open a transcript (${code})`, 'warn');
      }
      return;
    }
    try {
      readOpen(fd, file, where, reason);
    } catch (error) {
      log(`cannot read a transcript (${errorCode(error)})`, 'warn');
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // Closing a file opened to read loses nothing.
      }
    }
  }

  /** The entries of `dir`; none when it cannot be listed. */
  function list(dir: string): readonly TranscriptDirent[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  /** `file`'s modification time; null when it cannot be read. */
  function mtimeOf(file: string): number | null {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Every transcript the source's scan finds under the root, remembered as
   * already there; per group, those modified within the discovery window,
   * oldest first.
   */
  function scanRecent(): {
    readonly label: string;
    readonly recent: readonly Found[];
  }[] {
    let groups: readonly ScanGroup[];
    try {
      groups = scan(watchedRoot, list);
    } catch (error) {
      callbackFailed('scan', error, 'replaying nothing');
      groups = [];
    }
    return groups.map(({ label, files: found }) => {
      const inWindow: Found[] = [];
      for (const file of found) {
        existed.add(file);
        const mtimeMs = mtimeOf(file);
        if (mtimeMs !== null && recent(mtimeMs)) {
          inWindow.push({ file, mtimeMs });
        }
      }
      return { label, recent: inWindow.sort(byAge) };
    });
  }

  /** Sends `sync.ready`, once per run. */
  function sync(): void {
    if (!synced && context !== undefined && !stopped) {
      synced = true;
      context.emit([{ type: 'sync.ready', source }]);
    }
  }

  /** The scan and replay of a newly watched folder, then `sync.ready`. */
  function replayAll(): void {
    if (scanned || stopped || context === undefined) {
      return;
    }
    scanned = true;
    const groups = scanRecent();
    let replayed = 0;
    for (const { recent: found } of groups) {
      for (const { file } of found) {
        if (!files.has(file)) {
          read(file, 'initial-replay');
          if (files.has(file)) {
            replayed += 1;
          }
        }
      }
    }
    const counts = [
      groups
        .map(({ label, recent: found }) => `${found.length} ${label}`)
        .join(', '),
      `${existed.size} transcripts in all`,
    ]
      .filter((part) => part !== '')
      .join('; ');
    log(
      `replayed ${replayed} transcripts modified within the discovery window (${counts})${synced ? '' : '; sync.ready'}`,
    );
    sync();
  }

  /** Runs a watcher callback; it must not throw into the watcher. */
  function guarded(what: string, run: () => void): void {
    if (stopped) {
      return;
    }
    try {
      run();
    } catch (error) {
      log(`${what} failed (${errorCode(error)})`, 'error');
    }
  }

  /** Forgets every transcript (the folder is gone, or the adapter stops). */
  function forgetAll(): void {
    cancelTrailingReads();
    files.clear();
    existed.clear();
    unusableStarts.clear();
    try {
      gate?.reset();
    } catch (error) {
      callbackFailed('gate.reset', error, 'going on');
    }
  }

  /** Cancels every trailing read waiting to run. */
  function cancelTrailingReads(): void {
    for (const handle of trailing.values()) {
      context?.clearTimer(handle);
    }
    trailing.clear();
  }

  /**
   * Reads `file` again TRAILING_READ_MS from now, for watcher `mine`: for
   * what chokidar did not report (see the module comment). A trailing read
   * already waiting for the file is moved to then.
   */
  function armTrailingRead(file: string, mine: number): void {
    if (context === undefined || stopped) {
      return;
    }
    const waiting = trailing.get(file);
    if (waiting !== undefined) {
      context.clearTimer(waiting);
    }
    trailing.set(
      file,
      context.setTimer(() => {
        trailing.delete(file);
        if (mine === generation && scanned) {
          guarded('a trailing read', () => {
            read(file, 'change');
          });
        }
      }, TRAILING_READ_MS),
    );
  }

  function closeWatcher(): void {
    cancelTrailingReads();
    generation += 1;
    const closing = watcher;
    watcher = undefined;
    closing?.close().catch((error: unknown) => {
      log(`closing the watcher failed (${errorCode(error)})`, 'warn');
    });
  }

  /** Checks for the records folder again after RECORDS_FOLDER_RECHECK_MS. */
  function armRecheck(): void {
    if (stopped || context === undefined || recheck !== undefined) {
      return;
    }
    recheck = {
      handle: context.setTimer(() => {
        recheck = undefined;
        guarded(`checking for the ${rootName}`, begin);
      }, RECORDS_FOLDER_RECHECK_MS),
    };
  }

  /** The records folder with links resolved; null when it is not there. */
  function resolveRoot(): string | null {
    try {
      const real = fs.realpathSync(root);
      return fs.statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  }

  /**
   * Watches the records folder if it is there (and replays it once the
   * watcher's scan is done); otherwise reports it missing and checks again
   * later.
   */
  function begin(): void {
    if (stopped || context === undefined) {
      return;
    }
    const real = resolveRoot();
    if (real === null) {
      if (!rootMissing || !synced) {
        log(
          `no ${rootName}; health missing, checking for it again later`,
          'warn',
        );
      }
      rootMissing = true;
      if (synced) {
        deliver([]);
      } else {
        reported = health();
        synced = true;
        context.emit([{ type: 'sync.ready', source }], reported);
      }
      armRecheck();
      return;
    }
    const again = synced;
    rootMissing = false;
    watchFailed = false;
    watchedRoot = real;
    scanned = false;
    closeWatcher();
    const mine = generation;
    /** Runs `run` only for this watcher's events. */
    const current =
      <A extends unknown[]>(what: string, run: (...args: A) => void) =>
      (...args: A): void => {
        if (mine === generation) {
          guarded(what, () => {
            run(...args);
          });
        }
      };
    const changed = current('reading a change', (file: string) => {
      if (scanned) {
        read(file, 'change');
        armTrailingRead(file, mine);
      }
    });
    try {
      watcher = watch(
        real,
        {
          depth: watchDepth,
          follow: (entry, stats) => {
            try {
              return follow(real, entry, stats, recent);
            } catch (error) {
              callbackFailed('follow', error, 'not following that path');
              return false;
            }
          },
        },
        {
          ready: current('the initial replay', replayAll),
          added: changed,
          changed,
          removed: current('forgetting a transcript', (file: string) => {
            files.delete(file);
            existed.delete(file);
          }),
          folderRemoved: current(
            `the ${rootName} going away`,
            (dir: string) => {
              if (path.relative(real, dir) !== '') {
                return;
              }
              closeWatcher();
              rootMissing = true;
              forgetAll();
              log(`the ${rootName} went away; health missing`, 'warn');
              deliver([]);
              armRecheck();
            },
          ),
          failed: current('a watcher error', (error: unknown) => {
            log(`watcher error (${errorCode(error)}); health degraded`, 'warn');
            watchFailed = true;
            deliver([]);
          }),
        },
      );
    } catch (error) {
      // Without a watcher only a replay can be read: degraded.
      log(
        `cannot watch the ${rootName} (${errorCode(error)}); replaying once without updates`,
        'error',
      );
      watchFailed = true;
      replayAll();
      deliver([]);
      return;
    }
    log(
      again
        ? `the ${rootName} is there again; watching it`
        : `started; watching the ${rootName}`,
    );
    deliver([]);
  }

  return {
    source,

    start(adapterContext) {
      if (context !== undefined || stopped) {
        return;
      }
      context = adapterContext;
      begin();
    },

    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (recheck !== undefined) {
        context?.clearTimer(recheck.handle);
        recheck = undefined;
      }
      forgetAll();
      closeWatcher();
      log('stopped');
    },
  };
}
