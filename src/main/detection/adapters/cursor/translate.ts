/**
 * main/detection/adapters/cursor/translate: one Cursor agent transcript
 * record in, the shared events it stands for out (Story 2.7). Pure: no
 * file, clock or log; what it remembers between records of one transcript
 * is the TranscriptState it is handed and returns.
 *
 * A transcript (`<id>.jsonl`, the IDE's and cursor-agent's alike) is JSON
 * Lines of two kinds of record: a message, `{ role, message: { content:
 * [...] } }`, `user` or `assistant`, and the end of a turn, `{ type:
 * 'turn_ended', status, error? }`. A user message's content is text; an
 * assistant's is text and `tool_use` parts (`{ type, name, input }`, with
 * no id). Cursor writes one assistant record per step, once the step is
 * done; tool results, approvals, the answer to `AskQuestion` and times are
 * never written.
 *
 * Records are read leniently (../jsonl/records): any JSON object is a
 * record, unknown fields and types are let through, and a field of the
 * wrong type counts as missing. Every event is `via: 'log'`, `confidence:
 * 'exact'`, and `replay: true` when the record is replayed. Records carry
 * no time: every event's `ts` is the context's fallback, the file's
 * modification time.
 *
 * A session's own transcript, per record, in this order:
 *
 * - the first `user` or `assistant` message: `session.start` first, then
 *   `session.meta` with the display name (the project folder's name, see
 *   ./project-name). Before it, nothing is sent at all;
 * - any record ends the tool calls the previous assistant record opened:
 *   their `tool.end` (a turn end closes them by itself);
 * - `user`: `turn.start`;
 * - `assistant` with `tool_use` parts: `tool.start` for each (`toolCallId`
 *   `step<n>:<k>`, the n-th assistant record with tool calls, its k-th
 *   part of them, both from 1; `toolName` its `name`), left open until the
 *   next record; with none (text only), `activity`;
 * - `turn_ended` whose `status` is `success`, or whose `error` is
 *   USER_ABORTED (the user stopped the turn): `turn.end`;
 * - `turn_ended` with any other error: `error`, then `turn.end`;
 * - any other record: `activity`;
 * - a `turn.end` is left out when the last turn event this transcript sent
 *   was a `turn.end` too (a `turn.start` or `tool.start` since resets it);
 *   a record whose only event was such a `turn.end` sends `activity`.
 *
 * A subagent's transcript (`<id>/subagents/*.jsonl`) speaks for the parent
 * session: each of its records is the parent's `activity`.
 *
 * Tool names that are not strings of 1 to DETECTION_ID_MAX_LENGTH
 * characters are skipped (that call gives no event); the display name is
 * trimmed and cut to that length.
 */
import {
  DETECTION_ID_MAX_LENGTH,
  type DetectionEvent,
  type SessionKey,
} from '../../../../shared/detection-events';
import { type Fields, isObject } from '../jsonl/records';

const SOURCE = 'cursor';

/** The `error` of a `turn_ended` the user stopped. */
export const USER_ABORTED = 'User aborted request';

/** The `type` of the record that ends a turn. */
export const TURN_ENDED = 'turn_ended';

/** What a transcript's records are: a session's own, or a subagent's. */
export type TranscriptKind = 'main' | 'subagent';

/** What translation remembers between the records of one transcript. */
export interface TranscriptState {
  /** `session.start` was sent (a session's own transcript only). */
  readonly started: boolean;
  /** The `toolCallId`s the last assistant record opened, still open. */
  readonly openTools: readonly string[];
  /** How many assistant records with tool calls were read. */
  readonly step: number;
  /** The last turn event sent was a `turn.end`. */
  readonly turnEnded: boolean;
}

/** A transcript nothing has been read from. */
export const NEW_TRANSCRIPT: TranscriptState = Object.freeze({
  started: false,
  openTools: Object.freeze([]),
  step: 0,
  turnEnded: false,
});

/** Where a record comes from. */
export interface RecordContext {
  readonly kind: TranscriptKind;
  /** `cursor:<id>`: the session's own (its parent's, for a subagent). */
  readonly sessionKey: SessionKey;
  /** The session's display name; null when it has none. */
  readonly name: string | null;
  /** The record is replayed: its events carry `replay: true`. */
  readonly replay: boolean;
  /** Every event's `ts`: the file's modification time, epoch ms. */
  readonly fallbackTs: number;
}

