import type { Confidence, DetectionEvent } from '../../shared/detection-events';
import type { DetectionTimings } from '../../shared/settings';
import type { StateCode } from '../../shared/states';

/**
 * The one place the 8 states are decided (AD-5, AD-21). Pure functions:
 * `reduceSession` folds one session's events into the facts below, and
 * `evaluate` derives the state from those facts, the current time and the
 * timings. Only facts are kept, so a change of timings applies at once
 * without replaying any history.
 *
 * Every time here is the caller's monotonic clock in milliseconds: when the
 * event was received, or, for a replayed event (`replay: true`), that moment
 * back-dated by the event's age (AD-22; main/detection/sessions works it
 * out). The reducer itself never reads `ts`. A replayed event rebuilds the
 * conditions only: its `turn.end` starts no `done` and its `error` holds no
 * `error`.
 *
 * This module reads no settings, starts no timers and writes no log; whoever
 * drives it schedules re-evaluation with `nextChangeAt`. The timings it is
 * given (only `doneMs`, `idleMs` and `errorHoldMs` are read) must be finite
 * positive numbers of milliseconds; nothing here checks it (NaN, for one,
 * would make every session `idle` with no next change). The settings schema
 * that supplies them guarantees it.
 */

/**
 * The facts about one session. Read-only: `reduceSession` returns a new
 * object whenever something changes and never alters the one it was given.
 * The freeze is shallow, and successive objects share the Maps that did not
 * change, so those must never be mutated, not even through a cast.
 */
export interface SessionConditions {
  /**
   * `session.end` arrived: everything is cleared and later events are
   * ignored. main/detection/sessions drops such conditions at once, so a
   * later event with the same key starts a new session.
   */
  readonly ended: boolean;
  /** Between `turn.start` and `turn.end`. */
  readonly inTurn: boolean;
  /**
   * Tool calls that started and have not ended, by `toolCallId`, in the
   * order their `tool.start` arrived (a back-dated replayed one can arrive
   * after a live one). A repeated `tool.start` keeps the entry it found.
   */
  readonly openTools: ReadonlyMap<string, OpenTool>;
  /**
   * Pending approvals by `requestId`, each with the best confidence any of
   * its `approval.request` events had (an exact request outranks an inferred
   * one; nothing downgrades it).
   */
  readonly openApprovals: ReadonlyMap<string, Confidence>;
  /** Pending questions, kept the same way as approvals. */
  readonly openQuestions: ReadonlyMap<string, Confidence>;
  /**
   * When the last `turn.end` arrived; null once a turn starts again. A
   * replayed `turn.end` leaves it as it was.
   */
  readonly turnEndedAt: number | null;
  /**
   * When the last `error` arrived; null once a turn or a tool starts. A
   * replayed `error` leaves it as it was.
   */
  readonly errorAt: number | null;
  /**
   * When the last event arrived. `session.meta` and inferred requests do not
   * count (an inferred request is the stage's guess, not something the
   * session did), except as a session's first event: the conditions it
   * creates start at that moment (an inferred request then matches no open
   * tool call, so it creates nothing else). It only moves forward: an event back-dated
   * to before it (an older replayed record) leaves it as it was.
   */
  readonly lastEventAt: number;
}

/** One open tool call. Frozen, like the conditions holding it. */
export interface OpenTool {
  /** When its `tool.start` happened (back-dated if replayed). */
  readonly startedAt: number;
  readonly toolName: string;
  /**
   * An `approval.request` or `question.request` with its id, of any
   * confidence, arrived while it was open, or was still pending when it
   * started. Once true it stays true, even after the request is resolved,
   * so main/detection/inference guesses at a tool call at most once.
   */
  readonly requested: boolean;
}

/** A session's state right now, and how sure the stage is of it. */
export interface EvaluatedState {
  readonly state: StateCode;
  /**
   * `inferred` only when the state is `approval` or `decision` and every
   * pending request behind it is inferred; otherwise `exact`.
   */
  readonly confidence: Confidence;
}

function conditions(fields: SessionConditions): SessionConditions {
  return Object.freeze(fields);
}

