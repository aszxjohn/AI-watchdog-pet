/**
 * Sleep and screen lock (AD-14): main/windows follows Electron's
 * powerMonitor and keeps the StageView `power` section up to date, logging
 * one line per event. Nothing pauses yet: there is no world tick until
 * Story 3.6, which reads this section.
 *
 * `lock-screen` and `unlock-screen` come on macOS and Windows only; on Linux
 * `locked` stays false. An app started while the screen is locked hears no
 * `lock-screen`, so the lock state is also read once at the start.
 */
import type { StagePower } from '../../shared/stage-view';
import { logEvent } from '../log/run-log';

export type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

/** The parts of Electron's `powerMonitor` used here. */
export interface PowerEvents {
  on(event: PowerEvent, listener: () => void): unknown;
  /** `'locked'` while the screen is locked (macOS, Windows). */
  getSystemIdleState(idleThreshold: number): string;
}

/** Where the `power` section lives (stage-sources.ts). */
export interface PowerState {
  get(): { readonly power: StagePower };
  update(sections: { power: StagePower }): void;
}

/** What each event changes, and its run log line. */
const POWER_EVENTS: readonly (readonly [
  PowerEvent,
  Partial<StagePower>,
  string,
])[] = [
  ['suspend', { suspended: true }, 'system suspended'],
  ['resume', { suspended: false }, 'system resumed'],
  ['lock-screen', { locked: true }, 'screen locked'],
  ['unlock-screen', { locked: false }, 'screen unlocked'],
];

/**
 * Starts following `monitor`, after reading whether the screen is locked
 * now (a throw counts as not locked). Call once, after `ready`.
 */
export function watchPower(monitor: PowerEvents, state: PowerState): void {
  let lockedNow = false;
  try {
    lockedNow = monitor.getSystemIdleState(0) === 'locked';
  } catch {
    // Unknown: keep `locked: false`; lock-screen / unlock-screen follow.
  }
  if (lockedNow) {
    logEvent('windows', 'screen locked at startup');
    state.update({ power: { ...state.get().power, locked: true } });
  }
  for (const [event, change, message] of POWER_EVENTS) {
    monitor.on(event, () => {
      logEvent('windows', message);
      state.update({ power: { ...state.get().power, ...change } });
    });
  }
}
