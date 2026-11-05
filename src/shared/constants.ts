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
