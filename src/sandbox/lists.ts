/**
 * The two lists the Worker bootstrap removes before `lockdown()` (AD-7,
 * Story 3.5). This is the only place either list is spelled out. Keep this
 * file ASCII-only: it is part of the hashed sandbox script.
 */

/**
 * The network, storage and Worker APIs every pack Worker loses, deleted
 * along the global object's prototype chain (some live on
 * WorkerGlobalScope.prototype, not on the global itself) and, if one is
 * still there, shadowed with undefined. Some are not there at all in this
 * Worker (it is not a secure context): WebTransport, caches, SharedWorker.
 */
export const REMOVED_WORKER_APIS: readonly string[] = Object.freeze([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'WebTransport',
  'importScripts',
  'Worker',
  'SharedWorker',
  'indexedDB',
  'caches',
]);

/**
 * Intrinsics SES does not know yet (decision of 2026-11-05, see
 * sandbox-prototype-report.md): SES 2.3.0 has no permit for these methods,
 * which V8 15.6 (Electron 45.2.1) added, so `lockdown()` would remove them
 * itself and print a warning. Each is a path from globalThis; one whose
 * owner or property is missing is skipped. After any Electron or SES
 * upgrade, re-run the sandbox checks: if `lockdown()` warns again, the new
 * names go here, with the user's sign-off.
 */
export const SES_UNKNOWN_INTRINSICS: readonly string[] = Object.freeze([
  'Iterator.prototype.join',
  'Iterator.prototype.includes',
]);
