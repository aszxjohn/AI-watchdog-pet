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

/**
 * How much of a transcript an adapter replays when it starts reading a file
 * that was already there (at start, a resumed session, a file that got
 * smaller): only its last REPLAY_TAIL_BYTES (Story 2.4). The first, partial
 * line of that tail is skipped.
 */
export const REPLAY_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * An adapter that skips this many unreadable record lines in a row reports
 * its health as `degraded`; the next readable record makes it `ok` again.
 */
export const BAD_LINE_STREAK_DEGRADED = 20;

/**
 * While an AI tool's records folder is missing (not there at start, or
 * removed while running), its adapter checks for it this often; once it is
 * there again, the adapter watches it and replays it as at start. A file
 * watcher does not report a removed folder coming back.
 */
export const RECORDS_FOLDER_RECHECK_MS = 30_000;

/**
 * For a source whose records never show a turn end (`turnEnd: 'none'` in
 * its capability), main/detection/inference guesses the turn ended once
 * this long has passed since the session's last event, after a `turn.reply`
 * with no tool call or request open (Story 2.6). A constant, not a setting:
 * the user chose it, and it is not offered for adjustment.
 */
export const TURN_END_INFER_MS = 10_000;
