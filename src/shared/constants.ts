/**
 * Runtime constants (AD-26). Each one is defined here once; every process
 * imports it from here instead of repeating the literal.
 */

/** Scheme the stage's own pages (overlay, panels) load from once packaged. */
export const APP_SCHEME = 'app';

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
