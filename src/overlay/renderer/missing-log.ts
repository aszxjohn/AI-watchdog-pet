/**
 * overlay/renderer (Story 3.6): one run log line per pack whose actor
 * plays a character the stage cannot find (no effective values in
 * StageView's `characters`, or not in the pack's manifest: scene.ts's
 * `missing`),
 * not one per display frame: a pack is logged when it shows up there, and
 * again only after it has been gone from it. Pure, with the log passed in.
 */
import type { PackLogEntry } from '../../shared/sandbox';

/** Takes each display frame's missing packs and logs the new ones. */
export function createMissingLog(
  log: (entry: PackLogEntry) => void,
): (missing: ReadonlySet<string>) => void {
  let logged = new Set<string>();
  return (missing) => {
    for (const packId of missing) {
      if (!logged.has(packId)) {
        log({ kind: 'not-drawn', packId, reason: 'character-missing' });
      }
    }
    logged = new Set(missing);
  };
}
