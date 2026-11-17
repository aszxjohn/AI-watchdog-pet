/**
 * pack-host's rules for what a pack's sandbox sends (Story 3.5), as pure
 * functions: which actors are whose, a fixed-window rate limiter, a bounded
 * JSON size count, and the check of one message. No DOM types, so they are
 * unit-tested under Node.
 */
import { PACK_MESSAGE_MAX_BYTES } from '../../shared/constants';
import { type StageCall, stageCallSchema } from '../../shared/pack-api';
import type { StageActor } from '../../shared/pool';
import type { PackMessageDropReason } from '../../shared/sandbox';

/** The pack id of a character key `<packId>/<characterId>`. */
export function packIdOf(characterKey: string): string {
  const slash = characterKey.indexOf('/');
  return slash < 0 ? characterKey : characterKey.slice(0, slash);
}

/**
 * StageView's actors grouped by pack: pack id → its actors' ids. A pack
 * with no actor is not in the map.
 */
export function actorsByPack(
  actors: readonly Pick<StageActor, 'actorId' | 'characterKey'>[],
): Map<string, Set<string>> {
  const byPack = new Map<string, Set<string>>();
  for (const { actorId, characterKey } of actors) {
    const packId = packIdOf(characterKey);
    const ids = byPack.get(packId) ?? new Set<string>();
    ids.add(actorId);
    byPack.set(packId, ids);
  }
  return byPack;
}

/** Lets through at most `limit` takes per window. */
export interface RateLimiter {
  /** True when one more fits in the current window (and counts it). */
  take(): boolean;
}

/**
 * A fixed-window limiter: a window starts at the first take after the
 * previous one ended and lasts `windowMs` by `now`.
 */
export function createRateLimiter(
  limit: number,
  windowMs: number,
  now: () => number,
): RateLimiter {
  let windowStart = -Infinity;
  let used = 0;
  return {
    take() {
      const at = now();
      if (at - windowStart >= windowMs) {
        windowStart = at;
        used = 0;
      }
      if (used >= limit) {
        return false;
      }
      used += 1;
      return true;
    },
  };
}

/** UTF-8 bytes of `text` (a lone surrogate counts as 3, as U+FFFD would). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * About how many bytes `value` takes as JSON (string escapes not counted),
 * stopping as soon as that is over `limit` (then `limit + 1`). Null when
 * `value` is not plain JSON data: anything but null, booleans, numbers,
 * strings, arrays and plain objects (an `undefined`, a function, a Map, a
 * typed array, an ImageBitmap…). Never throws on structured-cloned data.
 */
export function jsonBytes(value: unknown, limit: number): number | null {
  let total = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null) {
      total += 4;
    } else if (typeof item === 'boolean') {
      total += item ? 4 : 5;
    } else if (typeof item === 'number') {
      total += Number.isFinite(item) ? String(item).length : 4;
    } else if (typeof item === 'string') {
      if (item.length > limit) {
        return limit + 1;
      }
      total += utf8Length(item) + 2;
    } else if (Array.isArray(item)) {
      total += 1 + Math.max(1, item.length);
      if (total > limit) {
        return limit + 1;
      }
      for (let i = item.length - 1; i >= 0; i -= 1) {
        stack.push(item[i]);
      }
    } else if (typeof item === 'object') {
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        return null;
      }
      const keys = Object.keys(item);
      total += 1 + Math.max(1, keys.length);
      for (const key of keys) {
        total += utf8Length(key) + 3;
        if (total > limit) {
          return limit + 1;
        }
        stack.push((item as Record<string, unknown>)[key]);
      }
    } else {
      return null;
    }
    if (total > limit) {
      return limit + 1;
    }
  }
  return total;
}

/** A message that passed checkPackMessage, or why it is dropped. */
export type PackMessageCheck =
  | { readonly ok: true; readonly call: StageCall }
  | { readonly ok: false; readonly reason: PackMessageDropReason };

/**
 * Checks one message from a pack's sandbox (not one of the bootstrap's
 * reports), in this order: plain JSON data no larger than `maxBytes`
 * (`invalid`, `too-large`), a `stage.*` call by the shared schema
 * (`invalid`), and an `actorId` that is one of `ownActors`, the pack's
 * actors in StageView (`not-own-actor`; `fire`'s `target` may be any
 * actor). Rate limits are the caller's.
 */
export function checkPackMessage(
  data: unknown,
  ownActors: ReadonlySet<string>,
  maxBytes: number = PACK_MESSAGE_MAX_BYTES,
): PackMessageCheck {
  const bytes = jsonBytes(data, maxBytes);
  if (bytes === null) {
    return { ok: false, reason: 'invalid' };
  }
  if (bytes > maxBytes) {
    return { ok: false, reason: 'too-large' };
  }
  const parsed = stageCallSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid' };
  }
  const call = parsed.data;
  if (call.type !== 'stage.log' && !ownActors.has(call.actorId)) {
    return { ok: false, reason: 'not-own-actor' };
  }
  return { ok: true, call };
}
