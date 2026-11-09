/**
 * The panel window (FR7, AD-14): the only place a panel is created. There is
 * one panel window; its side navigation switches between the pages in
 * src/shared/panels.ts, and the tray menu opens it on a given page.
 *
 * - open(page) while the panel is open switches it to that page and
 *   brings it to the front; otherwise a new window is created, hidden until
 *   `ready-to-show`. openOrFocus(page) only brings an open panel to the
 *   front, on whatever page it shows (a second launch, macOS `activate`).
 * - close() closes the panel the way ⌘W does (the application menu's
 *   關閉面板, ⌘H); it does nothing when no panel is open.
 * - The Dock controller hears about every panel that opens and closes.
 * - A main-frame load failure or a renderer that goes away is logged and
 *   the panel is closed; the tray menu can open it again. The window is
 *   forgotten at once but destroyed on the next task, as the canvas does,
 *   so it is not destroyed from inside its own webContents event.
 * - The window gets the AD-24 webPreferences baseline (security.ts) and
 *   nothing more; security.ts also adds the window-open and navigation
 *   guards to every window webContents.
 */
import type {
  BrowserWindowConstructorOptions,
  RenderProcessGoneDetails,
} from 'electron';
import { APP_SCHEME, PRODUCT_NAME } from '../../shared/constants';
import { panelPageHash, type PanelPageId } from '../../shared/panels';
import { logEvent } from '../log/run-log';
import type { DockController } from './dock';
import type { WindowsEnvironment } from './environment';
import { PANELS_HOST } from './protocols';
import { secureWebPreferences } from './security';

/**
 * Preload bundle file names, next to main.cjs. Forge names each bundle after
 * its entry in forge.config.mts (src/preload/panels.ts -> panels.cjs); a
 * test keeps the two in step, since a wrong name would otherwise only show
 * up as a missing `window.awp`.
 */
export const PRELOAD_BUNDLES = Object.freeze({
  panels: 'panels.cjs',
  overlay: 'overlay.cjs',
} as const);

/** Title of the panel window. */
export const PANEL_WINDOW_TITLE = PRODUCT_NAME;

/** Chromium's net::ERR_ABORTED: a load replaced by a newer one, not a failure. */
const ERR_ABORTED = -3;

export function panelWindowOptions(
  preload: string,
): BrowserWindowConstructorOptions {
  return {
    width: 960,
    height: 680,
    center: true,
    show: false,
    title: PANEL_WINDOW_TITLE,
    webPreferences: secureWebPreferences(preload),
  };
}

/**
 * Where the panel loads `page` from: `app://panels/index.html#/<page>` once
 * packaged, `<dev server>/#/<page>` under `npm start`.
 */
export function panelUrl(page: PanelPageId, env: WindowsEnvironment): string {
  const url = new URL(
    env.devServers.panels?.url ?? `${APP_SCHEME}://${PANELS_HOST}/index.html`,
  );
  url.hash = panelPageHash(page);
  return url.toString();
}

/** The parts of a BrowserWindow the panel uses. */
export interface PanelWindowHandle {
  readonly webContents: {
    loadURL(url: string): Promise<void>;
    getURL(): string;
    openDevTools(options: { mode: 'detach' }): void;
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
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  close(): void;
  destroy(): void;
}

export interface PanelWindowsOptions {
  /** `new BrowserWindow(options)`. */
  readonly createWindow: (
    options: BrowserWindowConstructorOptions,
  ) => PanelWindowHandle;
  /** Absolute path of the panels preload bundle. */
  readonly preload: string;
  readonly env: WindowsEnvironment;
  readonly dock: Pick<DockController, 'panelOpened' | 'panelClosed'>;
  /** Makes the app the active app (macOS `app.focus({ steal: true })`). */
  readonly focusApp?: () => void;
  /**
   * Runs `run` soon, outside the current Electron event (default
   * `setTimeout(run, 0)`), so a window is not destroyed from inside its
   * own `render-process-gone` or `did-fail-load` listener.
   */
  readonly defer?: (run: () => void) => void;
}

export interface PanelWindows {
  /** Opens the panel on `page`, or switches the open panel to it. */
  open(page: PanelPageId): void;
  /**
   * Brings the open panel to the front without changing its page, or, when
   * no panel is open, opens one on `page`.
   */
  openOrFocus(page: PanelPageId): void;
  /** Closes the panel as ⌘W does; nothing when no panel is open. */
  close(): void;
  /** Whether the panel window exists. */
  isOpen(): boolean;
}

export function createPanelWindows({
  createWindow,
  preload,
  env,
  dock,
  focusApp,
  defer = (run) => {
    setTimeout(run, 0);
  },
}: PanelWindowsOptions): PanelWindows {
  let current: PanelWindowHandle | undefined;

  function live(): PanelWindowHandle | undefined {
    if (current !== undefined && current.isDestroyed()) {
      current = undefined;
    }
    return current;
  }

  function bringToFront(win: PanelWindowHandle): void {
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    focusApp?.();
  }

  function load(win: PanelWindowHandle, page: PanelPageId): void {
    // A rejected load is logged by did-fail-load; nothing more to do here.
    win.webContents.loadURL(panelUrl(page, env)).catch(() => {});
  }

  /**
   * Closes `win` after an error: logged and forgotten now (open() makes a new
   * panel from here on), destroyed on the next task. A second error from the
   * same window before then is ignored.
   */
  function closeAfterError(win: PanelWindowHandle, reason: string): void {
    if (current !== win) {
      return;
    }
    logEvent('windows', `panel closed after an error: ${reason}`, 'error');
    current = undefined;
    defer(() => {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    });
  }

  function create(page: PanelPageId): void {
    const win = createWindow(panelWindowOptions(preload));
    current = win;
    dock.panelOpened();
    logEvent('windows', `panel opened on ${page}`);

    win.once('ready-to-show', () => {
      // Not a window closed after an error and waiting to be destroyed.
      if (!win.isDestroyed() && current === win) {
        bringToFront(win);
      }
    });
    win.on('closed', () => {
      if (current === win) {
        current = undefined;
      }
      dock.panelClosed();
      logEvent('windows', 'panel closed');
    });
    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _url, isMainFrame) => {
        if (!isMainFrame || errorCode === ERR_ABORTED) {
          return;
        }
        closeAfterError(win, `load failed (${errorCode} ${errorDescription})`);
      },
    );
    win.webContents.on('render-process-gone', (_event, details) => {
      closeAfterError(
        win,
        `renderer gone (${details.reason}, exit code ${details.exitCode})`,
      );
    });

    load(win, page);
    if (!env.packaged) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  }

  return {
    open(page) {
      const win = live();
      if (win === undefined) {
        create(page);
        return;
      }
      if (win.webContents.getURL() !== panelUrl(page, env)) {
        logEvent('windows', `panel switched to ${page}`);
        load(win, page);
      }
      bringToFront(win);
    },

    openOrFocus(page) {
      const win = live();
      if (win === undefined) {
        create(page);
        return;
      }
      bringToFront(win);
    },

    close() {
      live()?.close();
    },

    isOpen: () => live() !== undefined,
  };
}
