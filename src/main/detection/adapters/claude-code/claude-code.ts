/**
 * main/detection/adapters/claude-code: the Claude Code adapter, transcript
 * half (Story 2.4). It reads the transcripts under Claude Code's projects
 * folder (`~/.claude/projects`, injected as `root`) and translates their
 * records into shared events (./translate). Status files are the second
 * half of the story; until then approvals and questions are guessed
 * (SOURCE_CAPABILITIES).
 *
 * Read-only: it lists folders, takes stats, and opens only the transcripts
 * ./paths names, to read. It writes nothing, runs nothing and connects to
 * nothing.
 *
 * - Start: with no projects folder, health `missing` and `sync.ready` at
 *   once. Otherwise the folder (symbolic links resolved) is watched, and
 *   health is `ok` once the watcher started. When its initial scan is
 *   done, the adapter replays every transcript modified within
 *   discoveryWindowMs (the last REPLAY_TAIL_BYTES of each, events marked
 *   `replay: true`; sessions before their subagents), then sends
 *   `sync.ready`.
 * - While the folder is missing (at start, or removed while running: the
 *   watcher is closed then), the adapter checks for it every
 *   RECORDS_FOLDER_RECHECK_MS; once it is there, it is watched and replayed
 *   as at start (no second `sync.ready`).
 * - Then, each time a transcript changes, it reads from where it stopped
 *   to the end; an incomplete last line waits for the next read. A
 *   transcript it has not read yet is read from its start when it was
 *   created after the initial scan and is no longer than the tail, and
 *   replayed from its tail otherwise (a resumed session). One that got
 *   smaller is logged and replayed from its tail again. A subagent's
 *   records count only once its session has been read; until then they are
 *   skipped.
 * - Everything one read produced reaches main/detection in one emit, so
 *   the panel is updated once per read. A read of a session's own
 *   transcript that produced events ends with its current display name
 *   again, so a session that comes back after expiring keeps its name.
 * - Health: `missing` while there is no projects folder; otherwise
 *   `degraded` while the last BAD_LINE_STREAK_DEGRADED lines read (across
 *   transcripts) were all bad, or once the watcher failed to start or
 *   reported an error (until the folder is watched again); otherwise `ok`.
 *   Bad lines are skipped and counted, never thrown on; the next good
 *   record ends the streak.
 * - It never ends a session itself: no `session.end` (a session ends when
 *   main/detection/sessions expires it).
 *
 * The log gets codes and counts only, never a path or a record's content.
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import {
  BAD_LINE_STREAK_DEGRADED,
  RECORDS_FOLDER_RECHECK_MS,
  REPLAY_TAIL_BYTES,
} from '../../../../shared/constants';
import {
  type DetectionEvent,
  makeSessionKey,
  type SessionKey,
} from '../../../../shared/detection-events';
import type { AdapterHealth } from '../../../../shared/sources';
import { errorCode, logEvent, type ConsoleLevel } from '../../../log/run-log';
import type { AdapterContext, DetectionAdapter } from '../../adapter';
import {
  isSessionFolder,
  isSessionTranscript,
  isSubagentTranscript,
  shouldWatch,
  subagentsFolder,
  transcriptAt,
} from './paths';
import {
  type LineCarry,
  NO_CARRY,
  readRange,
  splitLines,
  tailRead,
  type TranscriptFs,
} from './read';
import {
  currentNameEvent,
  NEW_TRANSCRIPT,
  parseRecordLine,
  type TranscriptKind,
  type TranscriptState,
  translateRecord,
} from './translate';
import {
  type TranscriptWatcher,
  type WatchTranscripts,
  watchWithChokidar,
} from './watcher';

const SOURCE = 'claude-code';

/** REPLAY_TAIL_BYTES for the log. */
const TAIL_SIZE =
  REPLAY_TAIL_BYTES % (1024 * 1024) === 0
    ? `${REPLAY_TAIL_BYTES / (1024 * 1024)} MiB`
    : `${REPLAY_TAIL_BYTES} bytes`;

export interface ClaudeCodeAdapterOptions {
  /** Claude Code's projects folder: `~/.claude/projects`. */
  readonly root: string;
  /** The file system, read-only (default node:fs). */
  readonly fs?: TranscriptFs;
  /** Starts the watcher (default chokidar). */
  readonly watch?: WatchTranscripts;
}

