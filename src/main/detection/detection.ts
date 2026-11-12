/**
 * main/detection (AD-5, AD-21): holds the session list
 * (main/detection/sessions), the health of each running adapter and demo
 * mode, and owns StageView's `sessions` and `adapters` sections, offered to
 * main/stage-view the way main/windows offers its own (get() and
 * onChange()). main.ts only wires it up; nothing here imports
 * main/windows.
 *
 * - Every adapter output goes to sessions.receive, demo mode's included.
 * - Timings are main/settings' current values. On every settings change
 *   the sessions are evaluated again at once (sessions.retime()), and demo
 *   mode sends its state again if a timing it depends on changed.
 * - Sleep: sessions are timed with a clock that counts it
 *   (main/detection/clock). On resume the sleep is added, demo mode sends
 *   its state again (its repeats did not run while asleep, and its session
 *   may have expired), and the sessions are evaluated again.
 * - Demo mode is off at every start and never saved. Turning it on starts
 *   the demo adapter (health `ok`); turning it off stops it, which ends its
 *   session.
 * - The source adapters it is given (main.ts: Claude Code's and Gemini
 *   CLI's) start with it and stop with it. Each reports its health itself;
 *   what one read of theirs produced reaches sessions as one change.
 * - One change, one notification: what a demo switch, a settings change or
 *   a resume does to the sections is heard once, when it is done. Listeners
 *   hear only the sections that changed.
 * - Start-up sync (Story 2.8): once every source adapter it was given has
 *   sent `sync.ready`, or syncTimeoutMs (its value at creation) has passed
 *   since creation, whichever comes first, onSynced listeners hear, once,
 *   the key of every session an adapter's event named since creation (demo
 *   mode's included; demo mode itself is not waited for). With no source
 *   adapter that is at creation. main/pool sweeps its saved releases with
 *   it; the keys are collected here, not read from the published list,
 *   because main/detection/sessions may publish a source's sessions only
 *   after the deadline has passed.
 */
import type { AdapterOutput, SessionKey } from '../../shared/detection-events';
import type { DetectionTimings, SettingsState } from '../../shared/settings';
import type { AdapterHealth, SourceCode } from '../../shared/sources';
import type { StageViewDetectionSections } from '../../shared/stage-view';
import type { StateCode } from '../../shared/states';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import type { AdapterContext, DetectionAdapter } from './adapter';
import {
  createDemoAdapter,
  DEMO_SESSION_KEY,
  type DemoAdapter,
} from './adapters/demo/demo';
import { createSleepClock } from './clock';
import { createSessions, type DetectedSession } from './sessions';

export type DetectionSectionsListener = (
  sections: Partial<StageViewDetectionSections>,
) => void;

/** Hears the session keys adapters reported until start-up sync. */
export type DetectionSyncedListener = (
  reported: ReadonlySet<SessionKey>,
) => void;

export interface DetectionOptions {
  /** main/settings: the timings are its current values. */
  readonly settings: {
    get(): SettingsState;
    onChange(listener: (state: SettingsState) => void): () => void;
  };
  /** The monotonic clock in ms (default `performance.now`). */
  readonly monotonic?: () => number;
  /** The wall clock in epoch ms (default `Date.now`). */
  readonly wall?: () => number;
  /** Runs `run` once after `delayMs` (default `setTimeout`). */
  readonly setTimer?: (run: () => void, delayMs: number) => unknown;
  /** Cancels a timer setTimer returned (default `clearTimeout`). */
  readonly clearTimer?: (handle: unknown) => void;
  /**
   * The source adapters to run (default none): each starts when detection
   * is created and stops with it.
   */
  readonly adapters?: readonly DetectionAdapter[];
}

export interface Detection {
  /** The current sections. */
  get(): StageViewDetectionSections;
  /** Hears the sections each change changed. Returns an unsubscribe. */
  onChange(listener: DetectionSectionsListener): () => void;
  /**
   * Hears, once, when start-up sync is over (every source adapter sent
   * `sync.ready`, or syncTimeoutMs passed since creation): the key of every
   * session an adapter's event named until then. That is heard after the
   * sections the same change changed. Subscribing afterwards calls
   * `listener` at once with the same set. Returns an unsubscribe.
   */
  onSynced(listener: DetectionSyncedListener): () => void;
  /**
   * Demo mode: shows `state` on the demo session, turning demo mode on if
   * it is off; null turns it off.
   */
  setDemo(state: StateCode | null): void;
  /** The system is about to sleep. */
  suspend(): void;
  /** The system woke up. */
  resume(): void;
  /**
   * Stops every adapter (closing their watchers), the sessions' timer and
   * the sync deadline, with no further notification (the app is quitting).
   * Afterwards nothing happens.
   */
  stop(): void;
}

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('detection', message, level);
}

/** Same value, as it would be sent over IPC. */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** A published session as StageView carries it: plain data. */
function toStageSession({
  sessionKey,
  source,
  displayName,
  state,
  confidence,
}: DetectedSession) {
  return { sessionKey, source, displayName, state, confidence };
}

