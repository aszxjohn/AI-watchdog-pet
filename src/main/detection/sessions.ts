/**
 * main/detection/sessions (AD-21, AD-22): owns the list of detected
 * sessions. It takes what the adapters emit, keeps each session's conditions
 * through the reducer, and decides when a session ends:
 *
 * - on `session.end` (an adapter whose source has a pid also sends it once
 *   the process is gone: that is a fact, not a timeout);
 * - once `sessionExpireMs` has passed since its last event (at
 *   `lastEventAt + sessionExpireMs` exactly, half-open like the reducer's
 *   durations).
 *
 * An ended session leaves the list at once; a later event with the same key
 * starts a new session.
 *
 * Start-up replay. Until a source sends its `sync.ready`, or until
 * `syncTimeoutMs` has passed since createSessions, whichever comes first,
 * that source's sessions are tracked but not published (not in list(), no
 * notification), get no timer and never expire. A replayed event
 * (`replay: true`) is dated back from its `ts`: monotonic time at receipt
 * minus how far the wall clock is past `ts` (0 when `ts` is in the future),
 * so a session replayed from ten minutes ago is `idle` when published, and
 * one from three hours ago expires without being published. Live events use
 * the time they arrive.
 *
 * One timer. It is set for the earliest of every published session's
 * `nextChangeAt` and expiry time, and of the sync deadline while an
 * unsynced source has a session. When it fires, and after anything else
 * that may change the list (an event, `sync.ready`, retime()), every
 * session is evaluated again, subscribers hear about it only if the list
 * changed, and the timer is set again.
 *
 * Times come only from the injected clocks and timers. An output that fails
 * the shared schemas is dropped and logged by field path only, never by
 * value.
 */
import {
  type AdapterOutput,
  type Confidence,
  type DetectionEvent,
  detectionEventSchema,
  type SessionKey,
  syncReadySchema,
} from '../../shared/detection-events';
import type { DetectionTimings } from '../../shared/settings';
import type { SourceCode } from '../../shared/sources';
import type { StateCode } from '../../shared/states';
import type { z } from '../../shared/zod-setup';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import {
  evaluate,
  nextChangeAt,
  reduceSession,
  type SessionConditions,
} from './reducer';

/** One published session, as list() and listeners see it. */
export interface DetectedSession {
  readonly sessionKey: SessionKey;
  readonly source: SourceCode;
  /** From the latest `session.meta`; null until one arrives. */
  readonly displayName: string | null;
  readonly state: StateCode;
  readonly confidence: Confidence;
}

export type SessionsListener = (sessions: readonly DetectedSession[]) => void;

export interface SessionsOptions {
  /**
   * The timings in force (main/settings' current values); read again at
   * every evaluation, so call retime() when they change.
   */
  readonly timings: () => DetectionTimings;
  /** A monotonic clock in ms (default `performance.now`). */
  readonly now?: () => number;
  /** The wall clock in epoch ms (default `Date.now`); only dates replays. */
  readonly wallNow?: () => number;
  /** Runs `run` once after `delayMs` (default `setTimeout`). */
  readonly setTimer?: (run: () => void, delayMs: number) => unknown;
  /** Cancels a timer setTimer returned (default `clearTimeout`). */
  readonly clearTimer?: (handle: unknown) => void;
}

export interface Sessions {
  /**
   * Checks one adapter output against the shared schemas and applies it;
   * one that fails is dropped and logged. Never throws.
   */
  receive(output: AdapterOutput): void;
  /**
   * The published sessions, in the order they were first seen: synced
   * sources only, none ended. The array and its items are frozen.
   */
  list(): readonly DetectedSession[];
  /**
   * Calls `listener` with the new list whenever it changes (a session
   * added, removed, or with another state, confidence or display name).
   * Returns an unsubscribe.
   */
  onChange(listener: SessionsListener): () => void;
  /** The timings changed: evaluates every session and resets the timer now. */
  retime(): void;
  /** Clears the timer. Afterwards receive() and retime() do nothing. */
  stop(): void;
}

interface Tracked {
  readonly source: SourceCode;
  readonly conditions: SessionConditions;
  readonly displayName: string | null;
}

const NO_SESSIONS: readonly DetectedSession[] = Object.freeze([]);

function log(message: string, level: ConsoleLevel): void {
  logEvent('detection', message, level);
}

/**
 * The field paths a failed parse names, for the log: `sessionKey`,
 * `(root)` for the output itself, and the names of unknown fields. Never a
 * value.
 */
function failedFields(issues: z.ZodError['issues']): string {
  const paths = new Set<string>();
  for (const issue of issues) {
    const named =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issue.path, key])
        : [issue.path];
    for (const path of named) {
      paths.add(path.length === 0 ? '(root)' : path.map(String).join('.'));
    }
  }
  return [...paths].join(', ');
}

/** The output if it passes its schema; otherwise logs it and answers undefined. */
function parse(output: unknown): AdapterOutput | undefined {
  const syncReady =
    typeof output === 'object' &&
    output !== null &&
    (output as { readonly type?: unknown }).type === 'sync.ready';
  const result = syncReady
    ? syncReadySchema.safeParse(output)
    : detectionEventSchema.safeParse(output);
  if (result.success) {
    return result.data;
  }
  log(
    `dropped an adapter output that fails the schema (fields: ${failedFields(result.error.issues)})`,
    'warn',
  );
  return undefined;
}

