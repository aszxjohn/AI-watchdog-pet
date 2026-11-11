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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JSONL = '.jsonl';

const SUBAGENTS = 'subagents';

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

/** `file`'s parts below `root`; null when it is not below it. */
function partsBelow(root: string, file: string): string[] | null {
  const relative = path.relative(root, file);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep);
}

/** What transcript `file` is; null when it is none (see the module comment). */
export function transcriptAt(
  root: string,
  file: string,
): TranscriptPath | null {
  const parts = partsBelow(root, file);
  if (parts === null) {
    return null;
  }
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

/** What the watcher knows of a path when it asks whether to watch it. */
export interface WatchedStats {
  isFile(): boolean;
  isDirectory(): boolean;
  readonly mtimeMs: number;
}

/**
 * Whether the watcher should follow `entry`: the root; `<cwd>` folders,
 * session folders and their `subagents` folders; transcripts modified
 * recently (`recent(mtimeMs)`). Older transcripts are left alone until
 * they change: the folder holding one notices, asks again, and the watcher
 * reports the file as added. That keeps one watch handle per recently used
 * transcript, not one per transcript ever written. Without stats, only the
 * names are checked.
 */
export function shouldWatch(
  root: string,
  entry: string,
  stats: WatchedStats | undefined,
  recent: (mtimeMs: number) => boolean,
): boolean {
  if (path.relative(root, entry) === '') {
    return true;
  }
  const parts = partsBelow(root, entry);
  if (parts === null || parts.length > 4) {
    return false;
  }
  const [, second = '', third] = parts;
  const isTranscript = transcriptAt(root, entry) !== null;
  const isFolder =
    parts.length === 1 ||
    (parts.length === 2 && UUID.test(second)) ||
    (parts.length === 3 && UUID.test(second) && third === SUBAGENTS);
  if (stats === undefined) {
    return isTranscript || isFolder;
  }
  if (stats.isFile()) {
    return isTranscript && recent(stats.mtimeMs);
  }
  return stats.isDirectory() && isFolder;
}
