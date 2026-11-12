/**
 * main/detection/adapters/cursor/paths: which files under Cursor's projects
 * folder (`~/.cursor/projects`, the root) are agent transcripts (Story
 * 2.7). Only these two kinds are ever opened:
 *
 * - `<root>/<slug>/agent-transcripts/<id>/<id>.jsonl`: a session's
 *   transcript (the IDE's and cursor-agent's alike); `<id>`, the name of
 *   its folder and of the file, is the session's native id;
 * - `<root>/<slug>/agent-transcripts/<id>/subagents/<name>.jsonl`: one of
 *   its subagents' transcripts, which belongs to session `<id>`.
 *
 * `<slug>` is the project's path with every character that is not a letter
 * or a digit turned into `-` (./project-name reads it back). Everything
 * else under the root (the files beside the project folders, and each
 * project's `canvases`, `mcps`, `assets`, `agent-tools`, `terminals` and
 * the rest) is never followed or opened.
 */
import {
  partsBelow,
  shouldFollow,
  type WatchedKind,
  type WatchedStats,
} from '../jsonl/watcher';

const JSONL = '.jsonl';

const AGENT_TRANSCRIPTS = 'agent-transcripts';

const SUBAGENTS = 'subagents';

/**
 * How many folders below the root the watcher looks: down to the files in
 * `<slug>/agent-transcripts/<id>/subagents/`.
 */
export const WATCH_DEPTH = 4;

/** A transcript's kind, its project's slug, and the session it belongs to. */
export interface TranscriptPath {
  readonly kind: 'main' | 'subagent';
  /** The project folder's name under the root. */
  readonly slug: string;
  /** The session's id: its folder's name (the parent's, for a subagent). */
  readonly id: string;
}

/** Whether `name`, in a session's `subagents` folder, is a transcript. */
export function isSubagentTranscript(name: string): boolean {
  return name.endsWith(JSONL) && name.length > JSONL.length;
}

/** The name of session `id`'s own transcript, in its folder. */
export function sessionTranscriptName(id: string): string {
  return `${id}${JSONL}`;
}

/** The folder under a project folder that holds its transcripts. */
export const TRANSCRIPTS_FOLDER = AGENT_TRANSCRIPTS;

/** The folder under a session's folder that holds its subagents'. */
export const SUBAGENTS_FOLDER = SUBAGENTS;

/** What transcript the path with `parts` below the root is; null when none. */
function transcriptOf(parts: readonly string[]): TranscriptPath | null {
  const [slug = '', second, id = '', fourth = '', fifth = ''] = parts;
  if (second !== AGENT_TRANSCRIPTS || slug === '' || id === '') {
    return null;
  }
  if (parts.length === 4 && fourth === sessionTranscriptName(id)) {
    return { kind: 'main', slug, id };
  }
  if (
    parts.length === 5 &&
    fourth === SUBAGENTS &&
    isSubagentTranscript(fifth)
  ) {
    return { kind: 'subagent', slug, id };
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

/**
 * What the path with `parts` below the root is to the watcher: a
 * transcript; a folder transcripts live in (project folders, their
 * `agent-transcripts` folders, the session folders in those and their
 * `subagents` folders); or neither.
 */
function watchedKind(parts: readonly string[]): WatchedKind {
  if (transcriptOf(parts) !== null) {
    return 'transcript';
  }
  const [, second, , fourth] = parts;
  if (parts.length === 1) {
    return 'folder';
  }
  if (second !== AGENT_TRANSCRIPTS) {
    return null;
  }
  return parts.length === 2 ||
    parts.length === 3 ||
    (parts.length === 4 && fourth === SUBAGENTS)
    ? 'folder'
    : null;
}

/**
 * Whether the watcher should follow `entry`: the root, the folders
 * transcripts live in, and transcripts modified recently
 * (`recent(mtimeMs)`; see shouldFollow, which also takes the BigInt
 * modification time chokidar gives on Windows).
 */
export function shouldWatch(
  root: string,
  entry: string,
  stats: WatchedStats | undefined,
  recent: (mtimeMs: number) => boolean,
): boolean {
  return shouldFollow(root, entry, stats, recent, watchedKind);
}
