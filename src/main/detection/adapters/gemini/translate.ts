/**
 * main/detection/adapters/gemini/translate: one Gemini CLI chat log record
 * in, the shared events it stands for out (Story 2.6). Pure: no file, clock
 * or log; what it remembers between records of one chat log is the
 * ChatState it is handed and returns.
 *
 * A chat log (`session-*.jsonl`) is JSON Lines: a header first (the
 * session id, the project hash, start and update times, `kind`), then
 * messages (`id`, `timestamp`, `type`, `content`, and for `gemini`
 * messages `toolCalls`), `$set` records (metadata: `summary`, `sessionId`,
 * `lastUpdated`, ...) and `$rewindTo` records. Gemini CLI writes a
 * `gemini` message once the model's stream is done; its tool calls only
 * once the whole batch has finished (`success`, `error` or `cancelled`),
 * by writing the message again with the same id and its `toolCalls`.
 * Waiting for approval and running are never written, and neither is the
 * end of a turn.
 *
 * Records are read leniently (../jsonl/records): any JSON object is a
 * record, unknown fields and types are let through, and a field of the
 * wrong type counts as missing. Every event is `via: 'log'`, `confidence:
 * 'exact'`, and `replay: true` when the record is replayed. Its `ts` is the
 * record's `timestamp`; for a `gemini` message with tool calls, the latest
 * of their `timestamp`s when they have any (the batch finished then, maybe
 * long after the message was first written); for a record without one
 * (`$set`), the latest of those read from the same chat log so far; before
 * any, the context's fallback (the file's modification time).
 *
 * A session's own chat log, per record, in this order:
 *
 * - the header (a record with a `sessionId` and no `type`): nothing when it
 *   is the session's id (a read from the start reads it again); a
 *   different one is handled as a `$set.sessionId`;
 * - the first `user` or `gemini` message: `session.start` first, then
 *   `session.meta` with the display name (the latest summary, else the
 *   project folder's name). Before it, nothing is sent at all: a session
 *   opened with no prompt (only `info` messages) does not show;
 * - `user` whose content is not a `functionResponse`: `turn.start` (after
 *   the open placeholder's `tool.end`, see below);
 * - `gemini` with no `toolCalls` and no text: the model asked for tools
 *   that are not written yet. A placeholder `tool.start` (`toolCallId`
 *   `pending:<message id>`, `toolName` `pending`), so the session is
 *   working and, long enough, guessed to wait for approval;
 * - `gemini` with no `toolCalls` and text: `turn.reply` (the turn may end
 *   here: main/detection/inference guesses it did if nothing newer comes);
 * - `gemini` with `toolCalls` (the same message written again): the open
 *   placeholder's `tool.end`; `tool.start` and `tool.end` for each call
 *   (`id`, `name`); then, when any call is not `cancelled`, `turn.start`
 *   (the model goes on with their results; it reopens a turn that was
 *   guessed to have ended, and changes nothing within one);
 * - a `gemini` message with another id, or with text, also ends an open
 *   placeholder first; one with the same id and no text leaves it open;
 * - `info` whose content is `Request cancelled.` (Esc, or an approval
 *   turned down): `turn.end`;
 * - `error`: `error`, then `turn.end`;
 * - `$set` with a `summary`: `session.meta` with it, from then on the
 *   display name;
 * - `$set` with a `sessionId` other than the session's: the session ends
 *   (`session.end`, if it started) and the chat log speaks for the new
 *   session from its next message;
 * - any other message (`user` with a `functionResponse`, any other `info`,
 *   `warning`, ...): `activity`;
 * - any other `$set`, `$rewindTo`, and any other record: nothing;
 * - a `turn.end` is left out when the last turn event this chat log sent
 *   was a `turn.end` too (a `turn.start` or `tool.start` since resets it);
 *   a message whose only event was such a `turn.end` sends `activity`.
 *
 * A subagent's chat log (`chats/<parent id>/*.jsonl`) speaks for the
 * parent session: each record but its own header is the parent's
 * `activity`. Its tool calls are written only once finished too, so they
 * would show no work; its turns, errors and summaries send nothing.
 *
 * Ids and names that are not strings of 1 to DETECTION_ID_MAX_LENGTH
 * characters are skipped (a tool call without a usable id or name gives no
 * event); display names are trimmed and cut to that length.
 */
import {
  DETECTION_ID_MAX_LENGTH,
  type DetectionEvent,
  makeSessionKey,
  type SessionKey,
} from '../../../../shared/detection-events';
import {
  displayNameOf,
  type Fields,
  isObject,
  timestampOf,
} from '../jsonl/records';

const SOURCE = 'gemini';

