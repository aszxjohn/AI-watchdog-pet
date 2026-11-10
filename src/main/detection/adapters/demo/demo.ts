/**
 * main/detection/adapters/demo: the demo adapter (FR21, as decided on
 * 2026-11-10). The user picks a state and one fake session, 示範, shows it
 * until another state is picked or demo mode is turned off. The tray menu
 * picks it for now, and Epic 3's right-click menu on the canvas will too:
 * both through main/detection's setDemo(), never this adapter's setState()
 * directly, so a switch is published as one change and demo mode's adapter
 * health is kept.
 *
 * Like every adapter it only translates: it hands plain shared events to
 * `emit` (main/detection/sessions' receive), and the reducer decides the
 * state. Nothing here goes around them. It replays nothing, so it sends
 * `sync.ready` as soon as it starts.
 *
 * It remembers the tool call it left open. Switching first closes it with
 * `tool.end` (which also closes the request with the same id), then sends:
 *
 * - `thinking`: `turn.start`; then `activity` every idleMs / 2.
 * - `working`: `turn.start`, `tool.start`; then `activity` every idleMs / 2.
 * - `approval`: `turn.start`, `tool.start`, `approval.request` with the
 *   tool call's id; then `activity` every idleMs / 2.
 * - `decision`: the same with `question.request`; then `activity` every
 *   idleMs / 2.
 * - `error`: `turn.start`, `error`; then `error` every errorHoldMs / 2.
 * - `done`: `turn.start`, `turn.end`; then `turn.end` every doneMs / 2 (the
 *   reducer restarts `done` at each one).
 * - `waiting`: `turn.start`, then a replayed `turn.end`; then `activity`
 *   every idleMs / 2.
 * - `idle`: `session.end`, then a replayed `session.start` and
 *   `session.meta` dated idleMs ago; then a replayed `activity` dated
 *   idleMs ago every min(idleMs, sessionExpireMs - idleMs) / 2. A session
 *   dated idleMs ago expires sessionExpireMs - idleMs from now, so the
 *   repeat must come sooner. When that is 0 or less no session can be idle
 *   at all: the switch is still sent (the session ends), a warning is
 *   logged and nothing repeats.
 *
 * The repeat keeps the state from running out (`done`, `error`, `waiting`)
 * and the session from expiring; each one reads the timings again. A
 * replayed `turn.end` leaves the turn without starting `done`. `idle` comes
 * only from a last event older than idleMs, and the reducer's last-event
 * time only moves forward, so `idle` ends the session and starts it again
 * with the same key, back-dated (known limitation: once Epic 3 gives
 * sessions actors, picking 休息中 may change the demo's actor).
 *
 * The first setState() also opens the session (`session.start`, then
 * `session.meta` naming it 示範), unless it is `idle`, which opens it
 * itself. Every switch, the first included, and stop() write one
 * `detection` log line with state codes only.
 */
import type {
  AdapterOutput,
  SessionKey,
} from '../../../../shared/detection-events';
import type { DetectionTimings } from '../../../../shared/settings';
import { SOURCE_DISPLAY_NAMES } from '../../../../shared/sources';
import type { StateCode } from '../../../../shared/states';
import { logEvent, type ConsoleLevel } from '../../../log/run-log';

/** The demo session's key: source `demo`, native id `1`. */
export const DEMO_SESSION_KEY: SessionKey = 'demo:1';

/** The demo session's display name: the demo source's display name. */
export const DEMO_DISPLAY_NAME = SOURCE_DISPLAY_NAMES.demo;

/** The tool name of the demo's tool calls. */
export const DEMO_TOOL_NAME = 'demo';

export interface DemoAdapterOptions {
  /** Where every output goes: main/detection/sessions' receive. */
  readonly emit: (output: AdapterOutput) => void;
  /** The timings in force; read again at every switch and repeat. */
  readonly timings: () => DetectionTimings;
  /** The wall clock in epoch ms, for `ts` (default `Date.now`). */
  readonly wallNow?: () => number;
  /** Runs `run` once after `delayMs` (default `setTimeout`). */
  readonly setTimer?: (run: () => void, delayMs: number) => unknown;
  /** Cancels a timer setTimer returned (default `clearTimeout`). */
  readonly clearTimer?: (handle: unknown) => void;
}

