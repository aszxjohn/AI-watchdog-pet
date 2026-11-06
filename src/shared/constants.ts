/**
 * Runtime constants (AD-26). Each one is defined here once; every process
 * imports it from here instead of repeating the literal.
 */

/**
 * The product name as shown to the user: tray tooltip, window title, panel
 * header, error dialogs. (index.html's <title> repeats it as a literal.)
 */
export const PRODUCT_NAME = 'AI Watchdog Pet';

/** Scheme the stage's own pages (overlay, panels) load from once packaged. */
export const APP_SCHEME = 'app';

/** Scheme character pack files load from (main/packs serves it, Story 3.2). */
export const PACK_SCHEME = 'pack';

/**
 * macOS ignores `app.dock.hide()` within about a second of the previous Dock
 * change (Electron known issue), so main/windows waits at least this long
 * after one before hiding the Dock icon.
 */
export const DOCK_HIDE_MIN_INTERVAL_MS = 1100;

/** Name each preload exposes its API under: `window.awp`. */
export const PRELOAD_API_KEY = 'awp';

/**
 * Longest an IPC handler may take before main answers `handler-failed`, so a
 * handler that never settles cannot leave a renderer waiting forever.
 */
export const IPC_HANDLER_TIMEOUT_MS = 10_000;

/**
 * How long main/settings waits, from the first change not yet on disk, before
 * writing settings.json once for every change made in that window.
 */
export const SETTINGS_FLUSH_DEBOUNCE_MS = 500;

/** Run log files whose hour started longer ago than this are deleted. */
export const RUN_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Longest run log line, in UTF-16 code units; longer content is cut. */
export const RUN_LOG_MAX_LINE_LENGTH = 4000;

/**
 * main/windows rebuilds the canvas window when its renderer goes away, but
 * at most this many times within CANVAS_REBUILD_WINDOW_MS; one more crash in
 * that window stops the rebuilds (the app keeps running without a canvas).
 */
export const CANVAS_REBUILD_LIMIT = 3;

/** The sliding window CANVAS_REBUILD_LIMIT counts rebuilds in. */
export const CANVAS_REBUILD_WINDOW_MS = 60_000;
