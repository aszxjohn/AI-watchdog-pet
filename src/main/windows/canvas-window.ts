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
 *   forward mouse moves to the page, which hit-tests what takes the mouse
 *   with them; Linux ignores the whole window.
 * - Hover (AD-14, `canvas:set-hover`): the overlay owns whether the cursor
 *   is over something that takes the mouse and says so only when that
 *   changes, with a `seq` one more each time. On macOS and Windows, main
 *   turns click-through off while it is over and back to setClickThrough()
 *   as soon as it is not; a request whose `seq` is not greater than the
 *   last one taken from that page is dropped, and one that changes nothing
 *   does nothing. Each new window and each new page load (a reload or a
 *   rebuild) starts again: click-through on, `seq` back to 0. A page that
 *   stops responding while click-through is off gets it back on (its `seq`
 *   kept). Linux never toggles: the whole window stays click-through.
 * - Right-click (`canvas:context-menu`): the overlay names the session it
 *   was on; main.ts decides which menu that is and pops it up on the
 *   canvas window (menus are defined in menu.ts only).
 * - place() puts it on a display: the first call creates it, later calls
 *   move it with setBounds when the bounds change. Once shown and after
 *   each move, where the window really is (getBounds) is compared with
 *   where it was asked to be, and a difference is logged as a warning (the
 *   OS can move or resize a window: the macOS menu bar, Windows DPI).
 * - A renderer that goes away is logged and the window rebuilt at the same
 *   place (the new overlay fetches a fresh StageView snapshot). A
 *   main-frame load failure is logged.
 * - The canvas's WebGL context (Story 3.6, `canvas:gpu`): the overlay says
 *   when it is lost and when it is back, only when that changes; main logs
 *   one line for each change of a page (a repeat changes nothing, and does
 *   not restart the wait) and reloads the page when the context is not back
 *   within CANVAS_CONTEXT_RESTORE_MS. A GPU process that goes away is
 *   logged by gpu.ts; the canvas comes back through its context.
 * - A page Chromium finds unresponsive (`unresponsive`, its own hang
 *   detection) that still has not responded CANVAS_UNRESPONSIVE_RELOAD_MS
 *   later is reloaded in a new renderer: its renderer is stopped
 *   (forcefullyCrashRenderer) and, once it is gone, the page reloaded. One
 *   that responds again in time (`responsive`) is logged and left as it
 *   is. A page whose context is not back in time while it is also
 *   unresponsive is reloaded that way too, as one recovery.
 * - A page that comes after a recovery and reports on `canvas:ready` that
 *   its canvas did not initialise is reloaded again, as one more recovery.
 *   A reload that cannot be started (stopping the renderer or reloading
 *   throws) falls back to rebuilding the window.
 * - Reloading the canvas is reloading the window's page: the new overlay
 *   subscribes to StageView again, reports `canvas:ready` again and makes
 *   the packs' sandboxes again for the actors on stage. Each new page load
 *   starts all of this over.
 * - Rebuilds and reloads together happen at most CANVAS_REBUILD_LIMIT times
 *   within CANVAS_REBUILD_WINDOW_MS; one more stops them all and is logged
 *   as an error, and the app keeps running without a canvas (a rebuild) or
 *   with the canvas as it is (a reload). Once stopped (that, or the app
 *   quitting), a lost context or an unresponsive page starts no wait and
 *   logs nothing.
 * - macOS: hiding the whole app (another app's 隱藏其他 ⌥⌘H, the Dock's
 *   隱藏) hides the canvas with every other window, and it comes back when
 *   the app is shown again (the menu bar icon opening the panel). Accepted
 *   (Story 3.6, measured on the machine): putting the canvas back on screen
 *   while the app is hidden, with showInactive() or moveTop(), makes macOS
 *   show the whole app again, the panel included.
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
  CANVAS_CONTEXT_RESTORE_MS,
  CANVAS_REBUILD_LIMIT,
  CANVAS_REBUILD_WINDOW_MS,
  CANVAS_UNRESPONSIVE_RELOAD_MS,
} from '../../shared/constants';
import type { SessionKey } from '../../shared/detection-events';
import {
  canvasContextMenu,
  canvasGpu,
  canvasReady,
  canvasSetHover,
  type CanvasGpuState,
  type CanvasHover,
  type CanvasReadyReport,
} from '../../shared/ipc';
import type { DisplayBounds, StageCanvas } from '../../shared/stage-view';
import type { ChannelRenderers } from '../ipc/origin';
import { registerIpcHandler } from '../ipc/register';
import { errorCode, logEvent } from '../log/run-log';
import { describePlacement } from './displays';
import type { WindowsEnvironment } from './environment';
import { OVERLAY_HOST } from './protocols';
import { secureWebPreferences } from './security';