export interface Translation {
  readonly state: TranscriptState;
  readonly events: readonly DetectionEvent[];
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

/** `value` if it can be a tool name; null otherwise. */
function toolNameOf(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DETECTION_ID_MAX_LENGTH
    ? value
    : null;
}

/** The parts of a message record's content; none when it has no list. */
function partsOf(record: Fields): readonly Fields[] {
  const message = record.message;
  return isObject(message) && Array.isArray(message.content)
    ? message.content.filter(isObject)
    : [];
}

/** The names of an assistant record's `tool_use` parts, null when unusable. */
export function toolUsesOf(record: Fields): readonly (string | null)[] {
  return partsOf(record)
    .filter((part) => part.type === 'tool_use')
    .map((part) => toolNameOf(part.name));
}

/**
 * Whether a `turn_ended` record ends the turn with an error: one that is
 * not USER_ABORTED, on a turn that did not end in `success`.
 */
export function endedInError(record: Fields): boolean {
  if (record.status === 'success' || record.error === USER_ABORTED) {
    return false;
  }
  return (
    record.status === 'error' ||
    (typeof record.error === 'string' && record.error.trim() !== '')
  );
}

/** What a record is. */
function kindOf(record: Fields): 'user' | 'assistant' | 'end' | 'other' {
  if (record.type === TURN_ENDED) {
    return 'end';
  }
  if (record.role === 'user' || record.role === 'assistant') {
    return record.role;
  }
  return 'other';
}

/** `tool.end` for each tool call `state` holds open. */
function closeTools(state: TranscriptState, common: Common): DetectionEvent[] {
  return state.openTools.map((toolCallId) => ({
    type: 'tool.end',
    ...common,
    toolCallId,
  }));
}

/**
 * The events `record`, read from a transcript in `state`, stands for, and
 * the transcript's state after it (see the module comment).
 */
export function translateRecord(
  record: Fields,
  state: TranscriptState,
  context: RecordContext,
): Translation {
  const common = commonFields(
    context.sessionKey,
    context.replay,
    context.fallbackTs,
  );
  if (context.kind === 'subagent') {
    return { state, events: [{ type: 'activity', ...common }] };
  }

  const kind = kindOf(record);
  const events: DetectionEvent[] = [];
  let current = state;
  if (!current.started) {
    if (kind !== 'user' && kind !== 'assistant') {
      return { state, events: [] };
    }
    events.push({ type: 'session.start', ...common });
    if (context.name !== null) {
      events.push({
        type: 'session.meta',
        ...common,
        displayName: context.name,
      });
    }
    current = { ...current, started: true };
  }

  // A turn end closes the open tool calls by itself.
  const recordEvents: DetectionEvent[] =
    kind === 'end' ? [] : closeTools(current, common);
  let { step, turnEnded } = current;
  let openTools: readonly string[] = [];
  switch (kind) {
    case 'user':
      recordEvents.push({ type: 'turn.start', ...common });
      turnEnded = false;
      break;
    case 'assistant': {
      const names = toolUsesOf(record);
      if (names.length > 0) {
        step += 1;
      }
      const opened: string[] = [];
      names.forEach((toolName, index) => {
        if (toolName === null) {
          return;
        }
        const toolCallId = `step${step}:${index + 1}`;
        opened.push(toolCallId);
        recordEvents.push({
          type: 'tool.start',
          ...common,
          toolCallId,
          toolName,
        });
      });
      if (opened.length > 0) {
        turnEnded = false;
      } else {
        recordEvents.push({ type: 'activity', ...common });
      }
      openTools = opened;
      break;
    }
    case 'end':
      if (endedInError(record)) {
        recordEvents.push({ type: 'error', ...common });
      }
      // One turn end per turn: a repeated turn_ended sends none.
      if (!turnEnded) {
        recordEvents.push({ type: 'turn.end', ...common });
      }
      turnEnded = true;
      break;
    case 'other':
      recordEvents.push({ type: 'activity', ...common });
      break;
  }
  if (recordEvents.length === 0) {
    recordEvents.push({ type: 'activity', ...common });
  }
  events.push(...recordEvents);
  return {
    state: { ...current, openTools, step, turnEnded },
    events,
  };
}

/**
 * The session's display name as a `session.meta`, dated at the fallback;
 * null before the session started, for a subagent, or when it has no
 * name. The adapter sends it again after each read of a session's own
 * transcript that produced events, so a session that comes back (after
 * expiring, or resumed) has its name.
 */
export function currentNameEvent(
  state: TranscriptState,
  context: RecordContext,
): DetectionEvent | null {
  if (context.kind !== 'main' || !state.started || context.name === null) {
    return null;
  }
  return {
    type: 'session.meta',
    ...commonFields(context.sessionKey, context.replay, context.fallbackTs),
    displayName: context.name,
  };
}
