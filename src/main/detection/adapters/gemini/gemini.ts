/**
 * main/detection/adapters/gemini: the Gemini CLI adapter (Story 2.6). It
 * reads the chat logs under Gemini CLI's temporary folder (`~/.gemini/tmp`,
 * injected as `root`) and translates their records into shared events
 * (./translate).
 *
 * Following the chat logs (replay at start, reading changes, watching,
 * health, the folder going away and coming back) is the shared JSON Lines
 * adapter's (../jsonl/log-adapter). What is Gemini CLI's own is here:
 *
 * - which files are chat logs and which session each belongs to, and
 *   which paths the watcher follows (./paths);
 * - a chat log's session id is in its first line, the header: a chat log
 *   is followed only once that line is a header with a session id
 *   (`startState`), whatever part of it is read first;
 * - the initial scan: every session's chat log, then every subagent's
 *   (replayed after the sessions, so a subagent's session has been read);
 * - the translation of a record, and the display name sent again after a
 *   read of a session's own chat log (./translate);
 * - a subagent's records count only once its parent session (`gemini:<the
 *   folder's name>`) has started in a chat log read; until then they are
 *   skipped. Each of them is only the parent's `activity`.
 *
 * Known limits (the chat log writes tool calls only once their batch has
 * finished, and never the end of a turn; SOURCE_CAPABILITIES):
 *
 * - while `ask_user` waits for the answer, nothing shows it is a question:
 *   it is guessed to be an approval (要你批准), not a question (要你決定);
 * - a tool that runs longer than approvalInferMs (a build) is guessed to
 *   wait for approval too;
 * - a tool called after the model said something, while it waits for
 *   approval or runs longer than TURN_END_INFER_MS, makes the turn look
 *   ended: 做完了, then 等你回覆 (both guessed), back to 思考中 once the tool
 *   calls are written;
 * - a model reply with neither text nor tool calls leaves its placeholder
 *   tool call open (工作中, then a guessed 要你批准) until the next prompt
 *   or turn end;
 * - a chat log replayed from its last REPLAY_TAIL_BYTES loses any
 *   `$set.summary` or `$set.sessionId` written before that tail: the name
 *   falls back to the project folder until a newer summary;
 * - nothing tells that a session ended: a session ends when it expires,
 *   even when Gemini CLI deleted its empty chat log on exit.
 *
 * Read-only: it opens only the chat logs ./paths names, to read. The log
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
  chatAt,
  isSessionLog,
  isSubagentLog,
  shouldWatch,
  WATCH_DEPTH,
} from './paths';
import {
  type ChatKind,
  type ChatState,
  currentNameEvent,
  NEW_CHAT,
  startChat,
  translateRecord,
} from './translate';

const SOURCE = 'gemini';

const CHATS = 'chats';

export interface GeminiAdapterOptions {
  /** Gemini CLI's temporary folder: `~/.gemini/tmp`. */
  readonly root: string;
  /** The file system, read-only (default node:fs). */
  readonly fs?: TranscriptFs;
  /** Starts the watcher (default chokidar). */
  readonly watch?: WatchTranscripts;
}

/** A chat log: its kind, its project folder, and a subagent's parent. */
interface ChatLog {
  readonly kind: ChatKind;
  readonly project: string;
  /** `gemini:<id>` of a subagent's parent session; null otherwise. */
  readonly parentKey: SessionKey | null;
}

/** What chat log `file` under `root` is; null when it is none. */
function locate(root: string, file: string): ChatLog | null {
  const where = chatAt(root, file);
  if (where === null) {
    return null;
  }
  if (where.kind === 'main') {
    return { kind: 'main', project: where.project, parentKey: null };
  }
  const parentKey = makeSessionKey(SOURCE, where.parentId);
  return parentKey === null
    ? null
    : { kind: 'subagent', project: where.project, parentKey };
}

/**
 * Every chat log under the temporary folder `root`: sessions' first, then
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
    const chats = path.join(root, project.name, CHATS);
    for (const entry of list(chats)) {
      if (entry.isFile() && isSessionLog(entry.name)) {
        sessions.push(path.join(chats, entry.name));
      } else if (entry.isDirectory()) {
        const dir = path.join(chats, entry.name);
        for (const sub of list(dir)) {
          if (sub.isFile() && isSubagentLog(sub.name)) {
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

export function createGeminiAdapter({
  root,
  fs,
  watch,
}: GeminiAdapterOptions): DetectionAdapter {
  /** Sessions started in a chat log read: their subagents count. */
  const readSessions = new Set<SessionKey>();
  return createJsonlLogAdapter<ChatLog, ChatState>({
    source: SOURCE,
    logPrefix: SOURCE,
    root,
    rootName: 'tmp folder',
    fs,
    watch,
    watchDepth: WATCH_DEPTH,
    locate,
    follow: shouldWatch,
    scan,
    initialState: NEW_CHAT,
    startState: startChat,
    translate: translateRecord,
    nameEvent: currentNameEvent,
    gate: {
      allows: (where, tracked) =>
        where.kind !== 'subagent' ||
        tracked ||
        (where.parentKey !== null && readSessions.has(where.parentKey)),
      read(where, state) {
        if (
          where.kind === 'main' &&
          state.started &&
          state.sessionId !== null
        ) {
          const key = makeSessionKey(SOURCE, state.sessionId);
          if (key !== null) {
            readSessions.add(key);
          }
        }
      },
      reset() {
        readSessions.clear();
      },
    },
  });
}