/** Where the canvas is: a non-null StageView `canvas` section. */
export type CanvasPlacement = NonNullable<StageCanvas>;

/** Chromium's net::ERR_ABORTED: a load replaced by a newer one, not a failure. */
const ERR_ABORTED = -3;

/** Only the overlay uses the `canvas:*` channels. */
export const CANVAS_RENDERERS: ChannelRenderers = ['overlay'];

/**
 * Whether the canvas forwards mouse moves to its page while click-through
 * (macOS and Windows), so the page can hit-test and click-through can be
 * turned off under the cursor. Elsewhere (Linux) the whole window ignores
 * the mouse.
 */
function forwardsMouseMoves(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * The canvas window's options: exactly `bounds`, transparent, frameless,
 * always on top, never focused, not in the taskbar, hidden until ready; a
 * non-activating panel on macOS and a tool window (`type: 'toolbar'`) on
 * Windows, where skipTaskbar and focusable alone still leave a full-screen
 * window in Alt+Tab; nothing extra on Linux. webPreferences are the AD-24
 * baseline (security.ts) plus no background throttling, so the stage keeps
 * its pace while other apps are in front.
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
      ...secureWebPreferences(preload),
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
  if (forwardsMouseMoves(platform)) {
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
    /** Matches an IPC event's `sender.id`. */
    readonly id: number;
    loadURL(url: string): Promise<void>;
    /** Loads the page again (a new page load: did-navigate follows). */
    reload(): void;
    /**
     * Stops the page's renderer; `render-process-gone` follows, and a
     * reload after it runs the page in a new renderer.
     */
    forcefullyCrashRenderer(): void;
    /** A main-frame navigation committed: a new page load, reloads included. */
    on(event: 'did-navigate', listener: () => void): unknown;
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
  /** The page stopped responding. */
  on(event: 'unresponsive', listener: () => void): unknown;
  /** The page responds again. */
  on(event: 'responsive', listener: () => void): unknown;
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

export interface CanvasWindowsOptions<
  W extends CanvasWindowHandle = CanvasWindowHandle,
> {
  /** `new BrowserWindow(options)`. */
  readonly createWindow: (options: BrowserWindowConstructorOptions) => W;
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
  /** Starts a timer on the same clock as `now` (default `setTimeout`). */
  readonly setTimer?: (run: () => void, delayMs: number) => unknown;
  /** Clears a timer setTimer started (default `clearTimeout`). */
  readonly clearTimer?: (handle: unknown) => void;
}

export interface CanvasWindows<
  W extends CanvasWindowHandle = CanvasWindowHandle,
> {
  /** Puts the canvas on `placement`: creates it, or moves it there. */
  place(placement: CanvasPlacement): void;
  /**
   * Stops creating and rebuilding the canvas (the app is quitting); the
   * window itself closes with the app.
   */
  stop(): void;
  /** The live canvas window, if any. */
  current(): W | undefined;
  /**
   * The live canvas window when `webContentsId` is its page's (an IPC
   * event's `sender.id`); undefined for any other page.
   */
  windowOf(webContentsId: number): W | undefined;
  /**
   * The page in `webContentsId` says the cursor is (`over`) or is not over
   * what takes the mouse. Turns click-through off or back on, on macOS and
   * Windows; drops a request from any other page, one whose `seq` is not
   * greater than the last one taken, and every request on Linux.
   */
  setHover(webContentsId: number, hover: CanvasHover): void;
  /**
   * The page in `webContentsId` says its WebGL context was lost or is back
   * (only when that changes). A repeat, a report from any other page, and
   * `context-restored` with nothing lost change nothing.
   */
  gpu(webContentsId: number, state: CanvasGpuState): void;
  /**
   * The page in `webContentsId` reported on `canvas:ready`. A page that
   * comes after a recovery and failed to initialise is reloaded (one more
   * recovery, within the limit); anything else changes nothing.
   */
  ready(webContentsId: number, report: CanvasReadyReport): void;
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

/** No request taken yet, click-through on: a new window or page load. */
const NO_HOVER = { seq: 0, over: false } as const;

/** `1.5 s` for the run log. */
function describeSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** Why a page is reloaded, for the run log. */
const CONTEXT_NOT_RESTORED = `its WebGL context was not restored within ${CANVAS_CONTEXT_RESTORE_MS / 1000} s`;
const NOT_RESPONDING = `it still did not respond ${CANVAS_UNRESPONSIVE_RELOAD_MS / 1000} s after Chromium found it unresponsive`;
const NOT_INITIALISED =
  'its canvas did not initialise after a recovery (canvas:ready)';

/** One recovery of the canvas: a rebuilt window or a reloaded page. */
interface Recovery {
  readonly at: number;
  readonly kind: 'rebuild' | 'reload';
}

export function createCanvasWindows<W extends CanvasWindowHandle>({
  createWindow,
  preload,
  env,
  platform,
  // Monotonic, so a wall-clock change cannot reset or stretch the window.
  now = () => performance.now(),
  defer = (run) => {
    setTimeout(run, 0);
  },
  setTimer = (run, delayMs) => setTimeout(run, delayMs),
  clearTimer = (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
}: CanvasWindowsOptions<W>): CanvasWindows<W> {
  let current: W | undefined;
  let placement: CanvasPlacement | undefined;
  /** Each rebuild and reload in the last CANVAS_REBUILD_WINDOW_MS. */
  let recoveries: Recovery[] = [];
  /**
   * Set by stop() or once the limit is hit; nothing is created, rebuilt or
   * reloaded after.
   */
  let stopped = false;
  /**
   * The window whose renderer main stopped on purpose, its page to reload
   * once that renderer is gone (not a crash to rebuild for).
   */
  let reloadWhenGone: W | undefined;
  /**
   * The window whose page was last reloaded or which was last rebuilt, until
   * that page reports a canvas that initialised: a failure from it is one
   * more recovery.
   */
  let recovered: W | undefined;
  /**
   * The current page: since when its WebGL context is lost and the timer
   * that reloads it, and since when it has not responded and the timer that
   * reloads it; undefined while not so.
   */
  let contextLost:
    | { readonly since: number; readonly timer: unknown }
    | undefined;
  let unresponsive:
    | { readonly since: number; readonly timer: unknown }
    | undefined;
  /**
   * The current window's page: the last hover `seq` taken from it, and
   * whether click-through is off because the cursor is over something.
   */
  let hover: { readonly seq: number; readonly over: boolean } = NO_HOVER;

  /** A new page, or none: nothing lost, nothing unresponsive, no timer. */
  function resetPage(): void {
    if (contextLost !== undefined) {
      clearTimer(contextLost.timer);
      contextLost = undefined;
    }
    if (unresponsive !== undefined) {
      clearTimer(unresponsive.timer);
      unresponsive = undefined;
    }
  }

  /**
   * Takes one recovery (`kind`, because of `why`) within the limit. At the
   * limit it stops everything, logs why as an error and answers false.
   */
  function takeRecovery(kind: Recovery['kind'], why: string): boolean {
    const at = now();
    recoveries = recoveries.filter(
      (recovery) => at - recovery.at < CANVAS_REBUILD_WINDOW_MS,
    );
    if (recoveries.length < CANVAS_REBUILD_LIMIT) {
      recoveries.push({ at, kind });
      return true;
    }
    stopped = true;
    resetPage();
    const times = recoveries.length + 1;
    const within = `within ${CANVAS_REBUILD_WINDOW_MS / 1000} s`;
    logEvent(
      'windows',
      kind === 'rebuild' &&
        recoveries.every((recovery) => recovery.kind === 'rebuild')
        ? `canvas renderer gone ${times} times ${within}; not rebuilding it again (the app keeps running without a canvas)`
        : `canvas needed a rebuild or reload ${times} times ${within}, the last because ${why}; not rebuilding or reloading it again (the app keeps running ${kind === 'rebuild' ? 'without a canvas' : 'with the canvas as it is'})`,
      'error',
    );
    return false;
  }

  /**
   * Runs `step` on a window's page (a reload, stopping its renderer); a
   * throw is logged as an error, never thrown from a timer or listener.
   */
  function onPage(what: string, step: () => void): boolean {
    try {
      step();
      return true;
    } catch (error) {
      logEvent(
        'windows',
        `${what} the canvas page failed: ${errorCode(error)}`,
        'error',
      );
      return false;
    }
  }

  /**
   * A reload of `win` that could not be started: the window is rebuilt
   * instead (outside the current call), within the limit.
   */
  function rebuildInstead(win: W): void {
    if (reloadWhenGone === win) {
      reloadWhenGone = undefined;
    }
    if (current !== win) {
      return;
    }
    current = undefined;
    resetPage();
    logEvent(
      'windows',
      'the canvas page could not be reloaded; rebuilding the window instead',
      'warn',
    );
    defer(() => {
      rebuild(win, 'its page could not be reloaded');
    });
  }

  /** The count for the run log, once a recovery is taken. */
  function describeCount(): string {
    return `recovery ${recoveries.length} of ${CANVAS_REBUILD_LIMIT} within ${CANVAS_REBUILD_WINDOW_MS / 1000} s, rebuilds and reloads count together`;
  }

  /**
   * Reloads the page of `win` (still the live window), because of `why`;
   * in a new renderer when `newRenderer` (its renderer is stopped first,
   * and the page reloads once it is gone). Counts toward the limit.
   */
  function reload(win: W, why: string, newRenderer: boolean): void {
    if (stopped || current !== win || win.isDestroyed()) {
      return;
    }
    if (!takeRecovery('reload', why)) {
      return;
    }
    resetPage();
    recovered = win;
    logEvent(
      'windows',
      `reloading the canvas page${newRenderer ? ' in a new renderer' : ''}: ${why} (${describeCount()})`,
      'warn',
    );
    if (newRenderer) {
      reloadWhenGone = win;
      if (
        !onPage('stopping the renderer of', () => {
          win.webContents.forcefullyCrashRenderer();
        })
      ) {
        rebuildInstead(win);
      }
      return;
    }
    if (
      !onPage('reloading', () => {
        win.webContents.reload();
      })
    ) {
      rebuildInstead(win);
    }
  }

  function live(): W | undefined {
    if (current !== undefined && current.isDestroyed()) {
      current = undefined;
    }
    return current;
  }

  function windowOf(webContentsId: number): W | undefined {
    const win = live();
    return win !== undefined && win.webContents.id === webContentsId
      ? win
      : undefined;
  }

  function create(at: CanvasPlacement): void {
    const win = createWindow(canvasWindowOptions(preload, at.bounds, platform));
    current = win;
    hover = NO_HOVER;
    resetPage();
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
        resetPage();
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
    win.on('unresponsive', () => {
      if (current !== win) {
        return;
      }
      // Reloaded in a new renderer unless it responds again in time; a
      // repeat does not restart the wait. Once stopped, no wait.
      if (unresponsive === undefined && !stopped) {
        unresponsive = {
          since: now(),
          timer: setTimer(() => {
            if (current === win && unresponsive !== undefined) {
              reload(win, NOT_RESPONDING, true);
            }
          }, CANVAS_UNRESPONSIVE_RELOAD_MS),
        };
      }
      // A page that stops responding cannot say the cursor left: with
      // click-through off, the window covering the display would swallow
      // every click. Click-through back on; seq kept, so the page's later
      // requests still count.
      if (!hover.over) {
        return;
      }
      hover = { seq: hover.seq, over: false };
      setClickThrough(win, platform);
      logEvent(
        'windows',
        'canvas page stopped responding while it took the mouse; click-through is back on',
        'warn',
      );
    });
    win.on('responsive', () => {
      if (current !== win || unresponsive === undefined) {
        return;
      }
      const { since, timer } = unresponsive;
      clearTimer(timer);
      unresponsive = undefined;
      logEvent(
        'windows',
        `canvas page responding again after ${describeSeconds(now() - since)}; not reloading it`,
      );
    });
    // A new page (a reload) counts its seq from 1 again and has not said
    // the cursor is over anything: click-through back on, seq back to 0.
    // Its WebGL context and responsiveness start over too.
    win.webContents.on('did-navigate', () => {
      if (current !== win) {
        return;
      }
      resetPage();
      const wasOver = hover.over;
      hover = NO_HOVER;
      if (wasOver) {
        setClickThrough(win, platform);
      }
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      if (current !== win) {
        return;
      }
      resetPage();
      // Stopped on purpose to reload the page in a new renderer.
      if (reloadWhenGone === win) {
        reloadWhenGone = undefined;
        logEvent(
          'windows',
          `canvas renderer stopped (${details.reason}, exit code ${details.exitCode}); reloading its page`,
        );
        defer(() => {
          if (
            !stopped &&
            current === win &&
            !win.isDestroyed() &&
            !onPage('reloading', () => {
              win.webContents.reload();
            })
          ) {
            rebuildInstead(win);
          }
        });
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

  function rebuild(gone: W, why = 'its renderer went away'): void {
    if (!gone.isDestroyed()) {
      gone.destroy();
    }
    if (stopped || placement === undefined || live() !== undefined) {
      return;
    }
    if (!takeRecovery('rebuild', why)) {
      return;
    }
    logEvent('windows', `rebuilding the canvas window (${describeCount()})`);
    create(placement);
    recovered = current;
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
      resetPage();
    },

    current: live,

    windowOf,

    setHover(webContentsId, request) {
      const win = windowOf(webContentsId);
      if (win === undefined || !forwardsMouseMoves(platform)) {
        return;
      }
      if (request.seq <= hover.seq) {
        return;
      }
      const changed = request.over !== hover.over;
      hover = { seq: request.seq, over: request.over };
      if (!changed) {
        return;
      }
      if (request.over) {
        win.setIgnoreMouseEvents(false);
      } else {
        setClickThrough(win, platform);
      }
    },

    gpu(webContentsId, state) {
      const win = windowOf(webContentsId);
      if (win === undefined || stopped) {
        return;
      }
      if (state === 'context-lost') {
        // A repeat: still lost, still the first wait.
        if (contextLost !== undefined) {
          return;
        }
        contextLost = {
          since: now(),
          timer: setTimer(() => {
            if (current === win && contextLost !== undefined) {
              // Also unresponsive: a plain reload may never commit.
              reload(win, CONTEXT_NOT_RESTORED, unresponsive !== undefined);
            }
          }, CANVAS_CONTEXT_RESTORE_MS),
        };
        logEvent(
          'windows',
          'canvas WebGL context lost; nothing is drawn until it is restored',
          'warn',
        );
        return;
      }
      if (contextLost === undefined) {
        return;
      }
      const { since, timer } = contextLost;
      clearTimer(timer);
      contextLost = undefined;
      logEvent(
        'windows',
        `canvas WebGL context restored after ${describeSeconds(now() - since)}`,
      );
    },

    ready(webContentsId, report) {
      const win = windowOf(webContentsId);
      if (win === undefined || recovered !== win) {
        return;
      }
      if (report.ok) {
        recovered = undefined;
        return;
      }
      // Answered first, then reloaded.
      defer(() => {
        reload(win, NOT_INITIALISED, false);
      });
    },
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

/**
 * Registers `canvas:ready` (overlay only): each report goes to the run log,
 * then to `canvas.ready` with the sending page's webContents id, when given.
 */
export function registerCanvasReadyHandler(
  canvas?: Pick<CanvasWindows, 'ready'>,
): void {
  registerIpcHandler(canvasReady, CANVAS_RENDERERS, (event, report) => {
    logCanvasReady(report);
    canvas?.ready(event.sender.id, report);
    return null;
  });
}

/**
 * Registers `canvas:set-hover` (overlay only): each request goes to
 * `canvas.setHover` with the sending page's webContents id.
 */
export function registerCanvasHoverHandler(
  canvas: Pick<CanvasWindows, 'setHover'>,
): void {
  registerIpcHandler(canvasSetHover, CANVAS_RENDERERS, (event, hover) => {
    canvas.setHover(event.sender.id, hover);
    return null;
  });
}

/**
 * Registers `canvas:gpu` (overlay only): each report goes to `canvas.gpu`
 * with the sending page's webContents id.
 */
export function registerCanvasGpuHandler(
  canvas: Pick<CanvasWindows, 'gpu'>,
): void {
  registerIpcHandler(canvasGpu, CANVAS_RENDERERS, (event, state) => {
    canvas.gpu(event.sender.id, state);
    return null;
  });
}

/**
 * Registers `canvas:context-menu` (overlay only): a right-click reported by
 * the live canvas window's page goes to `open` with that window, which
 * decides on and pops up the menu; one from any other page is dropped.
 */
export function registerCanvasContextMenuHandler<W>(
  canvas: { windowOf(webContentsId: number): W | undefined },
  open: (sessionKey: SessionKey, win: W) => void,
): void {
  registerIpcHandler(
    canvasContextMenu,
    CANVAS_RENDERERS,
    (event, { sessionKey }) => {
      const win = canvas.windowOf(event.sender.id);
      if (win !== undefined) {
        open(sessionKey, win);
      }
      return null;
    },
  );
}
