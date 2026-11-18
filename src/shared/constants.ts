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
 * main/windows rebuilds the canvas window when its renderer goes away, and
 * reloads its page when it cannot draw (Story 3.6), but at most this many
 * times, all together, within CANVAS_REBUILD_WINDOW_MS; one more in that
 * window stops them all (the app keeps running, without a canvas or with
 * the canvas as it is).
 */
export const CANVAS_REBUILD_LIMIT = 3;

/**
 * The sliding window CANVAS_REBUILD_LIMIT counts in. Every recovery of the
 * canvas counts (Story 3.6): a window rebuilt after its renderer went away,
 * and a page reloaded because its WebGL context was not restored in time
 * (CANVAS_CONTEXT_RESTORE_MS) or it still did not respond
 * CANVAS_UNRESPONSIVE_RELOAD_MS after Chromium found it unresponsive.
 */
export const CANVAS_REBUILD_WINDOW_MS = 60_000;

/**
 * How long main/windows waits, from the overlay saying its canvas lost its
 * WebGL context, for it to say the context is back (Story 3.6); then it
 * reloads the canvas page. PixiJS keeps the lost context restorable, and
 * the GPU process coming back usually restores it within a second or two.
 */
export const CANVAS_CONTEXT_RESTORE_MS = 5_000;

/**
 * How long main/windows waits, once Chromium has found the canvas page
 * unresponsive (Electron's `unresponsive`, which comes only after
 * Chromium's own hang detection), for it to respond again (`responsive`)
 * before it reloads the page in a new renderer (Story 3.6). So the page has
 * stopped responding for longer than this by then. Click-through is back
 * on as soon as `unresponsive` comes.
 */
export const CANVAS_UNRESPONSIVE_RELOAD_MS = 10_000;

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

/**
 * The `pack://` host the stage serves its own documents from (Story 3.5):
 * `pack://_stage/…`. Never a pack id, since an id cannot start with `_`.
 */
export const PACK_STAGE_HOST = '_stage';

/**
 * The sandbox document (Story 3.5, AD-7): its file name next to main.cjs in
 * the build (the main build writes it there, with SES and the Worker
 * bootstrap inlined) and its path under `pack://_stage/`.
 */
export const SANDBOX_DOCUMENT_FILE = 'sandbox.html';

/**
 * The file the same build writes next to SANDBOX_DOCUMENT_FILE: the
 * document's Content-Security-Policy, which carries the hash of its inline
 * script, as `{ "csp": …, "sha256": … }`.
 */
export const SANDBOX_CSP_FILE = 'sandbox-csp.json';

/**
 * How long a pack's sandbox stays after its last actor left the stage
 * (Story 3.5): an actor of the pack coming back within it keeps the
 * sandbox; otherwise the overlay removes the sandbox's iframe.
 */
export const SANDBOX_IDLE_MS = 30_000;

/**
 * Most messages one pack's sandbox may send the stage in each
 * PACK_MESSAGE_RATE_WINDOW_MS (Story 3.5); the overlay drops the rest.
 */
export const PACK_MESSAGE_RATE_LIMIT = 120;

/** The window PACK_MESSAGE_RATE_LIMIT counts in. */
export const PACK_MESSAGE_RATE_WINDOW_MS = 1_000;

/**
 * Largest message one pack's sandbox may send the stage, in bytes of its
 * JSON form (Story 3.5); the overlay drops a larger one whole.
 */
export const PACK_MESSAGE_MAX_BYTES = 64 * 1024;

/**
 * Most `stage.log` lines one pack may write in each
 * STAGE_LOG_RATE_WINDOW_MS (Story 3.5); the overlay drops the rest.
 */
export const STAGE_LOG_RATE_LIMIT = 20;

/** The window STAGE_LOG_RATE_LIMIT counts in. */
export const STAGE_LOG_RATE_WINDOW_MS = 10_000;

/**
 * Longest `stage.log` text, in UTF-16 code units: the sandbox and the
 * overlay cut a longer one (ending it with `…`) before it reaches the run
 * log.
 */
export const STAGE_LOG_MAX_LENGTH = 1_000;

/**
 * The overlay logs dropped pack messages at most once per pack and reason
 * in this long (Story 3.5); the next line counts the ones dropped since.
 */
export const PACK_DROP_LOG_INTERVAL_MS = 10_000;

/**
 * Most entries the Worker bootstrap's removal report may list (Story 3.5):
 * the API list and the intrinsics list together, with room to grow.
 */
export const SANDBOX_REMOVALS_MAX = 32;

/**
 * Most `stage.*` calls a pack Worker keeps while the overlay's port has not
 * arrived yet (Story 3.5); later ones are dropped there. The bootstrap's
 * own reports are always kept.
 */
export const SANDBOX_OUTBOX_MAX = 256;

/**
 * Longest a pack's sandbox may take, from adding its iframe, to report
 * `sandbox.ready` or `sandbox.failed` (Story 3.5); then the overlay
 * removes the iframe as failed (`boot-timeout`): a document that did not
 * load or run, or a factory that never returns.
 */
export const SANDBOX_BOOT_TIMEOUT_MS = 10_000;

/**
 * How many times a second overlay/world ticks (Story 3.6, AD-11): each
 * tick sends every pack with an actor on stage its messages and, unless
 * its previous `frame` is still unanswered, one `frame`. Paused while the
 * system sleeps or the screen is locked.
 */
export const TICK_HZ = 30;

/**
 * Largest `draw` a pack may send, in bytes of its JSON form (Story 3.6).
 * The Worker bootstrap measures what the pack's `frame` returned before it
 * posts it, and answers `sandbox.no-draw` instead of a larger one; the
 * overlay measures again, before parsing the message, and drops a larger
 * one whole.
 */
export const DRAW_MAX_BYTES = 64 * 1024;

/**
 * Most draw commands one `draw` may hold, all its actors together (Story
 * 3.6), counted like DRAW_MAX_BYTES: by the Worker bootstrap before it
 * posts the draw, and again by the overlay before parsing it.
 */
export const DRAW_MAX_COMMANDS = 256;

/**
 * Most events one pack's next `frame` carries (Story 3.6): while its
 * frames go unanswered the events wait, and only the latest this many are
 * kept.
 */
export const FRAME_EVENTS_MAX = 256;

/**
 * Until characters wander (Epic 4), they stand in one row near the bottom
 * right of the canvas (Story 3.6): the first actor rightmost,
 * STAGE_ROW_RIGHT_MARGIN DIP from the world's right edge, their feet
 * STAGE_ROW_BOTTOM_MARGIN DIP above its bottom edge (past a Windows
 * taskbar of 48 DIP or a bottom macOS Dock), each as wide as its `bounds`
 * times its 大小 and STAGE_ROW_GAP DIP from the next. One that does not fit
 * is not drawn.
 */
export const STAGE_ROW_RIGHT_MARGIN = 24;

/** See STAGE_ROW_RIGHT_MARGIN. */
export const STAGE_ROW_BOTTOM_MARGIN = 96;

/** See STAGE_ROW_RIGHT_MARGIN. */
export const STAGE_ROW_GAP = 16;
