/**
 * main/detection/adapters/claude-code/translate: one Claude Code transcript
 * record in, the shared events it stands for out (Story 2.4). Pure: no
 * file, clock or log; what it remembers between records of one transcript
 * is the TranscriptState it is handed and returns.
 *
 * Records are read leniently: any JSON object is a record, unknown fields
 * and record types are let through, and a field of the wrong type counts as
 * missing. Every event is `via: 'log'`, `confidence: 'exact'`, and
 * `replay: true` when the record is replayed. Its `ts` is the record's
 * `timestamp`; for a record without one, the latest `timestamp` read from
 * the same transcript so far; before any, the context's fallback (the
 * file's modification time).
 *
 * A main transcript (`<cwd>/<id>.jsonl`), per record, in this order:
 *
 * - its first record: `session.start` first;
 * - `custom-title` with a `customTitle`: `session.meta` with it; it
 *   outranks an AI title from then on;
 * - `ai-title` with an `aiTitle`, unless a custom title was read:
 *   `session.meta` with it;
 * - any other record with a `cwd`, while no name has been sent: first
 *   `session.meta` with the working folder's name;
 * - `user`: `tool.end` for each `tool_result` block (`tool_use_id`); then
 *   `turn.end` when its only text is one of the interrupt texts Claude Code
 *   writes when the user presses Esc; otherwise `turn.start` when it is not
 *   `isMeta` or `isCompactSummary` and its content is a string, or a block
 *   list with no `tool_result`;
 * - `assistant`: `error` when `isApiErrorMessage`; `tool.start` for each
 *   `tool_use` block (`id`, `name`); then `turn.end` when
 *   `message.stop_reason` ends the turn (`end_turn`, `stop_sequence`,
 *   `max_tokens`, `refusal`);
 * - a `turn.end` is left out when the last turn event this transcript sent
 *   was a `turn.end` too (a `turn.start` or `tool.start` since resets it):
 *   one message written as several records ends its turn once. Whether a
 *   turn is open is not tracked (a tail replay can start in the middle of
 *   one);
 * - a record that gave none of those events and has a `timestamp`:
 *   `activity`; one without gives nothing.
 *
 * A subagent transcript (`<cwd>/<id>/subagents/*.jsonl`) speaks for the
 * parent session: each `tool_use` of an `assistant` record is its
 * `tool.start`, each `tool_result` of a `user` record its `tool.end` (so a
 * subagent's tool call waiting for approval is guessed at on the parent);
 * any other record, timestamped or not, is an `activity`. Its turns, errors
 * and titles send nothing.
 *
 * Ids and names that are not strings of 1 to DETECTION_ID_MAX_LENGTH
 * characters are skipped (a tool block without a usable id gives no event);
 * display names are trimmed and cut to that length.
 */
import {
  DETECTION_ID_MAX_LENGTH,
  type DetectionEvent,
  type SessionKey,
} from '../../../../shared/detection-events';

