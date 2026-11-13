/**
 * main/persist: what main/settings and main/pool share for the app quit.
 * flushOnQuit writes, on `will-quit`, what an owner of one of the small
 * JSON files (settings.json, assignments.json) still holds back for its
 * debounce. Each owner keeps its own flushSync (which writes through
 * main/persist/files); this only calls it. It depends on neither owner.
 */

/**
 * Writes `store`'s pending changes when the app quits (`will-quit`), before
 * Electron exits. Listeners run in the order they were added, so anything
 * registered on `will-quit` after this call runs after the flush.
 */
export function flushOnQuit(
  app: { on(event: 'will-quit', listener: () => void): unknown },
  store: { flushSync(): void },
): void {
  app.on('will-quit', () => {
    store.flushSync();
  });
}