function emptyConditions(now: number, ended: boolean): SessionConditions {
  return conditions({
    ended,
    inTurn: false,
    openTools: new Map(),
    openApprovals: new Map(),
    openQuestions: new Map(),
    turnEndedAt: null,
    errorAt: null,
    lastEventAt: now,
  });
}

function openTool(fields: OpenTool): OpenTool {
  return Object.freeze(fields);
}

/**
 * The tools with `id` started at `now`; the same map when `id` is already
 * open. A request with its id may already be pending (it arrived first).
 */
function withTool(
  base: SessionConditions,
  id: string,
  toolName: string,
  now: number,
): ReadonlyMap<string, OpenTool> {
  if (base.openTools.has(id)) {
    return base.openTools;
  }
  return new Map(base.openTools).set(
    id,
    openTool({
      startedAt: now,
      toolName,
      requested: base.openApprovals.has(id) || base.openQuestions.has(id),
    }),
  );
}

/** The tools with `id` marked requested; the same map when nothing changes. */
function withToolRequested(
  tools: ReadonlyMap<string, OpenTool>,
  id: string,
): ReadonlyMap<string, OpenTool> {
  const tool = tools.get(id);
  if (tool === undefined || tool.requested) {
    return tools;
  }
  return new Map(tools).set(id, openTool({ ...tool, requested: true }));
}

/** The map with `id` removed; the same map when `id` is not in it. */
function withoutTool(
  tools: ReadonlyMap<string, OpenTool>,
  id: string,
): ReadonlyMap<string, OpenTool> {
  if (!tools.has(id)) {
    return tools;
  }
  const next = new Map(tools);
  next.delete(id);
  return next;
}

/** The map with `id` removed; the same map when `id` is not in it. */
function withoutRequest(
  requests: ReadonlyMap<string, Confidence>,
  id: string,
): ReadonlyMap<string, Confidence> {
  if (!requests.has(id)) {
    return requests;
  }
  const next = new Map(requests);
  next.delete(id);
  return next;
}

/** The map with `id` pending at the better of its old and new confidence. */
function withRequest(
  requests: ReadonlyMap<string, Confidence>,
  id: string,
  confidence: Confidence,
): ReadonlyMap<string, Confidence> {
  const best = requests.get(id) === 'exact' ? 'exact' : confidence;
  return new Map(requests).set(id, best);
}

/**
 * The conditions after `event`, which happened at monotonic time `now`
 * (received then, or back-dated for a replayed event). Pass `undefined` for
 * a session seen for the first time. Conditions open and close only as
 * AD-21's table says; an id that matches nothing open is ignored, never
 * thrown on. An inferred `approval.request` or `question.request` whose id
 * is not an open tool call returns the conditions it was given (fresh empty
 * ones for a session seen for the first time).
 */
export function reduceSession(
  current: SessionConditions | undefined,
  event: DetectionEvent,
  now: number,
): SessionConditions {
  if (current?.ended) {
    return current;
  }
  const base = current ?? emptyConditions(now, false);
  const inferredRequest =
    event.confidence === 'inferred' &&
    (event.type === 'approval.request' || event.type === 'question.request');
  // main/detection/inference guesses only at a tool call that is open. An
  // inferred request whose id matches no open tool call (it arrived after
  // the tool's end) is ignored: it opens and changes nothing.
  if (inferredRequest && !base.openTools.has(event.requestId)) {
    return base;
  }
  // An inferred request is not the session's own doing: it does not move
  // the last-event time (so it neither delays `idle` nor the expiry).
  const moves = !inferredRequest;
  const update = (changes: Partial<SessionConditions>) =>
    conditions({
      ...base,
      ...changes,
      lastEventAt: moves ? Math.max(base.lastEventAt, now) : base.lastEventAt,
    });
  const replayed = event.replay === true;

  switch (event.type) {
    case 'session.meta':
      // The display name belongs to main/detection/sessions (Story 2.2).
      return base;
    case 'session.start':
    case 'activity':
      return update({});
    case 'session.end':
      return emptyConditions(now, true);
    case 'turn.start':
      return update({ inTurn: true, turnEndedAt: null, errorAt: null });
    case 'turn.end':
      // Whatever this turn left open was not written to the log; close it.
      // `error` is not cleared. A replayed turn ended before the stage
      // started, so it starts no `done`.
      return update({
        inTurn: false,
        openTools: new Map(),
        openApprovals: new Map(),
        openQuestions: new Map(),
        ...(replayed ? {} : { turnEndedAt: now }),
      });
    case 'tool.start':
      return update({
        openTools: withTool(base, event.toolCallId, event.toolName, now),
        errorAt: null,
      });
    case 'tool.end':
      // A tool call's end also closes the request it raised (same id).
      return update({
        openTools: withoutTool(base.openTools, event.toolCallId),
        openApprovals: withoutRequest(base.openApprovals, event.toolCallId),
        openQuestions: withoutRequest(base.openQuestions, event.toolCallId),
      });
    case 'approval.request':
      return update({
        openTools: withToolRequested(base.openTools, event.requestId),
        openApprovals: withRequest(
          base.openApprovals,
          event.requestId,
          event.confidence,
        ),
      });
    case 'approval.resolved':
      return update({
        openApprovals: withoutRequest(base.openApprovals, event.requestId),
      });
    case 'question.request':
      return update({
        openTools: withToolRequested(base.openTools, event.requestId),
        openQuestions: withRequest(
          base.openQuestions,
          event.requestId,
          event.confidence,
        ),
      });
    case 'question.resolved':
      return update({
        openQuestions: withoutRequest(base.openQuestions, event.requestId),
      });
    case 'error':
      // A replayed error is history: it holds no `error`.
      return update(replayed ? {} : { errorAt: now });
  }
}

