import { TURN_END_INFER_MS } from '../../shared/constants';
import type {
  DetectionEventOf,
  SessionKey,
} from '../../shared/detection-events';
import type { DetectionTimings } from '../../shared/settings';
import type { SourceCapability, SourceCode } from '../../shared/sources';
import type { OpenTool, SessionConditions } from './reducer';

/**
 * main/detection/inference (AD-22): the one place the stage guesses at what
 * a source's records cannot show. Pure functions: they read no settings,
 * set no timers and write no log. main/detection/sessions calls them
 * whenever it brings a published session up to date: it feeds what
 * inferEvents returns to the reducer before evaluating the session, and
 * sets its one timer for nextInferenceAt as well.
 *
 * Requests. A tool call is guessed at, once, at monotonic time `now` when
 * all of these hold:
 *
 * - it is still open (no `tool.end`, `turn.end` or `session.end` yet);
 * - no request with its id is pending, and none has ever arrived while it
 *   was open (`OpenTool.requested`), so a guess that `approval.resolved`
 *   closed is not made again while the tool keeps running;
 * - it is not one of the source's no-guess tools (`noInferTools`), which
 *   run long by design;
 * - its kind is `none` in the source's capability: `question` for one of
 *   the source's question tools, `approval` for any other tool;
 * - `now >= startedAt + approvalInferMs`, half-open like the reducer's
 *   durations. A replayed tool call counts from its back-dated start, so
 *   one already past the threshold when its source syncs is guessed at
 *   once.
 *
 * The guess is an `approval.request` (a `question.request` for a question
 * tool) with `via: 'inferred'` and `requestId` equal to the `toolCallId`.
 * Once the reducer has it, the tool is requested; an exact request with
 * the same id makes the state exact, and the tool's `tool.end` closes it.
 *
 * Turn ends (Story 2.6). A turn is guessed to have ended when all of these
 * hold:
 *
 * - the source's capability has `turnEnd: 'none'` (its records never show
 *   a turn end);
 * - the session is in a turn, and a `turn.reply` came after the turn's
 *   last `turn.start` or `tool.start` (`replyPending`);
 * - no tool call is open and no request is pending;
 * - `now >= lastEventAt + TURN_END_INFER_MS`: nothing newer has been
 *   recorded for that long. An `activity` after the reply moves the due
 *   time later; it does not call the guess off.
 *
 * The guess is a `turn.end` with `via: 'inferred'`, dated when it fell due
 * (its `ts` back-dated to match); the reducer closes the turn, and the
 * `done` and `waiting` after it are inferred.
 *
 * The reducer counts no guess as the session's last event.
 *
 * Known limitations (AD-22): a tool that simply runs long, a build or a test
 * run, is guessed to be waiting for approval, unless the source lists it
 * among its no-guess tools. For a source that writes tool calls only once
 * they finish, a reply followed by a tool batch (or an approval wait) longer
 * than TURN_END_INFER_MS is guessed to be a turn end.
 */

/** A request this module guesses at. */
export type InferredRequest =
  | DetectionEventOf<'approval.request'>
  | DetectionEventOf<'question.request'>;

/** Any event this module guesses at. */
export type InferredEvent = InferredRequest | DetectionEventOf<'turn.end'>;

/** A guess, and when it fell due. Frozen. */
export interface Inference {
  readonly event: InferredEvent;
  /**
   * The monotonic time the guess fell due, at or before the `now` it was
   * made at: a tool's start plus approvalInferMs for a request, the
   * session's last event plus TURN_END_INFER_MS for a turn end.
   */
  readonly dueAt: number;
}

/** One session, as inference sees it. */
export interface InferenceSubject {
  readonly sessionKey: SessionKey;
  readonly source: SourceCode;
  readonly conditions: SessionConditions;
  /** What the session's source can read (SOURCE_CAPABILITIES, by default). */
  readonly capability: SourceCapability;
}

/**
 * The one timing inference reads; any DetectionTimings will do. The turn
 * end's TURN_END_INFER_MS is a constant, not a timing.
 */
export type InferenceTimings = Pick<DetectionTimings, 'approvalInferMs'>;

type RequestKind = 'approval' | 'question';

interface Guess {
  readonly toolCallId: string;
  readonly kind: RequestKind;
  /** When the guess is due: the tool's start plus approvalInferMs. */
  readonly dueAt: number;
}