function sameList(
  a: readonly DetectedSession[],
  b: readonly DetectedSession[],
): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      // The source is part of the key.
      return (
        y !== undefined &&
        x.sessionKey === y.sessionKey &&
        x.displayName === y.displayName &&
        x.state === y.state &&
        x.confidence === y.confidence
      );
    })
  );
}

/** The smallest of the numbers given; null if none is. */
function earliest(...times: readonly (number | null)[]): number | null {
  let result: number | null = null;
  for (const time of times) {
    if (time !== null && (result === null || time < result)) {
      result = time;
    }
  }
  return result;
}

export function createSessions({
  timings,
  // Monotonic, so a wall-clock change cannot stretch or cut any duration.
  now = () => performance.now(),
  wallNow = Date.now,
  setTimer = (run, delayMs) => setTimeout(run, delayMs),
  clearTimer = (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
}: SessionsOptions): Sessions {
  const startedAt = now();
  /** Every session not ended, synced or not, in first-seen order. */
  const tracked = new Map<SessionKey, Tracked>();
  const syncedSources = new Set<SourceCode>();
  /** Once syncTimeoutMs has passed since startedAt, every source is synced. */
  let syncDeadlinePassed = false;
  let published = NO_SESSIONS;
  const listeners = new Set<SessionsListener>();
  let timer: { readonly handle: unknown } | undefined;
  let stopped = false;

  function synced(source: SourceCode): boolean {
    return syncDeadlinePassed || syncedSources.has(source);
  }

  /**
   * When `event`, received at monotonic `receivedAt`, happened: then for a
   * live event; back-dated by its age for a replayed one (AD-22).
   */
  function eventTime(event: DetectionEvent, receivedAt: number): number {
    if (event.replay !== true) {
      return receivedAt;
    }
    return receivedAt - Math.max(0, wallNow() - event.ts);
  }

  function apply(event: DetectionEvent, receivedAt: number): void {
    const at = eventTime(event, receivedAt);
    const tracking = tracked.get(event.sessionKey);
    // Past its expiry the session has ended, even if the timer has not
    // fired yet (or its source has not synced): this event starts a new one.
    const current =
      tracking !== undefined &&
      at < tracking.conditions.lastEventAt + timings().sessionExpireMs
        ? tracking
        : undefined;
    const conditions = reduceSession(current?.conditions, event, at);
    if (conditions.ended) {
      tracked.delete(event.sessionKey);
      return;
    }
    tracked.set(event.sessionKey, {
      source: event.source,
      conditions,
      displayName:
        event.type === 'session.meta'
          ? event.displayName
          : (current?.displayName ?? null),
    });
  }

  function clear(): void {
    if (timer !== undefined) {
      clearTimer(timer.handle);
      timer = undefined;
    }
  }

  function arm(wakeAt: number | null, at: number): void {
    clear();
    if (stopped || wakeAt === null) {
      return;
    }
    timer = {
      // Rounded up: a timer that fired a fraction early would only be set
      // again for the remainder.
      handle: setTimer(
        () => {
          timer = undefined;
          if (!stopped) {
            settle(now());
          }
        },
        Math.ceil(wakeAt - at),
      ),
    };
  }

  function notify(): void {
    const current = published;
    for (const listener of listeners) {
      if (published !== current) {
        // A listener's own call already told everyone about a newer list.
        return;
      }
      try {
        listener(current);
      } catch (error) {
        log(`a change listener failed (${errorCode(error)})`, 'error');
      }
    }
  }

  /**
   * Brings everything up to monotonic time `at`: the sync deadline, expiry
   * and every published state; then sets the timer and, if the list
   * changed, tells the listeners.
   */
  function settle(at: number): void {
    const t = timings();
    const syncDeadline = startedAt + t.syncTimeoutMs;
    if (!syncDeadlinePassed && at >= syncDeadline) {
      syncDeadlinePassed = true;
    }
    const list: DetectedSession[] = [];
    let wakeAt: number | null = null;
    for (const [sessionKey, session] of tracked) {
      if (!synced(session.source)) {
        wakeAt = earliest(wakeAt, syncDeadline);
        continue;
      }
      const expiresAt = session.conditions.lastEventAt + t.sessionExpireMs;
      if (at >= expiresAt) {
        tracked.delete(sessionKey);
        continue;
      }
      const { state, confidence } = evaluate(session.conditions, at, t);
      list.push(
        Object.freeze({
          sessionKey,
          source: session.source,
          displayName: session.displayName,
          state,
          confidence,
        }),
      );
      wakeAt = earliest(
        wakeAt,
        expiresAt,
        nextChangeAt(session.conditions, at, t),
      );
    }
    arm(wakeAt, at);
    if (!sameList(published, list)) {
      published = Object.freeze(list);
      notify();
    }
  }

  return {
    receive(output) {
      if (stopped) {
        return;
      }
      const parsed = parse(output);
      if (parsed === undefined) {
        return;
      }
      const at = now();
      if (parsed.type === 'sync.ready') {
        syncedSources.add(parsed.source);
      } else {
        apply(parsed, at);
      }
      settle(at);
    },

    list: () => published,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    retime() {
      if (!stopped) {
        settle(now());
      }
    },

    stop() {
      stopped = true;
      clear();
    },
  };
}
