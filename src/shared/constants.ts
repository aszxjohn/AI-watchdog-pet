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

/**
 * How long main/pool waits, from the first change not yet on disk, before
 * writing assignments.json once for every change made in that window.
 */
export const POOL_FLUSH_DEBOUNCE_MS = 500;

/**
 * The limits of one `.awpet` import (Story 3.2, chosen by the user on
 * 2026-11-16). main/packs rejects a pack that goes over any of them:
 * - PACK_IMPORT_MAX_TOTAL_BYTES: the sizes of all its files added up,
 *   unpacked (counted again while unpacking: a file that turns out longer
 *   than it says stops the import);
 * - PACK_IMPORT_MAX_FILES: how many files it has (folders not counted);
 * - PACK_IMPORT_MAX_IMAGE_SIDE: the width and the height of each image it
 *   declares, in pixels;
 * - PACK_IMPORT_MAX_TOTAL_PIXELS: width × height of all its declared images
 *   added up.
 */
export const PACK_IMPORT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** See PACK_IMPORT_MAX_TOTAL_BYTES. */
export const PACK_IMPORT_MAX_FILES = 512;

/** See PACK_IMPORT_MAX_TOTAL_BYTES. */
export const PACK_IMPORT_MAX_IMAGE_SIDE = 4096;

/** See PACK_IMPORT_MAX_TOTAL_BYTES. */
export const PACK_IMPORT_MAX_TOTAL_PIXELS = 64_000_000;

/**
 * Most entries a `.awpet` may list, folders included, checked before any
 * entry is read: twice PACK_IMPORT_MAX_FILES leaves room for a folder per
 * file.
 */
export const PACK_IMPORT_MAX_ENTRIES = PACK_IMPORT_MAX_FILES * 2;

/** Longest entry name in a `.awpet`, in characters (root folder included). */
export const PACK_IMPORT_MAX_PATH_LENGTH = 255;

/** Most `/`-separated segments an entry name in a `.awpet` may have. */
export const PACK_IMPORT_MAX_PATH_SEGMENTS = 32;

/**
 * Longest entry name a refused import quotes back (the display layer shows
 * it); a longer one is cut and ends with `…`.
 */
export const PACK_REJECTED_NAME_MAX_LENGTH = 200;

/**
 * Most manifest problems a refused import publishes in StageView's
 * `packImport` section (the 角色包 page shows them all and counts the
 * rest), so a manifest with thousands of problems stays a small message.
 */
export const PACK_IMPORT_REPORTED_ISSUES_MAX = 5;

/**
 * Most entries settings.json keeps in `packEnabled` (one per pack whose
 * 上場 differs from the default, Story 3.3). A patch that would add one
 * more fails and changes nothing; a file with more is a bad field.
 */
export const PACK_ENABLED_MAX_ENTRIES = 1024;

/**
 * Most entries settings.json keeps in `fixedOverrides` (one per character
 * with a fixed parameter that differs from its default, Story 3.3). A
 * patch that would add one more fails and changes nothing; a file with
 * more is a bad field.
 */
export const FIXED_OVERRIDES_MAX_ENTRIES = 4096;

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

/**
 * For a source whose session id is in a transcript's first line (Gemini
 * CLI's header), its adapter reads at most this much of a transcript's
 * start to find that line before it follows the file (Story 2.6). A first
 * line not complete within it is not a header: the file is not followed,
 * and tried again at its next change.
 */
export const FIRST_LINE_MAX_BYTES = 1024 * 1024;

/**
 * chokidar reports at most one `change` of a path per 50 ms: a write that
 * lands within 50 ms of the last change it reported is dropped, and would
 * be read only at the file's next write (Story 2.6: Gemini CLI rewrites a
 * message with its tool calls ~20 ms after writing it). So after every
 * read caused by a change, an adapter reads that file once more this long
 * later (above chokidar's 50 ms); a later change of the file moves that
 * read later again.
 */
export const TRAILING_READ_MS = 100;