/** The content of the `info` message Gemini CLI writes when a request is cancelled. */
export const REQUEST_CANCELLED = 'Request cancelled.';

/** The tool name and call id prefix of the placeholder tool call. */
export const PENDING_TOOL = 'pending';

const PENDING_PREFIX = `${PENDING_TOOL}:`;

/** What a chat log's records are: a session's own, or a subagent's. */
export type ChatKind = 'main' | 'subagent';

/** What translation remembers between the records of one chat log. */
export interface ChatState {
  /**
   * The session the chat log writes for now: its header's id, or a later
   * `$set.sessionId`; a subagent's own id for its chat log. Null before
   * any is known.
   */
  readonly sessionId: string | null;
  /** `session.start` was sent for it (main chat logs only). */
  readonly started: boolean;
  /** The latest summary read; null before any. */
  readonly summary: string | null;
  /** The project folder's name: the display name before a summary. */
  readonly project: string | null;
  /** The id of the last `gemini` message read; null before any. */
  readonly lastGeminiId: string | null;
  /** A placeholder `tool.start` for lastGeminiId is open. */
  readonly pending: boolean;
  /** The last turn event sent was a `turn.end`. */
  readonly turnEnded: boolean;
  /** The latest `timestamp` read so far, epoch ms; null before any. */
  readonly latestTs: number | null;
}

/** A chat log nothing has been read from, its session not known yet. */
export const NEW_CHAT: ChatState = Object.freeze({
  sessionId: null,
  started: false,
  summary: null,
  project: null,
  lastGeminiId: null,
  pending: false,
  turnEnded: false,
  latestTs: null,
});

/** Where a record comes from. */
export interface RecordContext {
  readonly kind: ChatKind;
  /** The project folder's name (the folder under the root). */
  readonly project: string;
  /** For a subagent's chat log, its parent session; null otherwise. */
  readonly parentKey: SessionKey | null;
  /** The record is replayed: its events carry `replay: true`. */
  readonly replay: boolean;
  /**
   * The `ts` of a record when neither it nor any earlier record of the
   * chat log has a timestamp: the file's modification time, epoch ms.
   */
  readonly fallbackTs: number;
}

export interface Translation {
  readonly state: ChatState;
  readonly events: readonly DetectionEvent[];
}

/** `value` if it can be an id or tool name of at most `max`; null otherwise. */
function idOf(value: unknown, max = DETECTION_ID_MAX_LENGTH): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null;
}

/** The session id `value` names, if it can be a native id; null otherwise. */
function sessionIdOf(value: unknown): string | null {
  return typeof value === 'string' && makeSessionKey(SOURCE, value) !== null
    ? value
    : null;
}

/** Whether `record` is a header: a `sessionId` and no `type`. */
function isHeader(record: Fields): boolean {
  return (
    record.type === undefined &&
    record.$set === undefined &&
    record.$rewindTo === undefined &&
    typeof record.sessionId === 'string'
  );
}

/**
 * The session id in chat log header `first`; null when it is not a header
 * with a usable one.
 */
export function headerSessionId(first: Fields | null): string | null {
  return first !== null && isHeader(first)
    ? sessionIdOf(first.sessionId)
    : null;
}

/**
 * A chat log's starting state, from its first line `first`: null (not
 * followed yet) unless that is a header with a usable session id.
 */
export function startChat(
  first: Fields | null,
  context: Pick<RecordContext, 'project'>,
): ChatState | null {
  const sessionId = headerSessionId(first);
  return sessionId === null
    ? null
    : { ...NEW_CHAT, sessionId, project: displayNameOf(context.project) };
}

/** Whether `part` of a content list carries non-blank text. */
function partHasText(part: unknown): boolean {
  if (typeof part === 'string') {
    return part.trim() !== '';
  }
  return isObject(part) && typeof part.text === 'string'
    ? part.text.trim() !== ''
    : false;
}

/**
 * The parts of a message's `content` that is not a string: a part list, or
 * one part on its own; none for anything else.
 */
function partsOf(content: unknown): readonly unknown[] {
  return Array.isArray(content) ? content : isObject(content) ? [content] : [];
}

/** Whether a message's `content` carries text (not blank). */
export function hasText(content: unknown): boolean {
  return typeof content === 'string'
    ? content.trim() !== ''
    : partsOf(content).some(partHasText);
}

/** Whether a message's `content` holds a tool's `functionResponse`. */
export function isFunctionResponse(content: unknown): boolean {
  return partsOf(content).some(
    (part) => isObject(part) && isObject(part.functionResponse),
  );
}