/**
 * The kind of request to guess for `tool`; null when its kind is read or
 * the tool is never guessed at.
 */
function kindToGuess(
  tool: OpenTool,
  capability: SourceCapability,
): RequestKind | null {
  if (capability.noInferTools.includes(tool.toolName)) {
    return null;
  }
  const kind = capability.questionTools.includes(tool.toolName)
    ? 'question'
    : 'approval';
  return capability[kind] === 'none' ? kind : null;
}

/** Every open tool call that may still be guessed at, whenever it is due. */
function guesses(
  { conditions, capability }: InferenceSubject,
  timings: InferenceTimings,
): Guess[] {
  const result: Guess[] = [];
  for (const [toolCallId, tool] of conditions.openTools) {
    if (
      tool.requested ||
      conditions.openApprovals.has(toolCallId) ||
      conditions.openQuestions.has(toolCallId)
    ) {
      continue;
    }
    const kind = kindToGuess(tool, capability);
    if (kind !== null) {
      // Compared as this same sum everywhere, so a fractional clock cannot
      // put `now` past the due time while `now - startedAt` still rounds
      // below the threshold.
      result.push({
        toolCallId,
        kind,
        dueAt: tool.startedAt + timings.approvalInferMs,
      });
    }
  }
  return result;
}

/**
 * When the session's turn may be guessed to have ended, whenever that is;
 * null when it may not be (see the module comment).
 */
function turnEndDueAt({
  conditions,
  capability,
}: InferenceSubject): number | null {
  if (
    capability.turnEnd !== 'none' ||
    !conditions.inTurn ||
    conditions.replyPending !== true ||
    conditions.openTools.size > 0 ||
    conditions.openApprovals.size > 0 ||
    conditions.openQuestions.size > 0
  ) {
    return null;
  }
  return conditions.lastEventAt + TURN_END_INFER_MS;
}

/**
 * Everything to guess for `session` at monotonic time `now`, each with the
 * time it fell due: the requests in the order their `tool.start` arrived,
 * then the turn end; empty when there is nothing. `wallNow` is the caller's
 * wall clock at `now`, in epoch milliseconds (a non-negative integer, as
 * `ts` must be): a request is stamped with it, a turn end with it moved back
 * to the due time (never below 0). The array, its items and their events
 * are frozen.
 */
export function inferEvents(
  session: InferenceSubject,
  now: number,
  timings: InferenceTimings,
  wallNow: number,
): readonly Inference[] {
  const fields = {
    source: session.source,
    sessionKey: session.sessionKey,
    ts: wallNow,
    via: 'inferred',
    confidence: 'inferred',
  } as const;
  const result: Inference[] = [];
  for (const guess of guesses(session, timings)) {
    if (now < guess.dueAt) {
      continue;
    }
    const request = { ...fields, requestId: guess.toolCallId };
    result.push(
      Object.freeze({
        event: Object.freeze(
          guess.kind === 'approval'
            ? { type: 'approval.request', ...request }
            : { type: 'question.request', ...request },
        ),
        dueAt: guess.dueAt,
      }),
    );
  }
  const turnEnd = turnEndDueAt(session);
  if (turnEnd !== null && now >= turnEnd) {
    // The turn ended when nothing more came, not when it was noticed.
    const ts = Math.max(0, Math.round(wallNow - (now - turnEnd)));
    result.push(
      Object.freeze({
        event: Object.freeze({ type: 'turn.end', ...fields, ts }),
        dueAt: turnEnd,
      }),
    );
  }
  return Object.freeze(result);
}

/**
 * The earliest time after `now` at which inferEvents will guess something
 * it does not guess now; null if there is none. With no new event and the
 * same timings, nothing is guessed between `now` and then.
 */
export function nextInferenceAt(
  session: InferenceSubject,
  now: number,
  timings: InferenceTimings,
): number | null {
  let next: number | null = null;
  const dueTimes = guesses(session, timings).map(({ dueAt }) => dueAt);
  const turnEnd = turnEndDueAt(session);
  if (turnEnd !== null) {
    dueTimes.push(turnEnd);
  }
  for (const dueAt of dueTimes) {
    if (dueAt > now && (next === null || dueAt < next)) {
      next = dueAt;
    }
  }
  return next;
}
