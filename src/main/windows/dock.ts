/**
 * The macOS Dock icon follows the number of open panels (FR7, AD-14): hidden
 * at startup, shown when the count goes from 0 to 1 (so ⌘Tab reaches the
 * panel), hidden again when it returns to 0. On Windows and Linux nothing
 * happens here: each panel window has its own taskbar button, and the tray
 * icon takes no taskbar space.
 *
 * macOS ignores `dock.hide()` within about a second of the previous Dock
 * change, so a hide that comes sooner is deferred until
 * DOCK_HIDE_MIN_INTERVAL_MS has passed, and dropped if a panel opened in the
 * meantime.
 */
import { DOCK_HIDE_MIN_INTERVAL_MS } from '../../shared/constants';
import { errorCode, logEvent } from '../log/run-log';

/** The parts of Electron's `app.dock` used here. */
export interface DockApi {
  show(): Promise<void>;
  hide(): void;
}

export interface DockControllerOptions {
  /** `process.platform`; only `darwin` touches the Dock. */
  readonly platform: NodeJS.Platform;
  /** `app.dock`; undefined off macOS. */
  readonly dock: DockApi | undefined;
  /** A monotonic clock in ms (default `performance.now`). */
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
}

export interface DockController {
  /** Hides the Dock icon at startup, before any panel opens. */
  hideAtStartup(): void;
  /** A panel window was created. */
  panelOpened(): void;
  /** A panel window was closed (or destroyed). */
  panelClosed(): void;
  /** How many panels are open. */
  openPanels(): number;
}

export function createDockController({
  platform,
  dock,
  // Monotonic, so a wall-clock change cannot hold a hide back for hours.
  now = () => performance.now(),
  setTimer = setTimeout,
}: DockControllerOptions): DockController {
  const macDock = platform === 'darwin' ? dock : undefined;
  let open = 0;
  let lastChange = Number.NEGATIVE_INFINITY;
  let hideScheduled = false;

  function show(): void {
    if (macDock === undefined) {
      return;
    }
    lastChange = now();
    const failed = (error: unknown): void => {
      logEvent(
        'windows',
        `dock icon could not be shown (${errorCode(error)})`,
        'error',
      );
    };
    try {
      macDock.show().then(() => {
        logEvent('windows', 'dock icon shown');
      }, failed);
    } catch (error) {
      failed(error);
    }
  }

  function hide(reason: string): void {
    if (macDock === undefined) {
      return;
    }
    const wait = lastChange + DOCK_HIDE_MIN_INTERVAL_MS - now();
    if (wait > 0) {
      if (!hideScheduled) {
        hideScheduled = true;
        setTimer(() => {
          hideScheduled = false;
          if (open === 0) {
            hide(reason);
          }
        }, wait);
      }
      return;
    }
    lastChange = now();
    try {
      macDock.hide();
      logEvent('windows', `dock icon hidden (${reason})`);
    } catch (error) {
      logEvent(
        'windows',
        `dock icon could not be hidden (${errorCode(error)})`,
        'error',
      );
    }
  }

  return {
    hideAtStartup() {
      hide('startup');
    },

    panelOpened() {
      open += 1;
      if (open === 1) {
        show();
      }
    },

    panelClosed() {
      if (open === 0) {
        return;
      }
      open -= 1;
      if (open === 0) {
        hide('no panel open');
      }
    },

    openPanels: () => open,
  };
}