/** Whether an `info` message's `content` is REQUEST_CANCELLED. */
function isCancelled(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.trim() === REQUEST_CANCELLED;
  }
  const texts = partsOf(content).filter(partHasText);
  const [only] = texts;
  const text =
    typeof only === 'string' ? only : isObject(only) ? only.text : '';
  return texts.length === 1 && String(text).trim() === REQUEST_CANCELLED;
}

/** The tool calls of a `gemini` message; empty when it has none. */
function toolCallsOf(record: Fields): readonly Fields[] {
  return Array.isArray(record.toolCalls)
    ? record.toolCalls.filter(isObject)
    : [];
}

/**
 * When a `gemini` message's tool calls finished: the latest of their
 * `timestamp`s; null when it has none, or is no `gemini` message.
 */
function toolCallsTsOf(record: Fields): number | null {
  if (record.type !== 'gemini') {
    return null;
  }
  let latest: number | null = null;
  for (const call of toolCallsOf(record)) {
    const ts = timestampOf(call);
    if (ts !== null && (latest === null || ts > latest)) {
      latest = ts;
    }
  }
  return latest;
}

/** The fields every event of a record carries. */
function commonFields(sessionKey: SessionKey, replay: boolean, ts: number) {
  const fields = {
    source: SOURCE,
    sessionKey,
    ts,
    via: 'log',
    confidence: 'exact',
  } as const;
  return replay ? { ...fields, replay: true as const } : fields;
}

type Common = ReturnType<typeof commonFields>;

/** The display name of a session in `state`; null when it has none. */
function nameOf(state: ChatState): string | null {
  return state.summary ?? state.project;
}

/** The session `state` writes for, as a key; null when none is known. */
function keyOf(state: ChatState): SessionKey | null {
  return state.sessionId === null
    ? null
    : makeSessionKey(SOURCE, state.sessionId);
}

/** The placeholder's `tool.end` for `state`'s open placeholder, if any. */
function pendingEnd(state: ChatState, common: Common): DetectionEvent[] {
  return state.pending && state.lastGeminiId !== null
    ? [
        {
          type: 'tool.end',
          ...common,
          toolCallId: `${PENDING_PREFIX}${state.lastGeminiId}`,
        },
      ]
    : [];
}

/** A message's own events (no `session.start`), and the state after them. */
function messageEvents(
  record: Fields,
  state: ChatState,
  common: Common,
): { readonly state: ChatState; readonly events: DetectionEvent[] } {
  switch (record.type) {
    case 'user': {
      if (isFunctionResponse(record.content)) {
        return { state, events: [{ type: 'activity', ...common }] };
      }
      return {
        state: { ...state, pending: false },
        events: [
          ...pendingEnd(state, common),
          { type: 'turn.start', ...common },
        ],
      };
    }
    case 'gemini': {
      const id = idOf(
        record.id,
        DETECTION_ID_MAX_LENGTH - PENDING_PREFIX.length,
      );
      const calls = toolCallsOf(record);
      if (calls.length > 0) {
        const events = pendingEnd(state, common);
        for (const call of calls) {
          const toolCallId = idOf(call.id);
          const toolName = idOf(call.name);
          if (toolCallId !== null && toolName !== null) {
            events.push(
              { type: 'tool.start', ...common, toolCallId, toolName },
              { type: 'tool.end', ...common, toolCallId },
            );
          }
        }
        if (calls.some((call) => call.status !== 'cancelled')) {
          events.push({ type: 'turn.start', ...common });
        }
        return {
          state: { ...state, lastGeminiId: id, pending: false },
          events,
        };
      }
      const seen = id !== null && id === state.lastGeminiId;
      const text = hasText(record.content);
      const events: DetectionEvent[] =
        state.pending && (!seen || text) ? pendingEnd(state, common) : [];
      let pending = state.pending && seen && !text;
      if (text) {
        events.push({ type: 'turn.reply', ...common });
      } else if (!seen && id !== null) {
        events.push({
          type: 'tool.start',
          ...common,
          toolCallId: `${PENDING_PREFIX}${id}`,
          toolName: PENDING_TOOL,
        });
        pending = true;
      }
      return { state: { ...state, lastGeminiId: id, pending }, events };
    }
    case 'info':
      return isCancelled(record.content)
        ? { state, events: [{ type: 'turn.end', ...common }] }
        : { state, events: [{ type: 'activity', ...common }] };
    case 'error':
      return {
        state,
        events: [
          { type: 'error', ...common },
          { type: 'turn.end', ...common },
        ],
      };
    default:
      return { state, events: [{ type: 'activity', ...common }] };
  }
}

/**
 * The chat log now writes for session `sessionId`: the current session's
 * `session.end` if it started, and a state that starts the new one at its
 * next message.
 */