/** `exact` if any pending request is exact, else `inferred`. */
function requestsConfidence(
  requests: ReadonlyMap<string, Confidence>,
): Confidence {
  for (const confidence of requests.values()) {
    if (confidence === 'exact') {
      return 'exact';
    }
  }
  return 'inferred';
}

function exact(state: StateCode): EvaluatedState {
  return { state, confidence: 'exact' };
}

/**
 * The state at monotonic time `now`: the highest-priority condition that
 * holds, in the order approval > decision > error > working > thinking >
 * done > waiting > idle. Durations are half-open: `done` while less than
 * `doneMs` has passed since `turn.end`, `error` while less than
 * `errorHoldMs` has passed since `error`, `waiting` while less than `idleMs`
 * has passed since the last event.
 */
export function evaluate(
  current: SessionConditions,
  now: number,
  timings: DetectionTimings,
): EvaluatedState {
  if (current.openApprovals.size > 0) {
    return {
      state: 'approval',
      confidence: requestsConfidence(current.openApprovals),
    };
  }
  if (current.openQuestions.size > 0) {
    return {
      state: 'decision',
      confidence: requestsConfidence(current.openQuestions),
    };
  }
  // Each end is compared as the same sum nextChangeAt returns: with a
  // fractional clock, `now - start < duration` can still be true at
  // `now === start + duration`, because the subtraction rounds.
  if (current.errorAt !== null && now < current.errorAt + timings.errorHoldMs) {
    return exact('error');
  }
  if (current.openTools.size > 0) {
    return exact('working');
  }
  if (current.inTurn) {
    return exact('thinking');
  }
  if (
    current.turnEndedAt !== null &&
    now < current.turnEndedAt + timings.doneMs
  ) {
    return exact('done');
  }
  if (now < current.lastEventAt + timings.idleMs) {
    return exact('waiting');
  }
  return exact('idle');
}

/**
 * The earliest time after `now` at which the state may change with no new
 * event: the soonest of `turn.end + doneMs`, `error + errorHoldMs` and
 * `last event + idleMs` that is later than `now`; null if none is. The state
 * need not actually change then (a pending approval outranks all three).
 */
export function nextChangeAt(
  current: SessionConditions,
  now: number,
  timings: DetectionTimings,
): number | null {
  const candidates = [current.lastEventAt + timings.idleMs];
  if (current.turnEndedAt !== null) {
    candidates.push(current.turnEndedAt + timings.doneMs);
  }
  if (current.errorAt !== null) {
    candidates.push(current.errorAt + timings.errorHoldMs);
  }
  let next: number | null = null;
  for (const candidate of candidates) {
    if (candidate > now && (next === null || candidate < next)) {
      next = candidate;
    }
  }
  return next;
}
