/**
 * main/detection/adapters/cursor: the Cursor adapter (Story 2.7). It reads
 * the agent transcripts under Cursor's projects folder
 * (`~/.cursor/projects`, injected as `root`), the IDE's and cursor-agent's
 * alike, and translates their records into shared events (./translate).
 *
 * Following the transcripts (replay at start, reading changes, watching,
 * health, the folder going away and coming back) is the shared JSON Lines
 * adapter's (../jsonl/log-adapter). What is Cursor's own is here:
 *
 * - which files are transcripts and which session each belongs to, and
 *   which paths the watcher follows (./paths);
 * - a session's display name, read back from its project folder's name
 *   with stats only (./project-name);
 * - the initial scan: every session's transcript, then every subagent's
 *   (replayed after the sessions, so a subagent's session has been read);
 * - the translation of a record, and the display name sent again after a
 *   read of a session's own transcript (./translate);
 * - a subagent's records count only once its parent session has started
 *   in a transcript read; until then they are skipped. Each of them is
 *   only the parent's `activity`;
 * - a transcript that got smaller (Cursor may write it anew, whole) is
 *   read again from its start, and the records read before are not sent
 *   again (`rereadShrunk`).
 *
 * Known limits (Cursor writes a record per step, once the step is done,
 * with no time, no tool result and no approval; SOURCE_CAPABILITIES):
 *
 * - the state follows the steps, seconds to tens of seconds late; the
 *   2-second goal does not hold for this source;
 * - after a tool that may ask for approval (any but the no-guess ones), a
 *   model thinking longer than approvalInferMs before its next step is
 *   guessed to wait for approval (要你批准) too;
 * - records carry no time: every event of a read is dated at the file's
 *   modification time, so a replayed transcript's events all count from
 *   when it was last written;
 * - nothing tells that a session ended: once Cursor is closed, a session
 *   ends when it expires;
 * - how Cursor writes a transcript was not observed: if it writes the file
 *   anew, whole, and the file grows while earlier lines change, the read
 *   goes on from where it stopped, in the middle of a line. Only that
 *   partial line is unreadable (health stays `ok`: `degraded` takes
 *   BAD_LINE_STREAK_DEGRADED in a row), and the complete lines after it,
 *   though they may be records read before, are sent again as new.
 *
 * Read-only: it opens only the transcripts ./paths names, to read, and
 * takes stats of candidate project folders, never opening them. The log
 * gets codes and counts only, never a path or a record's content.
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import {
  makeSessionKey,
  type SessionKey,
} from '../../../../shared/detection-events';
import type { DetectionAdapter } from '../../adapter';
import { createJsonlLogAdapter, type ScanGroup } from '../jsonl/log-adapter';
import type { TranscriptDirent, TranscriptFs } from '../jsonl/read';
import type { WatchTranscripts } from '../jsonl/watcher';
import {
  isSubagentTranscript,
  sessionTranscriptName,
  shouldWatch,
  SUBAGENTS_FOLDER,
  transcriptAt,
  TRANSCRIPTS_FOLDER,
  WATCH_DEPTH,
} from './paths';
import { createProjectNames, type StatPath } from './project-name';
import {
  currentNameEvent,
  NEW_TRANSCRIPT,
  type TranscriptKind,
  type TranscriptState,
  translateRecord,
} from './translate';

const SOURCE = 'cursor';

export interface CursorAdapterOptions {
  /** Cursor's projects folder: `~/.cursor/projects`. */
  readonly root: string;
  /** The file system, read-only (default node:fs). */
  readonly fs?: TranscriptFs;
  /** Starts the watcher (default chokidar). */
  readonly watch?: WatchTranscripts;
  /**
   * Stats a candidate project folder to read a slug back (default the
   * file system's statSync).
   */
  readonly stat?: StatPath;
  /** Which path rules a slug is read back with (default this platform's). */
  readonly platform?: NodeJS.Platform;
}

/** A transcript: its kind, the session it speaks for, and its name. */
interface Transcript {
  readonly kind: TranscriptKind;
  /** `cursor:<id>` (the parent's, for a subagent). */
  readonly sessionKey: SessionKey;
  /** The session's display name (a session's own transcript only). */
  readonly name: string | null;
}

/**
 * Every transcript under the projects folder `root`: sessions' first, then
 * subagents'.
 */
function scan(
  root: string,
  list: (dir: string) => readonly TranscriptDirent[],
): readonly ScanGroup[] {
  const sessions: string[] = [];
  const subagents: string[] = [];
  for (const project of list(root)) {
    if (!project.isDirectory()) {
      continue;
    }
    const transcripts = path.join(root, project.name, TRANSCRIPTS_FOLDER);
    for (const session of list(transcripts)) {
      if (!session.isDirectory()) {
        continue;
      }
      const dir = path.join(transcripts, session.name);
      const own = sessionTranscriptName(session.name);
      for (const entry of list(dir)) {
        if (entry.isFile() && entry.name === own) {
          sessions.push(path.join(dir, entry.name));
        } else if (entry.isDirectory() && entry.name === SUBAGENTS_FOLDER) {
          const subDir = path.join(dir, entry.name);
          for (const sub of list(subDir)) {
            if (sub.isFile() && isSubagentTranscript(sub.name)) {
              subagents.push(path.join(subDir, sub.name));
            }
          }
        }
      }
    }
  }
  return [
    { label: 'sessions', files: sessions },
    { label: 'subagents', files: subagents },
  ];
}

export function createCursorAdapter({
  root,
  fs,
  watch,
  stat,
  platform,
}: CursorAdapterOptions): DetectionAdapter {
  const files = fs ?? nodeFs;
  const nameOf = createProjectNames(
    stat ?? ((file) => files.statSync(file)),
    platform,
  );
  /** Sessions started in a transcript read: their subagents count. */
  const readSessions = new Set<SessionKey>();

  /** What transcript `file` under `root` is; null when it is none. */
  function locate(base: string, file: string): Transcript | null {
    const where = transcriptAt(base, file);
    if (where === null) {
      return null;
    }
    const sessionKey = makeSessionKey(SOURCE, where.id);
    if (sessionKey === null) {
      return null;
    }
    return {
      kind: where.kind,
      sessionKey,
      name: where.kind === 'main' ? nameOf(where.slug) : null,
    };
  }

  return createJsonlLogAdapter<Transcript, TranscriptState>({
    source: SOURCE,
    logPrefix: SOURCE,
    root,
    rootName: 'projects folder',
    fs,
    watch,
    watchDepth: WATCH_DEPTH,
    locate,
    follow: shouldWatch,
    scan,
    initialState: NEW_TRANSCRIPT,
    translate: translateRecord,
    nameEvent: currentNameEvent,
    rereadShrunk: true,
    gate: {
      allows: (where, tracked) =>
        where.kind !== 'subagent' ||
        tracked ||
        readSessions.has(where.sessionKey),
      read(where, state) {
        if (where.kind === 'main' && state.started) {
          readSessions.add(where.sessionKey);
        }
      },
      reset() {
        readSessions.clear();
      },
    },
  });
}