export function createDetection({
  settings,
  monotonic,
  wall = Date.now,
  setTimer = (run, delayMs) => setTimeout(run, delayMs),
  clearTimer = (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  adapters = [],
}: DetectionOptions): Detection {
  const timings = (): DetectionTimings => settings.get().values;
  const clock = createSleepClock({ monotonic, wall });
  const sessions = createSessions({
    timings,
    now: clock.now,
    wallNow: wall,
    setTimer,
    clearTimer,
  });
  /** Each running adapter's health, in the order they started. */
  const health = new Map<SourceCode, AdapterHealth>();
  let demo: DemoAdapter | undefined;
  const listeners = new Set<DetectionSectionsListener>();
  /** How many batch() calls are under way; changes wait for the last. */
  let batching = 0;
  let stopped = false;

  /**
   * The source adapters that have not sent their own source's `sync.ready`
   * yet (tracked per adapter, so two adapters of one source are both
   * waited for).
   */
  const awaitingSync = new Set<DetectionAdapter>(adapters);
  /** Every session key an adapter's event named until sync. */
  const reported = new Set<SessionKey>();
  let synced = false;
  let syncDeadlinePassed = false;
  let syncTimer: { readonly handle: unknown } | undefined;
  const syncedListeners = new Set<DetectionSyncedListener>();

  /**
   * Notes what an output tells about start-up sync: `from` is the source
   * adapter that sent it, undefined for demo mode (not waited for). Only a
   * `sync.ready` of the adapter's own source counts as its sync.
   */
  function noteForSync(
    output: AdapterOutput,
    from: DetectionAdapter | undefined,
  ): void {
    if (synced) {
      return;
    }
    if (output.type === 'sync.ready') {
      if (from !== undefined && output.source === from.source) {
        awaitingSync.delete(from);
      }
      return;
    }
    if (typeof output.sessionKey === 'string') {
      reported.add(output.sessionKey);
    }
  }

  function callSynced(listener: DetectionSyncedListener): void {
    try {
      listener(reported);
    } catch (error) {
      log(`a synced listener failed (${errorCode(error)})`, 'error');
    }
  }

  /**
   * Ends start-up sync if it is due, outside any batch (so after the
   * sections that change changed were published), and tells the listeners.
   */
  function settleSync(): void {
    if (
      synced ||
      stopped ||
      batching > 0 ||
      (awaitingSync.size > 0 && !syncDeadlinePassed)
    ) {
      return;
    }
    synced = true;
    if (syncTimer !== undefined) {
      clearTimer(syncTimer.handle);
      syncTimer = undefined;
    }
    // Codes and counts only. With no source adapter there was nothing to
    // wait for, and nothing to say.
    if (adapters.length > 0) {
      const waiting = [...awaitingSync].map((adapter) => adapter.source);
      log(
        `start-up sync over: ${
          waiting.length === 0
            ? 'every adapter sent sync.ready'
            : `syncTimeoutMs passed, still waiting for ${waiting.join(', ')}`
        }; ${reported.size} sessions reported`,
      );
    }
    // The live set: a listener that another unsubscribes while they are
    // called has left it and is not reached. Cleared once all are called.
    for (const listener of syncedListeners) {
      callSynced(listener);
    }
    syncedListeners.clear();
  }

  function current(): StageViewDetectionSections {
    return {
      sessions: sessions.list().map(toStageSession),
      adapters: [...health].map(([source, state]) => ({
        source,
        health: state,
      })),
    };
  }

  let sections = current();

  /** Tells the listeners which sections changed, unless in a batch. */
  function publish(): void {
    if (batching > 0 || stopped) {
      return;
    }
    const next = current();
    const changed: Partial<StageViewDetectionSections> = {};
    if (!same(next.sessions, sections.sessions)) {
      changed.sessions = next.sessions;
    }
    if (!same(next.adapters, sections.adapters)) {
      changed.adapters = next.adapters;
    }
    if (Object.keys(changed).length === 0) {
      return;
    }
    sections = { ...sections, ...changed };
    for (const listener of listeners) {
      try {
        listener(changed);
      } catch (error) {
        log(`a sections listener failed (${errorCode(error)})`, 'error');
      }
    }
  }

  /**
   * Runs `run`, then publishes what it changed, once; then ends start-up
   * sync if that change completed it.
   */
  function batch(run: () => void): void {
    batching += 1;
    try {
      run();
    } finally {
      batching -= 1;
      publish();
      settleSync();
    }
  }

  /** Demo mode's outputs: it is not waited for, but its sessions count. */
  const emit = (output: AdapterOutput): void => {
    noteForSync(output, undefined);
    sessions.receive(output);
  };

  sessions.onChange(publish);

  /** The source adapters started and not yet stopped. */
  const running = new Set<DetectionAdapter>();

  function startAdapter(adapter: DetectionAdapter): void {
    const context: AdapterContext = {
      emit(outputs, adapterHealth) {
        if (stopped || !running.has(adapter)) {
          return;
        }
        batch(() => {
          if (adapterHealth !== undefined) {
            health.set(adapter.source, adapterHealth);
          }
          for (const output of outputs) {
            noteForSync(output, adapter);
            sessions.receive(output);
          }
        });
      },
      timings,
      wallNow: wall,
      setTimer,
      clearTimer,
    };
    running.add(adapter);
    try {
      adapter.start(context);
    } catch (error) {
      log(
        `the ${adapter.source} adapter failed to start (${errorCode(error)})`,
        'error',
      );
      // It reads less than it should: nothing, until the app restarts.
      batch(() => {
        health.set(adapter.source, 'degraded');
      });
    }
  }

  function stopAdapter(adapter: DetectionAdapter): void {
    running.delete(adapter);
    try {
      adapter.stop();
    } catch (error) {
      log(
        `the ${adapter.source} adapter failed to stop (${errorCode(error)})`,
        'error',
      );
    }
  }

  settings.onChange(() => {
    if (stopped) {
      return;
    }
    batch(() => {
      demo?.retime();
      sessions.retime();
    });
  });

  // Read now: a later settings change does not move the deadline.
  const syncTimeoutMs = timings().syncTimeoutMs;
  for (const adapter of adapters) {
    startAdapter(adapter);
  }
  // Every adapter may have synced while starting (no records folder), and
  // with none there is nothing to wait for.
  settleSync();
  if (!synced && !stopped) {
    syncTimer = {
      handle: setTimer(() => {
        syncTimer = undefined;
        syncDeadlinePassed = true;
        settleSync();
      }, syncTimeoutMs),
    };
  }

  return {
    get: () => sections,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    onSynced(listener) {
      if (synced) {
        callSynced(listener);
        return () => {};
      }
      syncedListeners.add(listener);
      return () => {
        syncedListeners.delete(listener);
      };
    },

    setDemo(state) {
      if (stopped) {
        return;
      }
      batch(() => {
        if (state === null) {
          demo?.stop();
          demo = undefined;
          health.delete('demo');
          return;
        }
        if (demo === undefined) {
          demo = createDemoAdapter({
            emit,
            timings,
            wallNow: wall,
            setTimer,
            clearTimer,
          });
          health.set('demo', 'ok');
        }
        demo.setState(state);
      });
    },

    suspend() {
      if (!stopped) {
        clock.suspend();
      }
    },

    resume() {
      if (stopped) {
        return;
      }
      const slept = clock.resume();
      log(
        slept === null
          ? 'resumed with no suspend before it; the detection clock is unchanged'
          : `resumed: added ${Math.round(slept)} ms of sleep to the detection clock`,
      );
      batch(() => {
        demo?.refresh();
        sessions.retime();
      });
    },

    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      sessions.stop();
      if (syncTimer !== undefined) {
        clearTimer(syncTimer.handle);
        syncTimer = undefined;
      }
      syncedListeners.clear();
      // stopAdapter removes each from the set; a Set iterates on safely.
      for (const adapter of running) {
        stopAdapter(adapter);
      }
      // Its session.end reaches a stopped sessions: nothing is published.
      demo?.stop();
      demo = undefined;
      health.clear();
    },
  };
}