export interface DemoAdapter {
  /**
   * Shows `state` on the demo session from now on, opening the session on
   * the first call; picking the state already shown sends it again. Logs
   * one line. Nothing after stop().
   */
  setState(state: StateCode): void;
  /**
   * The system woke up, and the demo session may have expired meanwhile
   * (its repeats did not run while asleep): opens it again (`session.start`
   * and `session.meta`; for `idle`, ends and restarts it as usual) and
   * sends the shown state's switching events again. Nothing before the
   * first setState() or after stop(). Not logged.
   */
  refresh(): void;
  /**
   * The timings may have changed: when one the shown state's events depend
   * on did (its repeat's timing; for `idle`, idleMs or sessionExpireMs),
   * sends the state's switching events again with the new values, so the
   * state holds. Not logged.
   */
  retime(): void;
  /** The state shown; null before the first setState() and after stop(). */
  state(): StateCode | null;
  /**
   * Ends the demo session (`session.end`) and its repeats, and logs one
   * line. Afterwards every method does nothing.
   */
  stop(): void;
}

interface Repeat {
  /** The timings it depends on; retime() sends the state again on a change. */
  readonly dependsOn: readonly (keyof DetectionTimings)[];
  /** How long between repeats; null when the state cannot hold at all. */
  readonly every: (t: DetectionTimings) => number | null;
  /** Sends the repeated event. */
  readonly send: () => void;
}

/** A repeat every half of `timing`. */
function halfOf(
  timing: 'idleMs' | 'doneMs' | 'errorHoldMs',
  send: () => void,
): Repeat {
  return { dependsOn: [timing], every: (t) => t[timing] / 2, send };
}

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('detection', message, level);
}