function switchSession(
  state: ChatState,
  sessionId: string,
  common: Common | null,
): { readonly state: ChatState; readonly events: DetectionEvent[] } {
  return {
    state: {
      ...NEW_CHAT,
      sessionId,
      project: state.project,
      latestTs: state.latestTs,
    },
    events:
      state.started && common !== null
        ? [{ type: 'session.end', ...common }]
        : [],
  };
}

/**
 * The events `record`, read from a chat log in `state`, stands for, and the
 * chat log's state after it (see the module comment).
 */
export function translateRecord(
  record: Fields,
  state: ChatState,
  context: RecordContext,
): Translation {
  const own = toolCallsTsOf(record) ?? timestampOf(record);
  const latestTs =
    own === null
      ? state.latestTs
      : state.latestTs === null
        ? own
        : Math.max(state.latestTs, own);
  const ts = own ?? state.latestTs ?? context.fallbackTs;
  const dated: ChatState =
    latestTs === state.latestTs ? state : { ...state, latestTs };

  if (context.kind === 'subagent') {
    const ownHeader =
      isHeader(record) &&
      (state.sessionId === null || record.sessionId === state.sessionId);
    if (ownHeader || context.parentKey === null) {
      return {
        state:
          ownHeader && state.sessionId === null
            ? { ...dated, sessionId: sessionIdOf(record.sessionId) }
            : dated,
        events: [],
      };
    }
    return {
      state: dated,
      events: [
        {
          type: 'activity',
          ...commonFields(context.parentKey, context.replay, ts),
        },
      ],
    };
  }

  const key = keyOf(dated);
  const common = key === null ? null : commonFields(key, context.replay, ts);

  if (isHeader(record)) {
    const sessionId = sessionIdOf(record.sessionId);
    if (sessionId === null || sessionId === dated.sessionId) {
      return { state: dated, events: [] };
    }
    if (dated.sessionId === null) {
      return { state: { ...dated, sessionId }, events: [] };
    }
    return switchSession(dated, sessionId, common);
  }

  if (isObject(record.$set)) {
    const set = record.$set;
    let current = dated;
    const events: DetectionEvent[] = [];
    const sessionId = sessionIdOf(set.sessionId);
    if (sessionId !== null && sessionId !== current.sessionId) {
      const switched = switchSession(current, sessionId, common);
      current = switched.state;
      events.push(...switched.events);
    }
    const summary = displayNameOf(set.summary);
    if (summary !== null && summary !== current.summary) {
      current = { ...current, summary };
      const newKey = keyOf(current);
      if (current.started && newKey !== null) {
        events.push({
          type: 'session.meta',
          ...commonFields(newKey, context.replay, ts),
          displayName: summary,
        });
      }
    }
    return { state: current, events };
  }

  if (typeof record.type !== 'string' || common === null) {
    return { state: dated, events: [] };
  }

  const events: DetectionEvent[] = [];
  let current = dated;
  if (!current.started) {
    if (record.type !== 'user' && record.type !== 'gemini') {
      return { state: current, events: [] };
    }
    events.push({ type: 'session.start', ...common });
    const name = nameOf(current);
    if (name !== null) {
      events.push({ type: 'session.meta', ...common, displayName: name });
    }
    current = { ...current, started: true };
  }

  const message = messageEvents(record, current, common);
  current = message.state;
  let { turnEnded, pending } = current;
  const recordEvents = message.events.filter((event) => {
    // One turn end per turn: a repeated turn.end is left out.
    if (event.type === 'turn.end') {
      const repeated = turnEnded;
      turnEnded = true;
      // A turn end closes every tool call, the placeholder's too.
      pending = false;
      return !repeated;
    }
    if (event.type === 'turn.start' || event.type === 'tool.start') {
      turnEnded = false;
    }
    return true;
  });
  events.push(...recordEvents);
  if (recordEvents.length === 0) {
    events.push({ type: 'activity', ...common });
  }
  return { state: { ...current, turnEnded, pending }, events };
}

/**
 * The session's current display name as a `session.meta`, dated at the
 * chat log's latest timestamp (else the fallback); null before the session
 * started or when it has no name. The adapter sends it again after each
 * read of a session's own chat log that produced events, so a session
 * that comes back (after expiring, or resumed) has its name.
 */
export function currentNameEvent(
  state: ChatState,
  context: RecordContext,
): DetectionEvent | null {
  const key = keyOf(state);
  const name = nameOf(state);
  if (
    context.kind !== 'main' ||
    !state.started ||
    key === null ||
    name === null
  ) {
    return null;
  }
  return {
    type: 'session.meta',
    ...commonFields(key, context.replay, state.latestTs ?? context.fallbackTs),
    displayName: name,
  };
}
