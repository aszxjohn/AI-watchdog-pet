/**
 * main/detection/adapters/claude-code/paths: which files under Claude
 * Code's projects folder are transcripts (Story 2.4). Only these two kinds
 * are ever opened:
 *
 * - `<root>/<cwd>/<id>.jsonl`: a session's transcript; `<id>` is its UUID,
 *   the session's native id;
 * - `<root>/<cwd>/<id>/subagents/<name>.jsonl`: one of its subagents'
 *   transcripts, which belongs to session `<id>`.
 */
import path from 'node:path';
import {
  partsBelow,
  shouldFollow,
  type WatchedKind,
  type WatchedStats,
} from '../jsonl/watcher';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JSONL = '.jsonl';

const SUBAGENTS = 'subagents';

/**
 * How many folders below the root the watcher looks: down to the files in
 * `<cwd>/<id>/subagents/`.
 */
export const WATCH_DEPTH = 3;

/** A transcript's kind and the session it belongs to. */
export interface TranscriptPath {
  readonly kind: 'main' | 'subagent';
  /** The session's UUID (the parent's, for a subagent). */
  readonly sessionId: string;
}

/** Whether `name` is `<uuid>.jsonl`. */
function isSessionFile(name: string): boolean {
  return name.endsWith(JSONL) && UUID.test(name.slice(0, -JSONL.length));
}

/** What transcript the path with `parts` below the root is; null when none. */
function transcriptOf(parts: readonly string[]): TranscriptPath | null {
  const [, second = '', third, fourth = ''] = parts;
  if (parts.length === 2 && isSessionFile(second)) {
    return { kind: 'main', sessionId: second.slice(0, -JSONL.length) };
  }
  if (
    parts.length === 4 &&
    UUID.test(second) &&
    third === SUBAGENTS &&
    fourth.endsWith(JSONL)
  ) {
    return { kind: 'subagent', sessionId: second };
  }
  return null;
}

/** What transcript `file` is; null when it is none (see the module comment). */
export function transcriptAt(
  root: string,
  file: string,
): TranscriptPath | null {
  const parts = partsBelow(root, file);
  return parts === null ? null : transcriptOf(parts);
}

/** Whether `name`, in a `<cwd>` folder, is a session's subagent folder's parent. */
export function isSessionFolder(name: string): boolean {
  return UUID.test(name);
}

/** Whether `name`, in a `<cwd>` folder, is a session's transcript. */
export function isSessionTranscript(name: string): boolean {
  return isSessionFile(name);
}

/** The subagents folder of session folder `dir`. */
export function subagentsFolder(dir: string): string {
  return path.join(dir, SUBAGENTS);
}

/** Whether `name`, in a subagents folder, is a transcript. */
export function isSubagentTranscript(name: string): boolean {
  return name.endsWith(JSONL);
}

/**
 * What the path with `parts` below the root is to the watcher: a
 * transcript; a folder transcripts live in (`<cwd>` folders, session
 * folders and their `subagents` folders); or neither.
 */
function watchedKind(parts: readonly string[]): WatchedKind {
  if (transcriptOf(parts) !== null) {
    return 'transcript';
  }
  const [, second = '', third] = parts;
  return parts.length === 1 ||
    (parts.length === 2 && UUID.test(second)) ||
    (parts.length === 3 && UUID.test(second) && third === SUBAGENTS)
    ? 'folder'
    : null;
}

/**
 * Whether the watcher should follow `entry`: the root, the folders
 * transcripts live in, and transcripts modified recently (`recent(mtimeMs)`;
 * see shouldFollow).
 */
export function shouldWatch(
  root: string,
  entry: string,
  stats: WatchedStats | undefined,
  recent: (mtimeMs: number) => boolean,
): boolean {
  return shouldFollow(root, entry, stats, recent, watchedKind);
}