/** A transcript being followed. */
interface TrackedFile {
  readonly kind: TranscriptKind;
  readonly sessionKey: SessionKey;
  /** Where the next read starts. */
  readonly offset: number;
  readonly carry: LineCarry;
  readonly transcript: TranscriptState;
}

/** Why a transcript is read. */
type ReadReason = 'initial-replay' | 'change';

interface Found {
  readonly file: string;
  readonly mtimeMs: number;
}

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('detection', `claude-code: ${message}`, level);
}

/** Oldest first, then by path, so a replay always runs in the same order. */
function byAge(a: Found, b: Found): number {
  return a.mtimeMs - b.mtimeMs || (a.file < b.file ? -1 : 1);
}

export function createClaudeCodeAdapter({
  root,
  fs = nodeFs,
  watch = watchWithChokidar,
}: ClaudeCodeAdapterOptions): DetectionAdapter {
  let context: AdapterContext | undefined;
  let watcher: TranscriptWatcher | undefined;
  /** The current watcher's number: events from an older one are ignored. */
  let generation = 0;
  /** The projects folder with symbolic links resolved, once watched. */
  let watchedRoot = root;
  let recheck: { readonly handle: unknown } | undefined;
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
  const files = new Map<string, TrackedFile>();
  /** Transcripts that existed at the initial scan (read from the tail). */
  const existed = new Set<string>();
  /** Sessions whose own transcript has been read: their subagents count. */
  const readSessions = new Set<SessionKey>();

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
   * Reads transcript `file`, open as `fd`, from where the last read stopped
   * (or its start, or its tail: see the module comment) and delivers what
   * it stands for.
   */
  function readOpen(
    fd: number,
    file: string,
    kind: TranscriptKind,
    sessionKey: SessionKey,
    reason: ReadReason,
  ): void {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      return;
    }
    const tracked = files.get(file);
    let from: number;
    let carry: LineCarry;
    let transcript: TranscriptState;
    let replay: boolean;
    if (tracked === undefined) {
      transcript = NEW_TRANSCRIPT;
      replay =
        reason === 'initial-replay' ||
        existed.has(file) ||
        stats.size > REPLAY_TAIL_BYTES;
      ({ from, carry } = replay
        ? tailRead(stats.size, REPLAY_TAIL_BYTES)
        : { from: 0, carry: NO_CARRY });
    } else if (stats.size < tracked.offset) {
      log(
        `a transcript got smaller; replaying its last ${TAIL_SIZE} again`,
        'warn',
      );
      transcript = tracked.transcript;
      replay = true;
      ({ from, carry } = tailRead(stats.size, REPLAY_TAIL_BYTES));
    } else if (stats.size === tracked.offset) {
      return;
    } else {
      ({ offset: from, carry, transcript } = tracked);
      replay = false;
    }

    const chunk = readRange(fs, fd, from, stats.size);
    const split = splitLines(carry, chunk);
    const recordContext = {
      sessionKey,
      kind,
      replay,
      fallbackTs: Math.max(0, Math.floor(stats.mtimeMs)),
    };
    const events: DetectionEvent[] = [];
    for (const line of split.lines) {
      const record = parseRecordLine(line);
      if (record === null) {
        badLine();
        continue;
      }
      goodRecord();
      const translation = translateRecord(record, transcript, recordContext);
      transcript = translation.state;
      events.push(...translation.events);
    }
    if (events.length > 0) {
      const name = currentNameEvent(transcript, recordContext);
      if (name !== null) {
        events.push(name);
      }
    }
    files.set(file, {
      kind,
      sessionKey,
      offset: from + chunk.length,
      carry: split.carry,
      transcript,
    });
    if (kind === 'main' && transcript.started) {
      readSessions.add(sessionKey);
    }
    deliver(events);
  }

  /** Reads what is new in transcript `file`, if it is one. Never throws. */
  function read(file: string, reason: ReadReason): void {
    const where = transcriptAt(watchedRoot, file);
    if (where === null) {
      return;
    }
    const sessionKey = makeSessionKey(SOURCE, where.sessionId);
    if (sessionKey === null) {
      return;
    }
    if (
      where.kind === 'subagent' &&
      !files.has(file) &&
      !readSessions.has(sessionKey)
    ) {
      return;
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
      readOpen(fd, file, where.kind, sessionKey, reason);
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
  function list(dir: string) {
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
   * Every transcript under the root, remembered as already there; returns
   * those modified within the discovery window, sessions and subagents
   * apart.
   */
  function scan(): { readonly own: Found[]; readonly subagents: Found[] } {
    const own: Found[] = [];
    const subagents: Found[] = [];
    const note = (file: string, into: Found[]): void => {
      existed.add(file);
      const mtimeMs = mtimeOf(file);
      if (mtimeMs !== null && recent(mtimeMs)) {
        into.push({ file, mtimeMs });
      }
    };
    for (const project of list(watchedRoot)) {
      if (!project.isDirectory()) {
        continue;
      }
      const projectDir = path.join(watchedRoot, project.name);
      for (const entry of list(projectDir)) {
        if (entry.isFile() && isSessionTranscript(entry.name)) {
          note(path.join(projectDir, entry.name), own);
        } else if (entry.isDirectory() && isSessionFolder(entry.name)) {
          const dir = subagentsFolder(path.join(projectDir, entry.name));
          for (const sub of list(dir)) {
            if (sub.isFile() && isSubagentTranscript(sub.name)) {
              note(path.join(dir, sub.name), subagents);
            }
          }
        }
      }
    }
    return { own: own.sort(byAge), subagents: subagents.sort(byAge) };
  }

  /** Sends `sync.ready`, once per run. */
  function sync(): void {
    if (!synced && context !== undefined && !stopped) {
      synced = true;
      context.emit([{ type: 'sync.ready', source: SOURCE }]);
    }
  }

  /** The scan and replay of a newly watched folder, then `sync.ready`. */
  function replayAll(): void {
    if (scanned || stopped || context === undefined) {
      return;
    }
    scanned = true;
    const { own, subagents } = scan();
    let replayed = 0;
    for (const { file } of [...own, ...subagents]) {
      if (!files.has(file)) {
        read(file, 'initial-replay');
        if (files.has(file)) {
          replayed += 1;
        }
      }
    }
    log(
      `replayed ${replayed} transcripts modified within the discovery window (${own.length} sessions, ${subagents.length} subagents; ${existed.size} transcripts in all)${synced ? '' : '; sync.ready'}`,
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
    files.clear();
    existed.clear();
    readSessions.clear();
  }

  function closeWatcher(): void {
    generation += 1;
    const closing = watcher;
    watcher = undefined;
    closing?.close().catch((error: unknown) => {
      log(`closing the watcher failed (${errorCode(error)})`, 'warn');
    });
  }

  /** Checks for the projects folder again after RECORDS_FOLDER_RECHECK_MS. */
  function armRecheck(): void {
    if (stopped || context === undefined || recheck !== undefined) {
      return;
    }
    recheck = {
      handle: context.setTimer(() => {
        recheck = undefined;
        guarded('checking for the projects folder', begin);
      }, RECORDS_FOLDER_RECHECK_MS),
    };
  }

  /** The projects folder with links resolved; null when it is not there. */
  function resolveRoot(): string | null {
    try {
      const real = fs.realpathSync(root);
      return fs.statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  }

  /**
   * Watches the projects folder if it is there (and replays it once the
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
          'no projects folder; health missing, checking for it again later',
          'warn',
        );
      }
      rootMissing = true;
      if (synced) {
        deliver([]);
      } else {
        reported = health();
        synced = true;
        context.emit([{ type: 'sync.ready', source: SOURCE }], reported);
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
      }
    });
    try {
      watcher = watch(
        real,
        (entry, stats) => shouldWatch(real, entry, stats, recent),
        {
          ready: current('the initial replay', replayAll),
          added: changed,
          changed,
          removed: current('forgetting a transcript', (file: string) => {
            files.delete(file);
            existed.delete(file);
          }),
          folderRemoved: current(
            'the projects folder going away',
            (dir: string) => {
              if (path.relative(real, dir) !== '') {
                return;
              }
              closeWatcher();
              rootMissing = true;
              forgetAll();
              log('the projects folder went away; health missing', 'warn');
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
        `cannot watch the projects folder (${errorCode(error)}); replaying once without updates`,
        'error',
      );
      watchFailed = true;
      replayAll();
      deliver([]);
      return;
    }
    log(
      again
        ? 'the projects folder is there again; watching it'
        : 'started; watching the projects folder',
    );
    deliver([]);
  }

  return {
    source: SOURCE,

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
