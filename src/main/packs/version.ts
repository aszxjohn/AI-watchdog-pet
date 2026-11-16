/**
 * main/packs: ordering pack versions, to tell an update from a downgrade.
 * A pack version is `MAJOR.MINOR.PATCH`, digits only, no leading zeros
 * (packVersionSchema); nothing else of semver is needed.
 */

/** Compares two digit strings without leading zeros, of any length. */
function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Negative when `a` is older than `b`, 0 when they are the same, positive
 * when `a` is newer: MAJOR first, then MINOR, then PATCH, each as a whole
 * number (so `1.10.0` is newer than `1.9.0`, at any size). Both must have
 * passed packVersionSchema.
 */
export function comparePackVersions(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < 3; i += 1) {
    const order = compareDigits(left[i] ?? '', right[i] ?? '');
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}
