/**
 * How big a pack's message is, counted without parsing it (Stories 3.5,
 * 3.6): its JSON size and a `draw`'s command count, each stopping as soon
 * as it is over its limit. The overlay checks what a sandbox sends with
 * them before parsing it; the Worker bootstrap checks a `draw` with them
 * before posting it. No imports, so the sandbox bundle can use them too.
 */

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

/**
 * How many commands `data.actors` holds over all its actors (each value
 * that is a list counts its length), stopping as soon as that is over
 * `limit` (then `limit + 1`). Anything else counts 0: the schema rejects
 * it. Never throws on structured-cloned data.
 */
export function countDrawCommands(data: unknown, limit: number): number {
  if (typeof data !== 'object' || data === null) {
    return 0;
  }
  const { actors } = data as { actors?: unknown };
  if (typeof actors !== 'object' || actors === null || Array.isArray(actors)) {
    return 0;
  }
  let count = 0;
  for (const commands of Object.values(actors)) {
    if (Array.isArray(commands)) {
      count += commands.length;
      if (count > limit) {
        return limit + 1;
      }
    }
  }
  return count;
}
