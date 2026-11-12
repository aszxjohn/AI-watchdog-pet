/**
 * main/detection/adapters/gemini/paths: which files under Gemini CLI's
 * temporary folder (`~/.gemini/tmp`, the root) are chat logs (Story 2.6).
 * Only these two kinds are ever opened:
 *
 * - `<root>/<project>/chats/session-*.jsonl`: a session's chat log; its
 *   first line (the header) holds the session id, the session's native id;
 * - `<root>/<project>/chats/<id>/*.jsonl`: a subagent's chat log, which
 *   belongs to session `<id>`, its parent.
 *
 * `<project>` is the folder Gemini CLI keeps for one project; its name is
 * the session's display name until the chat has a summary. Everything else
 * under the root (each project's `logs.json`, `.project_root`, the legacy
 * `session-*.json` chat files, and the rest) is never followed or opened.
 */
import {
  partsBelow,
  shouldFollow,
  type WatchedKind,
  type WatchedStats,
} from '../jsonl/watcher';

const JSONL = '.jsonl';

const SESSION_PREFIX = 'session-';

const CHATS = 'chats';

/**
 * How many folders below the root the watcher looks: down to the files in
 * `<project>/chats/<id>/`.
 */
export const WATCH_DEPTH = 3;

/** A chat log's kind, its project folder, and its parent for a subagent. */
export type ChatPath =
  | { readonly kind: 'main'; readonly project: string }
  | {
      readonly kind: 'subagent';
      readonly project: string;
      /** The folder it is in: the parent session's id. */
      readonly parentId: string;
    };

/** Whether `name`, in a `chats` folder, is a session's chat log. */
export function isSessionLog(name: string): boolean {
  return (
    name.startsWith(SESSION_PREFIX) &&
    name.endsWith(JSONL) &&
    name.length > SESSION_PREFIX.length + JSONL.length
  );
}

/** Whether `name`, in a session's folder under `chats`, is a chat log. */
export function isSubagentLog(name: string): boolean {
  return name.endsWith(JSONL) && name.length > JSONL.length;
}

/** What chat log the path with `parts` below the root is; null when none. */
function chatOf(parts: readonly string[]): ChatPath | null {
  const [project = '', second, third = '', fourth = ''] = parts;
  if (parts.length === 3 && second === CHATS && isSessionLog(third)) {
    return { kind: 'main', project };
  }
  if (
    parts.length === 4 &&
    second === CHATS &&
    third !== '' &&
    isSubagentLog(fourth)
  ) {
    return { kind: 'subagent', project, parentId: third };
  }
  return null;
}

/** What chat log `file` is; null when it is none (see the module comment). */
export function chatAt(root: string, file: string): ChatPath | null {
  const parts = partsBelow(root, file);
  return parts === null ? null : chatOf(parts);
}

/**
 * What the path with `parts` below the root is to the watcher: a chat log;
 * a folder chat logs live in (project folders, their `chats` folders and
 * the session folders in those); or neither.
 */
function watchedKind(parts: readonly string[]): WatchedKind {
  if (chatOf(parts) !== null) {
    return 'transcript';
  }
  const [, second] = parts;
  return parts.length === 1 ||
    (parts.length === 2 && second === CHATS) ||
    (parts.length === 3 && second === CHATS)
    ? 'folder'
    : null;
}

/**
 * Whether the watcher should follow `entry`: the root, the folders chat
 * logs live in, and chat logs modified recently (`recent(mtimeMs)`; see
 * shouldFollow, which also takes the BigInt modification time chokidar
 * gives on Windows).
 */
export function shouldWatch(
  root: string,
  entry: string,
  stats: WatchedStats | undefined,
  recent: (mtimeMs: number) => boolean,
): boolean {
  return shouldFollow(root, entry, stats, recent, watchedKind);
}
