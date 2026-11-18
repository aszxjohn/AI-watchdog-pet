/**
 * The GPU process going away (Story 3.6): Electron's app `child-process-gone`
 * with `type` `GPU` is logged, one line with its name, reason code and exit
 * code; any other child process is left to Electron.
 *
 * - A clean exit is an info line: nothing went wrong, and nothing needs to
 *   recover.
 * - Any other reason is an error line. Nothing else happens here: the app
 *   keeps running, Chromium starts a new GPU process, and the canvas tries
 *   to come back through its WebGL context (the overlay reports it lost and
 *   restored on `canvas:gpu`; canvas-window.ts reloads the page when it is
 *   not restored in time).
 * - When the GPU process goes away too often in a short time, Chromium may
 *   block WebGL for the app until it is restarted. Reloading cannot bring
 *   the canvas back then: its reloads fail to get a context, and
 *   canvas-window.ts stops once the recovery limit
 *   (CANVAS_REBUILD_LIMIT within CANVAS_REBUILD_WINDOW_MS) is reached. That
 *   block is Chromium's own protection and is left as it is.
 */
import { logEvent } from '../log/run-log';

/** The parts of a `child-process-gone` event's details used here. */
export interface ChildProcessGoneDetails {
  readonly type: string;
  readonly reason: string;
  readonly exitCode: number;
  /** The process's name, when Electron gives one. */
  readonly name?: string;
}

/** The part of Electron's `app` used here. */
export interface ChildProcessEvents {
  on(
    event: 'child-process-gone',
    listener: (event: unknown, details: ChildProcessGoneDetails) => void,
  ): unknown;
}

/** Logs a GPU process that went away; any other child process is ignored. */
export function logChildProcessGone(details: ChildProcessGoneDetails): void {
  if (details.type !== 'GPU') {
    return;
  }
  const name = details.name === undefined ? '' : ` "${details.name}"`;
  if (details.reason === 'clean-exit') {
    logEvent(
      'windows',
      `GPU process${name} exited cleanly (exit code ${details.exitCode})`,
    );
    return;
  }
  logEvent(
    'windows',
    `GPU process${name} gone (${details.reason}, exit code ${details.exitCode}); the canvas recovers through its WebGL context`,
    'error',
  );
}

/** Follows `app`'s `child-process-gone` with logChildProcessGone. */
export function watchGpuProcess(app: ChildProcessEvents): void {
  app.on('child-process-gone', (_event, details) => {
    logChildProcessGone(details);
  });
}
