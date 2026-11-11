/**
 * main/detection/adapters/jsonl/records: reading one line of a transcript
 * as a record, and the record fields whose reading does not depend on the
 * source's format (Story 2.4; shared since Story 2.6). Pure.
 *
 * Records are read leniently: any JSON object is a record, unknown fields
 * are let through, and a field of the wrong type counts as missing.
 */
import { DETECTION_ID_MAX_LENGTH } from '../../../../shared/detection-events';

/** A record's fields, as read. */
export type Fields = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The record's `timestamp` in epoch ms, or null when it has none usable. */
export function timestampOf(record: Fields): number | null {
  const value = record.timestamp;
  const ms =
    typeof value === 'string'
      ? Date.parse(value)
      : typeof value === 'number'
        ? value
        : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const whole = Math.floor(ms);
  return Number.isSafeInteger(whole) ? whole : null;
}

/**
 * `value` trimmed and cut to DETECTION_ID_MAX_LENGTH (never in the middle
 * of a surrogate pair), if it is a non-blank string; null otherwise.
 */
export function displayNameOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length <= DETECTION_ID_MAX_LENGTH) {
    return trimmed;
  }
  const cut = trimmed.slice(0, DETECTION_ID_MAX_LENGTH);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The name of the folder `cwd` names: its last part (`/Users/me/proj` and
 * `C:\Users\me\proj` give `proj`); `/` stays `/`.
 */
export function folderNameOf(cwd: unknown): string | null {
  if (typeof cwd !== 'string') {
    return null;
  }
  const last = cwd.split(/[\\/]+/).findLast((part) => part !== '');
  return displayNameOf(last ?? cwd);
}

/**
 * One line of a transcript as a record: the JSON object it holds, or null
 * when it is not one (a bad line). Never throws.
 */
export function parseRecordLine(line: string): Fields | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}
