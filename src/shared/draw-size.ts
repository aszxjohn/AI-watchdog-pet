/**
 * How big a pack's message is, counted without parsing it (Stories 3.5,
 * 3.6): its JSON size, a `draw`'s command count and its emitter count,
 * each stopping as soon as it is over its limit. The overlay checks what a
 * sandbox sends with the first two before parsing it, and the emitters
 * once the `draw` is valid; the Worker bootstrap checks its copy of a
 * `draw` (plain data and ImageBitmaps only, which it made and collected
 * the ImageBitmaps of) with the first two before posting it, telling an
 * ImageBitmap by its own brand check. And its ImageBitmaps (Story 3.6's
 * last part): the overlay finds every one in a message to close it. No
 * imports, so the sandbox bundle can use them too.
 */

/** An ImageBitmap, as far as the stage uses one (no DOM types here). */
export interface ImageBitmapLike {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/**
 * Whether `value` is an ImageBitmap of this realm: false wherever there is
 * no ImageBitmap (Node).
 */
export function isImageBitmap(value: unknown): value is ImageBitmapLike {
  const { ImageBitmap: type } = globalThis as { ImageBitmap?: unknown };
  return typeof type === 'function' && value instanceof type;
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
 * stopping as soon as that is over `limit` (then `limit + 1`). An
 * ImageBitmap counts as `{}` (2 bytes: it is transferred, not copied as
 * JSON), and goes into `bitmaps` when given, each time it is met; what is
 * one is up to `isBitmap` (isImageBitmap unless given: the Worker
 * bootstrap gives its brand check, which a changed prototype does not
 * fool). Null when `value` is not plain JSON data: anything but null,
 * booleans, numbers, strings, arrays, plain objects and ImageBitmaps (an
 * `undefined`, a function, a Map, a typed array…). Never throws on
 * structured-cloned data.
 */
export function jsonBytes(
  value: unknown,
  limit: number,
  bitmaps?: unknown[],
  isBitmap: (value: unknown) => boolean = isImageBitmap,
): number | null {
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
    } else if (isBitmap(item)) {
      total += 2;
      bitmaps?.push(item);
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

/**
 * How many `particles` commands `data.actors` holds over all its actors
 * (Story 3.6: each is one emitter), stopping as soon as that is over
 * `limit` (then `limit + 1`). Only objects of `type: 'particles'` in lists
 * count; anything else counts 0. Never throws on structured-cloned data.
 */
export function countEmitters(data: unknown, limit: number): number {
  if (typeof data !== 'object' || data === null) {
    return 0;
  }
  const { actors } = data as { actors?: unknown };
  if (typeof actors !== 'object' || actors === null || Array.isArray(actors)) {
    return 0;
  }
  let count = 0;
  for (const commands of Object.values(actors)) {
    if (!Array.isArray(commands)) {
      continue;
    }
    for (const command of commands) {
      if (
        typeof command === 'object' &&
        command !== null &&
        (command as { type?: unknown }).type === 'particles'
      ) {
        count += 1;
        if (count > limit) {
          return limit + 1;
        }
      }
    }
  }
  return count;
}

/**
 * Every ImageBitmap anywhere in `value`, each once: in lists, Maps, Sets
 * and the own enumerable values of any other object (typed arrays and
 * ArrayBuffers are not looked into). For the overlay, on data that came
 * structured-cloned, cycles included; never throws on it.
 */
export function imageBitmapsIn(value: unknown): ImageBitmapLike[] {
  const found = new Set<ImageBitmapLike>();
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item !== 'object' || item === null || seen.has(item)) {
      continue;
    }
    seen.add(item);
    if (isImageBitmap(item)) {
      found.add(item);
    } else if (item instanceof Map) {
      for (const [key, inner] of item) {
        stack.push(key, inner);
      }
    } else if (item instanceof Set) {
      for (const inner of item) {
        stack.push(inner);
      }
    } else if (!ArrayBuffer.isView(item) && !(item instanceof ArrayBuffer)) {
      // One by one: spreading a long list could overflow the call stack.
      for (const inner of Object.values(item)) {
        stack.push(inner);
      }
    }
  }
  return [...found];
}