/**
 * The demo session's state in a `sessions` section; null when it is not
 * there, which means demo mode is off.
 */
export function demoStateOf(
  sessions: StageViewDetectionSections['sessions'],
): StateCode | null {
  return (
    sessions.find((session) => session.sessionKey === DEMO_SESSION_KEY)
      ?.state ?? null
  );
}

/**
 * Calls `listener` with the demo session's state now, then each time it
 * changes, whatever changed it (null: demo mode off). The tray's 示範模式
 * check mark follows it. Returns an unsubscribe.
 */
export function watchDemoState(
  detection: Pick<Detection, 'get' | 'onChange'>,
  listener: (state: StateCode | null) => void,
): () => void {
  let last = demoStateOf(detection.get().sessions);
  listener(last);
  return detection.onChange((sections) => {
    if (sections.sessions === undefined) {
      return;
    }
    const next = demoStateOf(sections.sessions);
    if (next === last) {
      return;
    }
    last = next;
    listener(next);
  });
}

export type SleepEvent = 'suspend' | 'resume';

/** The parts of Electron's `powerMonitor` used here. */
export interface SleepEvents {
  on(event: SleepEvent, listener: () => void): unknown;
}

/**
 * Follows the system's sleep for `detection`'s clock: `suspend` and
 * `resume` go to it. Call once, after `ready`.
 */
export function watchSleep(
  monitor: SleepEvents,
  detection: Pick<Detection, 'suspend' | 'resume'>,
): void {
  monitor.on('suspend', () => {
    detection.suspend();
  });
  monitor.on('resume', () => {
    detection.resume();
  });
}
