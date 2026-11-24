/**
 * src/shared/draw-size.ts with ImageBitmaps (Story 3.6's last part), which
 * the Worker bootstrap and the overlay share: jsonBytes counts one as `{}`
 * (told by isImageBitmap, or by the Worker's brand check when given) and
 * collects it when asked, isImageBitmap knows
 * one only where the realm has ImageBitmap, and imageBitmapsIn finds each
 * one once for the overlay to close. FakeImageBitmap stands in for the
 * global ImageBitmap Node does not have. The rest of jsonBytes is tested
 * with pack-host's message rules (test/overlay/pack-host.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  imageBitmapsIn,
  isImageBitmap,
  jsonBytes,
} from '../../src/shared/draw-size';
import { FakeImageBitmap, stubImageBitmap } from '../helpers/fake-bitmaps';

/** JSON.stringify's length, each FakeImageBitmap written as `{}`. */
function asJson(value: unknown): number {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner instanceof FakeImageBitmap ? {} : inner,
  ).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('I/O matrix', () => {
  it('位元組: jsonBytes counts an ImageBitmap as {} (2 bytes) whatever its size, and goes on past it; each one met goes into `bitmaps`, as often as it is met', () => {
    stubImageBitmap();
    const big = new FakeImageBitmap(512, 512);
    const small = new FakeImageBitmap(1, 1);
    const draw = {
      type: 'draw',
      seq: 3,
      actors: {
        a1: [{ type: 'bitmap', image: big, x: 0, y: 0, width: 8, height: 8 }],
        a2: [
          { type: 'bitmap', image: big },
          { image: small, after: 'tail' },
        ],
      },
    };
    const bitmaps: unknown[] = [];

    expect(jsonBytes(draw, 10_000, bitmaps)).toBe(asJson(draw));
    expect(bitmaps.filter((each) => each === big)).toHaveLength(2);
    expect(bitmaps.filter((each) => each === small)).toHaveLength(1);
    expect(bitmaps).toHaveLength(3);
    expect(jsonBytes(big, 10)).toBe(2);
    expect(jsonBytes(small, 10)).toBe(2);
    expect(jsonBytes([big, small], 10)).toBe('[{},{}]'.length);
    // Without a list to collect into, the count is the same.
    expect(jsonBytes(draw, 10_000)).toBe(asJson(draw));
  });

  it('位元組: an ImageBitmap’s 2 bytes count toward the limit: exactly at it is the count, one past it stops at limit + 1', () => {
    stubImageBitmap();
    const value = { image: new FakeImageBitmap() };
    const bytes = asJson(value);

    expect(bytes).toBe('{"image":{}}'.length);
    expect(jsonBytes(value, bytes)).toBe(bytes);
    expect(jsonBytes(value, bytes - 1)).toBe(bytes);
    expect(jsonBytes(value, 1)).toBe(2);
  });

  it('位元組: where the realm has no ImageBitmap (Node), the same object is not plain JSON data: null, and nothing is collected', () => {
    const image = new FakeImageBitmap();
    const bitmaps: unknown[] = [];

    expect(jsonBytes({ image }, 1000, bitmaps)).toBeNull();
    expect(bitmaps).toStrictEqual([]);
    expect(isImageBitmap(image)).toBe(false);
    expect(imageBitmapsIn({ image })).toStrictEqual([]);
  });

  it('藏圖的寫法: jsonBytes takes who tells an ImageBitmap (the Worker gives its brand check): an image whose prototype was changed counts as {} and is collected with it; by instanceof (the default) it passes for a plain object of its own keys, and is not collected (how the Worker used to miss it)', () => {
    stubImageBitmap();
    const image = Object.setPrototypeOf(
      new FakeImageBitmap(),
      Object.prototype,
    ) as object;
    const value = { a1: [{ image }] };
    const missed: unknown[] = [];
    const bitmaps: unknown[] = [];

    expect(isImageBitmap(image)).toBe(false);
    expect(jsonBytes(value, 1000, missed)).toBe(JSON.stringify(value).length);
    expect(missed).toStrictEqual([]);
    expect(jsonBytes(value, 1000, bitmaps, (each) => each === image)).toBe(
      '{"a1":[{"image":{}}]}'.length,
    );
    expect(bitmaps).toHaveLength(1);
    expect(bitmaps[0]).toBe(image);
  });

  it('不是 ImageBitmap: isImageBitmap is true only for an instance of the realm’s ImageBitmap, not for a look-alike', () => {
    stubImageBitmap();

    expect(isImageBitmap(new FakeImageBitmap())).toBe(true);
    for (const value of [
      { width: 8, height: 8, close() {} },
      Object.create(null) as object,
      {},
      [],
      null,
      undefined,
      8,
      'ImageBitmap',
    ]) {
      expect(isImageBitmap(value)).toBe(false);
    }
    // A look-alike is not plain JSON data either (it has a function).
    expect(jsonBytes({ width: 8, height: 8, close() {} }, 1000)).toBeNull();
  });
});

describe('imageBitmapsIn', () => {
  it('finds each ImageBitmap once (what the overlay closes when it drops a message), in lists, objects, Map keys and values and Sets, cycles included; it does not look into typed arrays; nothing in a primitive', () => {
    stubImageBitmap();
    const images = Array.from({ length: 5 }, () => new FakeImageBitmap());
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    cycle.image = images[4];

    const found = imageBitmapsIn({
      list: [images[0], images[0], [{ deep: images[1] }]],
      map: new Map<unknown, unknown>([
        [images[2], 'key'],
        ['value', images[3]],
      ]),
      set: new Set([images[3], images[0]]),
      cycle,
      bytes: new Uint8Array(4),
      buffer: new ArrayBuffer(4),
    });

    expect(new Set(found)).toStrictEqual(new Set(images));
    expect(found).toHaveLength(images.length);
    expect(images.every((image) => image.closes === 0)).toBe(true);
    for (const value of [null, undefined, 'draw', 3, true]) {
      expect(imageBitmapsIn(value)).toStrictEqual([]);
    }
  });
});