export function createDemoAdapter({
  emit,
  timings,
  wallNow = Date.now,
  setTimer = (run, delayMs) => setTimeout(run, delayMs),
  clearTimer = (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
}: DemoAdapterOptions): DemoAdapter {
  let shown: StateCode | null = null;
  /** Whether the demo session has started and not ended. */
  let sessionOpen = false;
  /** The tool call the demo left open, if any. */
  let openToolId: string | null = null;
  let toolCount = 0;
  let timer: { readonly handle: unknown } | undefined;
  /** The values of the timings the shown state depends on, at the last switch. */
  let sentWith: readonly number[] = [];
  let stopped = false;

  /**
   * The fields every demo event carries. With `replayedAgoMs`, the event is
   * replayed (`replay: true`) and dated that long ago.
   */
  function common(replayedAgoMs?: number) {
    const fields = {
      source: 'demo',
      sessionKey: DEMO_SESSION_KEY,
      ts: Math.max(0, wallNow() - (replayedAgoMs ?? 0)),
      via: 'log',
      confidence: 'exact',
    } as const;
    return replayedAgoMs === undefined
      ? fields
      : { ...fields, replay: true as const };
  }

  function nextToolId(): string {
    toolCount += 1;
    return `demo-tool-${toolCount}`;
  }

  function closeTool(): void {
    if (openToolId !== null) {
      emit({ type: 'tool.end', ...common(), toolCallId: openToolId });
      openToolId = null;
    }
  }

  /** `turn.start`, then a fresh tool call left open. Returns its id. */
  function startTool(): string {
    emit({ type: 'turn.start', ...common() });
    const toolCallId = nextToolId();
    emit({
      type: 'tool.start',
      ...common(),
      toolCallId,
      toolName: DEMO_TOOL_NAME,
    });
    openToolId = toolCallId;
    return toolCallId;
  }

  /**
   * Opens the session with live events unless it is open; with `again`,
   * even then (it may have expired without the demo knowing).
   */
  function openSession(again: boolean): void {
    if (again || !sessionOpen) {
      emit({ type: 'session.start', ...common() });
      emit({
        type: 'session.meta',
        ...common(),
        displayName: DEMO_DISPLAY_NAME,
      });
      sessionOpen = true;
    }
  }

  /** Ends the session if open and starts it again, dated idleMs ago. */
  function restartIdle(idleMs: number): void {
    if (sessionOpen) {
      emit({ type: 'session.end', ...common() });
    }
    emit({ type: 'session.start', ...common(idleMs) });
    emit({
      type: 'session.meta',
      ...common(idleMs),
      displayName: DEMO_DISPLAY_NAME,
    });
    sessionOpen = true;
  }

  const activity = (): void => {
    emit({ type: 'activity', ...common() });
  };

  /** What each state repeats, and how often (see the list above). */
  const repeats: Readonly<Record<StateCode, Repeat>> = {
    thinking: halfOf('idleMs', activity),
    working: halfOf('idleMs', activity),
    approval: halfOf('idleMs', activity),
    decision: halfOf('idleMs', activity),
    waiting: halfOf('idleMs', activity),
    error: halfOf('errorHoldMs', () => {
      emit({ type: 'error', ...common() });
    }),
    done: halfOf('doneMs', () => {
      emit({ type: 'turn.end', ...common() });
    }),
    idle: {
      dependsOn: ['idleMs', 'sessionExpireMs'],
      every: (t) => {
        const untilExpiry = t.sessionExpireMs - t.idleMs;
        return untilExpiry > 0 ? Math.min(t.idleMs, untilExpiry) / 2 : null;
      },
      send: () => {
        emit({ type: 'activity', ...common(timings().idleMs) });
      },
    },
  };

  /** The values of the timings `state` depends on, from `t`. */
  function dependedOn(state: StateCode, t: DetectionTimings): number[] {
    return repeats[state].dependsOn.map((name) => t[name]);
  }

  /**
   * The events that switch the session to `state`; with `reopen`, opening
   * it again first.
   */
  function switchTo(
    state: StateCode,
    t: DetectionTimings,
    reopen: boolean,
  ): void {
    closeTool();
    if (state !== 'idle') {
      openSession(reopen);
    }
    switch (state) {
      case 'thinking':
        emit({ type: 'turn.start', ...common() });
        break;
      case 'working':
        startTool();
        break;
      case 'approval': {
        const requestId = startTool();
        emit({ type: 'approval.request', ...common(), requestId });
        break;
      }
      case 'decision': {
        const requestId = startTool();
        emit({ type: 'question.request', ...common(), requestId });
        break;
      }
      case 'error':
        emit({ type: 'turn.start', ...common() });
        emit({ type: 'error', ...common() });
        break;
      case 'done':
        emit({ type: 'turn.start', ...common() });
        emit({ type: 'turn.end', ...common() });
        break;
      case 'waiting':
        emit({ type: 'turn.start', ...common() });
        emit({ type: 'turn.end', ...common(0) });
        break;
      case 'idle':
        restartIdle(t.idleMs);
        break;
    }
  }

  function clear(): void {
    if (timer !== undefined) {
      clearTimer(timer.handle);
      timer = undefined;
    }
  }

  /** Sets the repeat for the shown state, half its timing from now. */
  function arm(): void {
    clear();
    if (stopped || shown === null) {
      return;
    }
    const repeat = repeats[shown];
    const every = repeat.every(timings());
    if (every === null) {
      return;
    }
    timer = {
      handle: setTimer(() => {
        timer = undefined;
        if (stopped) {
          return;
        }
        repeat.send();
        arm();
      }, every),
    };
  }

  /** Switches to `state` with the timings in force and sets its repeat. */
  function show(state: StateCode, reopen = false): void {
    const t = timings();
    shown = state;
    sentWith = dependedOn(state, t);
    switchTo(state, t, reopen);
    if (repeats[state].every(t) === null) {
      log(
        `demo mode: ${state} cannot hold while idleMs is not less than sessionExpireMs; not repeating`,
        'warn',
      );
    }
    arm();
  }

  emit({ type: 'sync.ready', source: 'demo' });

  return {
    setState(state) {
      if (stopped) {
        return;
      }
      log(shown === null ? `demo mode on: ${state}` : `demo mode: ${state}`);
      show(state);
    },

    refresh() {
      if (!stopped && shown !== null) {
        show(shown, true);
      }
    },

    retime() {
      if (stopped || shown === null) {
        return;
      }
      const current = dependedOn(shown, timings());
      if (current.some((value, index) => value !== sentWith[index])) {
        show(shown);
      }
    },

    state: () => shown,

    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clear();
      if (sessionOpen) {
        emit({ type: 'session.end', ...common() });
        sessionOpen = false;
      }
      openToolId = null;
      shown = null;
      log('demo mode off');
    },
  };
}