/** The texts of the record Claude Code writes when the user interrupts. */
export const INTERRUPT_TEXTS: readonly string[] = Object.freeze([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

/** `message.stop_reason` values that end the turn. */
const TURN_END_STOP_REASONS: readonly string[] = [
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
];

/** What a transcript's records are: the session's own, or a subagent's. */
export type TranscriptKind = 'main' | 'subagent';

/** Where the session's display name came from, best last. */
export type NameSource = 'cwd' | 'ai-title' | 'custom-title';

/** What translation remembers between the records of one transcript. */
export interface TranscriptState {
  /** `session.start` was sent (main transcripts only). */
  readonly started: boolean;
  /** Where the display name last sent came from; null before any. */
  readonly named: NameSource | null;
  /** The display name last sent; null before any. */
  readonly name: string | null;
  /** The last turn event sent was a `turn.end`. */
  readonly turnEnded: boolean;
  /** The latest `timestamp` read so far, epoch ms; null before any. */
  readonly latestTs: number | null;
}

/** A transcript nothing has been read from. */
export const NEW_TRANSCRIPT: TranscriptState = Object.freeze({
  started: false,
  named: null,
  name: null,
  turnEnded: false,
  latestTs: null,
});

/** Where a record comes from. */
export interface RecordContext {
  /** The session: `claude-code:<id>` (the parent's, for a subagent). */
  readonly sessionKey: SessionKey;
  readonly kind: TranscriptKind;
  /** The record is replayed: its events carry `replay: true`. */
  readonly replay: boolean;
  /**
   * The `ts` of a record when neither it nor any earlier record of the
   * transcript has a timestamp: the file's modification time, epoch ms.
   */
  readonly fallbackTs: number;
}

export interface Translation {
  readonly state: TranscriptState;
  readonly events: readonly DetectionEvent[];
}

type Fields = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The record's `timestamp` in epoch ms, or null when it has none usable. */
export function timestampOf(record: Fields): number | null {
  const value = record.timestamp;
  const ms =
    typeof value === 'string'
      ? Date.parse(value)
      : typeof value === 'number'
        ? value
        : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const whole = Math.floor(ms);
  return Number.isSafeInteger(whole) ? whole : null;
}

/** `value` if it can be an id or tool name; null otherwise. */
function idOf(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DETECTION_ID_MAX_LENGTH
    ? value
    : null;
}

/**
 * `value` trimmed and cut to DETECTION_ID_MAX_LENGTH (never in the middle
 * of a surrogate pair), if it is a non-blank string; null otherwise.
 */
export function displayNameOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length <= DETECTION_ID_MAX_LENGTH) {
    return trimmed;
  }
  const cut = trimmed.slice(0, DETECTION_ID_MAX_LENGTH);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The name of the folder `cwd` names: its last part (`/Users/me/proj` and
 * `C:\Users\me\proj` give `proj`); `/` stays `/`.
 */
export function folderNameOf(cwd: unknown): string | null {
  if (typeof cwd !== 'string') {
    return null;
  }
  const last = cwd.split(/[\\/]+/).findLast((part) => part !== '');
  return displayNameOf(last ?? cwd);
}

/** The content blocks of the record's message; null when it has no list. */
function blocksOf(content: unknown): readonly Fields[] | null {
  return Array.isArray(content) ? content.filter(isObject) : null;
}

/** Whether the only text in `content` is one of the interrupt texts. */
function isInterrupt(content: unknown): boolean {
  if (typeof content === 'string') {
    return INTERRUPT_TEXTS.includes(content);
  }
  const blocks = blocksOf(content);
  if (blocks === null) {
    return false;
  }
  const texts = blocks.filter((block) => block.type === 'text');
  const [only] = texts;
  return (
    texts.length === 1 &&
    typeof only?.text === 'string' &&
    INTERRUPT_TEXTS.includes(only.text)
  );
}

/** The fields every event of this record carries. */
function commonFields(context: RecordContext, ts: number) {
  const fields = {
    source: 'claude-code',
    sessionKey: context.sessionKey,
    ts,
    via: 'log',
    confidence: 'exact',
  } as const;
  return context.replay ? { ...fields, replay: true as const } : fields;
}

type Common = ReturnType<typeof commonFields>;

/** The record's message; an empty one when it has none. */
function messageOf(record: Fields): Fields {
  return isObject(record.message) ? record.message : {};
}

/** `tool.end` for each `tool_result` block of a `user` record. */
function toolEnds(record: Fields, common: Common): DetectionEvent[] {
  const events: DetectionEvent[] = [];
  for (const block of blocksOf(messageOf(record).content) ?? []) {
    const toolCallId =
      block.type === 'tool_result' ? idOf(block.tool_use_id) : null;
    if (toolCallId !== null) {
      events.push({ type: 'tool.end', ...common, toolCallId });
    }
  }
  return events;
}

/** `tool.start` for each `tool_use` block of an `assistant` record. */
function toolStarts(record: Fields, common: Common): DetectionEvent[] {
  const events: DetectionEvent[] = [];
  for (const block of blocksOf(messageOf(record).content) ?? []) {
    if (block.type !== 'tool_use') {
      continue;
    }
    const toolCallId = idOf(block.id);
    const toolName = idOf(block.name);
    if (toolCallId !== null && toolName !== null) {
      events.push({ type: 'tool.start', ...common, toolCallId, toolName });
    }
  }
  return events;
}

/** The events of a `user` record (no `activity`). */
function userEvents(record: Fields, common: Common): DetectionEvent[] {
  const content = messageOf(record).content;
  const blocks = blocksOf(content);
  const events = toolEnds(record, common);
  const hasToolResult =
    blocks?.some((block) => block.type === 'tool_result') ?? false;
  if (isInterrupt(content)) {
    events.push({ type: 'turn.end', ...common });
  } else if (
    record.isMeta !== true &&
    record.isCompactSummary !== true &&
    (typeof content === 'string' || (blocks !== null && !hasToolResult))
  ) {
    events.push({ type: 'turn.start', ...common });
  }
  return events;
}

/** The events of an `assistant` record (no `activity`). */
function assistantEvents(record: Fields, common: Common): DetectionEvent[] {
  const message = messageOf(record);
  const events: DetectionEvent[] = [];
  if (record.isApiErrorMessage === true) {
    events.push({ type: 'error', ...common });
  }
  events.push(...toolStarts(record, common));
  if (
    typeof message.stop_reason === 'string' &&
    TURN_END_STOP_REASONS.includes(message.stop_reason)
  ) {
    events.push({ type: 'turn.end', ...common });
  }
  return events;
}

/** The title record's name, and its source; null for any other record. */
function titleOf(
  record: Fields,
): { readonly name: string | null; readonly source: NameSource } | null {
  if (record.type === 'custom-title') {
    return { name: displayNameOf(record.customTitle), source: 'custom-title' };
  }
  if (record.type === 'ai-title') {
    return { name: displayNameOf(record.aiTitle), source: 'ai-title' };
  }
  return null;
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
  const own = timestampOf(record);
  const latestTs =
    own === null
      ? state.latestTs
      : state.latestTs === null
        ? own
        : Math.max(state.latestTs, own);
  const common = commonFields(
    context,
    own ?? state.latestTs ?? context.fallbackTs,
  );

  if (context.kind === 'subagent') {
    const tools =
      record.type === 'assistant'
        ? toolStarts(record, common)
        : record.type === 'user'
          ? toolEnds(record, common)
          : [];
    return {
      state: latestTs === state.latestTs ? state : { ...state, latestTs },
      events: tools.length > 0 ? tools : [{ type: 'activity', ...common }],
    };
  }

  const events: DetectionEvent[] = [];
  let { started, named, name, turnEnded } = state;
  if (!started) {
    events.push({ type: 'session.start', ...common });
    started = true;
  }

  const title = titleOf(record);
  if (title !== null) {
    // A custom title outranks an AI title, which outranks the folder name.
    if (
      title.name !== null &&
      !(title.source === 'ai-title' && named === 'custom-title')
    ) {
      events.push({
        type: 'session.meta',
        ...common,
        displayName: title.name,
      });
      named = title.source;
      name = title.name;
    }
  } else {
    if (named === null) {
      const folder = folderNameOf(record.cwd);
      if (folder !== null) {
        events.push({ type: 'session.meta', ...common, displayName: folder });
        named = 'cwd';
        name = folder;
      }
    }
    const recordEvents = (
      record.type === 'user'
        ? userEvents(record, common)
        : record.type === 'assistant'
          ? assistantEvents(record, common)
          : []
    ).filter((event) => {
      // One turn end per turn: a repeated turn.end is left out.
      if (event.type === 'turn.end') {
        const repeated = turnEnded;
        turnEnded = true;
        return !repeated;
      }
      if (event.type === 'turn.start' || event.type === 'tool.start') {
        turnEnded = false;
      }
      return true;
    });
    events.push(...recordEvents);
    if (recordEvents.length === 0 && own !== null) {
      events.push({ type: 'activity', ...common });
    }
  }

  const next =
    started === state.started &&
    named === state.named &&
    name === state.name &&
    turnEnded === state.turnEnded &&
    latestTs === state.latestTs
      ? state
      : { started, named, name, turnEnded, latestTs };
  return { state: next, events };
}

/**
 * The session's current display name as a `session.meta`, dated at the
 * transcript's latest timestamp (else the fallback); null before it has
 * one. The adapter sends it again after each read of a main transcript, so
 * a session that comes back (after expiring, or `--resume`) has its name.
 */
export function currentNameEvent(
  state: TranscriptState,
  context: RecordContext,
): DetectionEvent | null {
  if (context.kind !== 'main' || state.name === null) {
    return null;
  }
  return {
    type: 'session.meta',
    ...commonFields(context, state.latestTs ?? context.fallbackTs),
    displayName: state.name,
  };
}

/**
 * One line of a transcript as a record: the JSON object it holds, or null
 * when it is not one (a bad line). Never throws.
 */
export function parseRecordLine(line: string): Fields | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}
