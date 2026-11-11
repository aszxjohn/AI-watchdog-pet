/**
 * main/detection/adapters/claude-code: the Claude Code adapter, transcript
 * half (Story 2.4). It reads the transcripts under Claude Code's projects
 * folder (`~/.claude/projects`, injected as `root`) and translates their
 * records into shared events (./translate). Status files are the second
 * half of the story; until then approvals and questions are guessed
 * (SOURCE_CAPABILITIES).
 *
 * Following the transcripts (replay at start, reading changes, watching,
 * health, the folder going away and coming back) is the shared JSON Lines
 * adapter's (../jsonl/log-adapter; Story 2.6). What is Claude Code's own
 * is here:
 *
 * - which files are transcripts and which session each belongs to, and
 *   which paths the watcher follows (./paths);
 * - the initial scan: every session's transcript, then every subagent's
 *   (replayed after the sessions, so a subagent's session has been read);
 * - the translation of a record, and the display name sent again after a
 *   read of a session's own transcript (./translate);
 * - a subagent's records count only once its session's own transcript has
 *   been read; until then they are skipped.
 *
 * Read-only: it opens only the transcripts ./paths names, to read. The log
 * gets codes and counts only, never a path or a record's content.
 */
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
  isSessionFolder,
  isSessionTranscript,
  isSubagentTranscript,
  shouldWatch,
  subagentsFolder,
  transcriptAt,
  WATCH_DEPTH,
} from './paths';
import {
  currentNameEvent,
  NEW_TRANSCRIPT,
  type TranscriptKind,
  type TranscriptState,
  translateRecord,
} from './translate';

const SOURCE = 'claude-code';

export interface ClaudeCodeAdapterOptions {
  /** Claude Code's projects folder: `~/.claude/projects`. */
  readonly root: string;
  /** The file system, read-only (default node:fs). */
  readonly fs?: TranscriptFs;
  /** Starts the watcher (default chokidar). */
  readonly watch?: WatchTranscripts;
}

/** A transcript: its kind and the session it speaks for. */
interface Transcript {
  readonly kind: TranscriptKind;
  /** `claude-code:<id>` (the parent's, for a subagent). */
  readonly sessionKey: SessionKey;
}

/** What transcript `file` under `root` is; null when it is none. */
function locate(root: string, file: string): Transcript | null {
  const where = transcriptAt(root, file);
  if (where === null) {
    return null;
  }
  const sessionKey = makeSessionKey(SOURCE, where.sessionId);
  return sessionKey === null ? null : { kind: where.kind, sessionKey };
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
    const projectDir = path.join(root, project.name);
    for (const entry of list(projectDir)) {
      if (entry.isFile() && isSessionTranscript(entry.name)) {
        sessions.push(path.join(projectDir, entry.name));
      } else if (entry.isDirectory() && isSessionFolder(entry.name)) {
        const dir = subagentsFolder(path.join(projectDir, entry.name));
        for (const sub of list(dir)) {
          if (sub.isFile() && isSubagentTranscript(sub.name)) {
            subagents.push(path.join(dir, sub.name));
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

export function createClaudeCodeAdapter({
  root,
  fs,
  watch,
}: ClaudeCodeAdapterOptions): DetectionAdapter {
  /** Sessions whose own transcript has been read: their subagents count. */
  const readSessions = new Set<SessionKey>();
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
