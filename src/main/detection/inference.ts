import type {
  DetectionEventOf,
  SessionKey,
} from '../../shared/detection-events';
import type { DetectionTimings } from '../../shared/settings';
import type { SourceCapability, SourceCode } from '../../shared/sources';
import type { OpenTool, SessionConditions } from './reducer';

/**
 * main/detection/inference (AD-22): the one place the stage guesses at a
 * request a source's records cannot show. Pure functions: they read no
 * settings, set no timers and write no log. main/detection/sessions calls
 * them whenever it brings a published session up to date: it feeds what
 * inferRequests returns to the reducer before evaluating the session, and
 * sets its one timer for nextInferenceAt as well.
 *
 * A tool call is guessed at, once, at monotonic time `now` when all of
 * these hold:
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
 * The reducer does not count an inferred request as the session's last
 * event.
 *
 * Known limitation (AD-22): a tool that simply runs long, a build or a test
 * run, is guessed to be waiting for approval, unless the source lists it
 * among its no-guess tools.
 */

/** A request this module guesses at. */
export type InferredRequest =
  | DetectionEventOf<'approval.request'>
  | DetectionEventOf<'question.request'>;

/** One session, as inference sees it. */
export interface InferenceSubject {
  readonly sessionKey: SessionKey;
  readonly source: SourceCode;
  readonly conditions: SessionConditions;
  /** What the session's source can read (SOURCE_CAPABILITIES, by default). */
  readonly capability: SourceCapability;
}

/** The one timing inference reads; any DetectionTimings will do. */
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
 * The requests to guess at for `session` at monotonic time `now`, in the
 * order their `tool.start` arrived; empty when there are none. Each is stamped
 * with `wallNow`, the caller's wall clock in epoch milliseconds (a
 * non-negative integer, as `ts` must be). The array and its events are
 * frozen.
 */
export function inferRequests(
  session: InferenceSubject,
  now: number,
  timings: InferenceTimings,
  wallNow: number,
): readonly InferredRequest[] {
  const requests: InferredRequest[] = [];
  for (const guess of guesses(session, timings)) {
    if (now < guess.dueAt) {
      continue;
    }
    const fields = {
      source: session.source,
      sessionKey: session.sessionKey,
      ts: wallNow,
      via: 'inferred',
      confidence: 'inferred',
      requestId: guess.toolCallId,
    } as const;
    requests.push(
      Object.freeze(
        guess.kind === 'approval'
          ? { type: 'approval.request', ...fields }
          : { type: 'question.request', ...fields },
      ),
    );
  }
  return Object.freeze(requests);
}

/**
 * The earliest time after `now` at which inferRequests will guess at a
 * tool call it does not guess at now; null if there is none. With no new
 * event and the same timings, nothing is guessed between `now` and then.
 */
export function nextInferenceAt(
  session: InferenceSubject,
  now: number,
  timings: InferenceTimings,
): number | null {
  let next: number | null = null;
  for (const { dueAt } of guesses(session, timings)) {
    if (dueAt > now && (next === null || dueAt < next)) {
      next = dueAt;
    }
  }
  return next;
}
