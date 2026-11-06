/**
 * The canvas window (FR1, AD-14): the only place it is created. One
 * transparent, frameless, always-on-top window covering the display that
 * main/windows chose (displays.ts); the overlay page draws the stage in it
 * with PixiJS.
 *
 * - It never takes focus and never shows in the taskbar, ⌘Tab or Alt+Tab:
 *   it cannot be focused, skips the taskbar, is a non-activating panel on
 *   macOS and a tool window on Windows, and is shown with showInactive()
 *   once ready. It does not count as a panel
 *   for the Dock (dock.ts). setVisibleOnAllWorkspaces is never called: a
 *   macOS panel already shows on every Space.
 * - Every click goes through to the windows below. macOS and Windows still
 *   forward mouse moves to the page (Story 4.2 hit-tests characters with
 *   them); Linux ignores the whole window.
 * - place() puts it on a display: the first call creates it, later calls
 *   move it with setBounds when the bounds change. Once shown and after
 *   each move, where the window really is (getBounds) is compared with
 *   where it was asked to be, and a difference is logged as a warning (the
 *   OS can move or resize a window: the macOS menu bar, Windows DPI).
 * - A renderer that goes away is logged and the window rebuilt at the same
 *   place (the new overlay fetches a fresh StageView snapshot), at most
 *   CANVAS_REBUILD_LIMIT times within CANVAS_REBUILD_WINDOW_MS; one more
 *   stops the rebuilds and is logged as an error, and the app keeps running
 *   without a canvas. A main-frame load failure is logged.
 * - The overlay reports on `canvas:ready` whether PixiJS initialised; that
 *   goes to the run log.
 */
import type {
  BrowserWindowConstructorOptions,
  IgnoreMouseEventsOptions,
  RenderProcessGoneDetails,
} from 'electron';
import {
  APP_SCHEME,
  CANVAS_REBUILD_LIMIT,
  CANVAS_REBUILD_WINDOW_MS,
} from '../../shared/constants';
import { canvasReady, type CanvasReadyReport } from '../../shared/ipc';
import type { DisplayBounds, StageCanvas } from '../../shared/stage-view';
import type { ChannelRenderers } from '../ipc/origin';
import { registerIpcHandler } from '../ipc/register';
import { logEvent } from '../log/run-log';
import { describePlacement } from './displays';
import type { WindowsEnvironment } from './environment';
import { panelWebPreferences } from './panel-window';
import { OVERLAY_HOST } from './protocols';

/** Where the canvas is: a non-null StageView `canvas` section. */
export type CanvasPlacement = NonNullable<StageCanvas>;

/** Chromium's net::ERR_ABORTED: a load replaced by a newer one, not a failure. */
const ERR_ABORTED = -3;

/** Only the overlay reports on `canvas:ready`. */
export const CANVAS_RENDERERS: ChannelRenderers = ['overlay'];

/**
 * The canvas window's options: exactly `bounds`, transparent, frameless,
 * always on top, never focused, not in the taskbar, hidden until ready; a
 * non-activating panel on macOS and a tool window (`type: 'toolbar'`) on
 * Windows, where skipTaskbar and focusable alone still leave a full-screen
 * window in Alt+Tab; nothing extra on Linux. webPreferences are the panel's (AD-24)
 * plus no background throttling, so the stage keeps its pace while other
 * apps are in front.
 *
 * macOS also gets `enableLargerThanScreen`: without it AppKit constrains
 * even a frameless window to below the menu bar (measured: a 1920x1080
 * canvas asked for at y 0 landed at y 30), so the canvas would not cover
 * the display; with it Electron keeps a frameless window's frame as given.
 * The menu bar still draws above the canvas.
 */
export function canvasWindowOptions(
  preload: string,
  bounds: DisplayBounds,
  platform: NodeJS.Platform,
): BrowserWindowConstructorOptions {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(platform === 'darwin'
      ? { type: 'panel', enableLargerThanScreen: true }
      : {}),
    ...(platform === 'win32' ? { type: 'toolbar' } : {}),
    webPreferences: {
      ...panelWebPreferences(preload),
      backgroundThrottling: false,
    },
  };
}

/**
 * Lets every click on `win` through to the windows below. macOS and
 * Windows: `setIgnoreMouseEvents(true, { forward: true })`, so the page still
 * sees mouse moves; elsewhere (Linux): `setIgnoreMouseEvents(true)`, the
 * whole window.
 */
export function setClickThrough(
  win: Pick<CanvasWindowHandle, 'setIgnoreMouseEvents'>,
  platform: NodeJS.Platform,
): void {
  if (platform === 'darwin' || platform === 'win32') {
    win.setIgnoreMouseEvents(true, { forward: true });
  } else {
    win.setIgnoreMouseEvents(true);
  }
}

/**
 * Where the canvas loads the overlay from: `app://overlay/index.html` once
 * packaged, the overlay dev server under `npm start`.
 */
export function overlayUrl(env: WindowsEnvironment): string {
  return (
    env.devServers.overlay?.url ?? `${APP_SCHEME}://${OVERLAY_HOST}/index.html`
  );
}

/** The parts of a BrowserWindow the canvas uses. */
export interface CanvasWindowHandle {
  readonly webContents: {
    loadURL(url: string): Promise<void>;
    on(
      event: 'did-fail-load',
      listener: (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => void,
    ): unknown;
    on(
      event: 'render-process-gone',
      listener: (event: unknown, details: RenderProcessGoneDetails) => void,
    ): unknown;
  };
  once(event: 'ready-to-show', listener: () => void): unknown;
  on(event: 'closed', listener: () => void): unknown;
  setIgnoreMouseEvents(
    ignore: boolean,
    options?: IgnoreMouseEventsOptions,
  ): void;
  setBounds(bounds: DisplayBounds): void;
  getBounds(): DisplayBounds;
  showInactive(): void;
  isDestroyed(): boolean;
  destroy(): void;
}

export interface CanvasWindowsOptions {
  /** `new BrowserWindow(options)`. */
  readonly createWindow: (
    options: BrowserWindowConstructorOptions,
  ) => CanvasWindowHandle;
  /** Absolute path of the overlay preload bundle. */
  readonly preload: string;
  readonly env: WindowsEnvironment;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** A monotonic clock in ms (default `performance.now`). */
  readonly now?: () => number;
  /**
   * Runs `run` soon, outside the current Electron event (default
   * `setTimeout(run, 0)`), so a window is not destroyed from inside its
   * own `render-process-gone` listener.
   */
  readonly defer?: (run: () => void) => void;
}

export interface CanvasWindows {
  /** Puts the canvas on `placement`: creates it, or moves it there. */
  place(placement: CanvasPlacement): void;
  /**
   * Stops creating and rebuilding the canvas (the app is quitting); the
   * window itself closes with the app.
   */
  stop(): void;
  /** The live canvas window, if any. */
  current(): CanvasWindowHandle | undefined;
}

function sameBounds(a: DisplayBounds, b: DisplayBounds): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/** `1920x1080 at 0,30` for the run log. */
function describeBounds(bounds: DisplayBounds): string {
  return `${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}`;
}

/**
 * Logs one warning when `win` is not where it was asked to be. Never
 * throws; a window that cannot report its bounds is skipped.
 */
function checkBounds(
  win: CanvasWindowHandle,
  wanted: DisplayBounds,
  when: string,
): void {
  let actual: DisplayBounds;
  try {
    if (win.isDestroyed()) {
      return;
    }
    actual = win.getBounds();
  } catch {
    return;
  }
  if (!sameBounds(actual, wanted)) {
    logEvent(
      'windows',
      `canvas window is at ${describeBounds(actual)}, not the requested ${describeBounds(wanted)} (${when})`,
      'warn',
    );
  }
}

export function createCanvasWindows({
  createWindow,
  preload,
  env,
  platform,
  // Monotonic, so a wall-clock change cannot reset or stretch the window.
  now = () => performance.now(),
  defer = (run) => {
    setTimeout(run, 0);
  },
}: CanvasWindowsOptions): CanvasWindows {
  let current: CanvasWindowHandle | undefined;
  let placement: CanvasPlacement | undefined;
  /** When each rebuild in the last CANVAS_REBUILD_WINDOW_MS happened. */
  let rebuilds: number[] = [];
  /** Set by stop() or once the rebuild limit is hit; nothing is created after. */
  let stopped = false;

  function live(): CanvasWindowHandle | undefined {
    if (current !== undefined && current.isDestroyed()) {
      current = undefined;
    }
    return current;
  }

  function create(at: CanvasPlacement): void {
    const win = createWindow(canvasWindowOptions(preload, at.bounds, platform));
    current = win;
    setClickThrough(win, platform);
    logEvent('windows', `canvas window created on ${describePlacement(at)}`);

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) {
        return;
      }
      win.showInactive();
      if (current === win && placement !== undefined) {
        checkBounds(win, placement.bounds, 'once shown');
      }
    });
    win.on('closed', () => {
      if (current === win) {
        current = undefined;
        logEvent('windows', 'canvas window closed');
      }
    });
    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _url, isMainFrame) => {
        if (!isMainFrame || errorCode === ERR_ABORTED) {
          return;
        }
        logEvent(
          'windows',
          `canvas page failed to load (${errorCode} ${errorDescription})`,
          'error',
        );
      },
    );
    win.webContents.on('render-process-gone', (_event, details) => {
      if (current !== win) {
        return;
      }
      logEvent(
        'windows',
        `canvas renderer gone (${details.reason}, exit code ${details.exitCode})`,
        'error',
      );
      current = undefined;
      defer(() => {
        rebuild(win);
      });
    });

    // A rejected load is logged by did-fail-load; nothing more to do here.
    win.webContents.loadURL(overlayUrl(env)).catch(() => {});
  }

  function rebuild(gone: CanvasWindowHandle): void {
    if (!gone.isDestroyed()) {
      gone.destroy();
    }
    if (stopped || placement === undefined || live() !== undefined) {
      return;
    }
    const at = now();
    rebuilds = rebuilds.filter((time) => at - time < CANVAS_REBUILD_WINDOW_MS);
    if (rebuilds.length >= CANVAS_REBUILD_LIMIT) {
      stopped = true;
      logEvent(
        'windows',
        `canvas renderer gone ${rebuilds.length + 1} times within ${CANVAS_REBUILD_WINDOW_MS / 1000} s; not rebuilding it again (the app keeps running without a canvas)`,
        'error',
      );
      return;
    }
    rebuilds.push(at);
    logEvent(
      'windows',
      `rebuilding the canvas window (${rebuilds.length} of ${CANVAS_REBUILD_LIMIT} within ${CANVAS_REBUILD_WINDOW_MS / 1000} s)`,
    );
    create(placement);
  }

  return {
    place(next) {
      const previous = placement;
      placement = next;
      if (stopped) {
        return;
      }
      const win = live();
      if (win === undefined) {
        create(next);
        return;
      }
      if (previous !== undefined && sameBounds(previous.bounds, next.bounds)) {
        return;
      }
      win.setBounds(next.bounds);
      logEvent('windows', `canvas window moved to ${describePlacement(next)}`);
      checkBounds(win, next.bounds, 'after the move');
    },

    stop() {
      stopped = true;
    },

    current: live,
  };
}

/** The run log line for a `canvas:ready` report. */
export function logCanvasReady(report: CanvasReadyReport): void {
  if (report.ok) {
    logEvent(
      'windows',
      `canvas ready (renderer ${report.renderer}, ${report.width}x${report.height})`,
    );
    return;
  }
  logEvent('windows', `canvas failed to initialise: ${report.reason}`, 'error');
}

/** Registers `canvas:ready` (overlay only): each report goes to the run log. */
export function registerCanvasReadyHandler(): void {
  registerIpcHandler(canvasReady, CANVAS_RENDERERS, (_event, report) => {
    logCanvasReady(report);
    return null;
  });
}
