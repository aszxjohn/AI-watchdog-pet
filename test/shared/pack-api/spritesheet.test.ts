/**
 * The spritesheet JSON the stage reads (Story 3.6): round trips, what is
 * kept and dropped, rejections, and the two helpers.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SPRITESHEET_FRAME_NAME_MAX_LENGTH,
  spritesheetFitsImage,
  spritesheetFrameSchema,
  spritesheetImagePath,
  spritesheetSchema,
} from '../../../src/shared/pack-api';
import { expectRejected, expectRoundTrip } from '../schema-helpers';
import { withProtoKey } from './samples';

const CONTRACT_SHEET = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packs/contract-pack/contract-pack/img/probe-two-sheet.json',
);

const FULL = {
  frames: {
    'walk-01': {
      frame: { x: 0, y: 0, w: 32, h: 48 },
      rotated: false,
      trimmed: true,
      spriteSourceSize: { x: 2, y: 4, w: 32, h: 48 },
      sourceSize: { w: 36, h: 52 },
    },
    'walk-02': { frame: { x: 32, y: 0, w: 48, h: 32 }, rotated: true },
  },
  meta: { image: 'walk.png', size: { w: 80, h: 48 }, scale: 1 },
};

describe('spritesheetSchema', () => {
  it("round-trips the contract pack's sheet and a sheet with every field it keeps", () => {
    expectRoundTrip(
      spritesheetSchema,
      JSON.parse(readFileSync(CONTRACT_SHEET, 'utf8')) as unknown,
    );
    expectRoundTrip(spritesheetSchema, FULL);
    expectRoundTrip(spritesheetSchema, {
      frames: { a: { frame: { x: 0, y: 0, w: 1, h: 1 } } },
      meta: { image: 'img/a.png' },
    });
  });

  it('takes meta.scale as 1 or "1" (as TexturePacker writes it), or left out', () => {
    for (const scale of [1, '1']) {
      expectRoundTrip(spritesheetSchema, {
        ...FULL,
        meta: { ...FULL.meta, scale },
      });
    }
  });

  it("drops what it does not read: animations, other meta fields, a frame's pivot and anchor", () => {
    const parsed = spritesheetSchema.parse({
      ...FULL,
      animations: { walk: ['walk-01', 'walk-02'] },
      meta: { ...FULL.meta, app: 'TexturePacker', format: 'RGBA8888' },
      frames: {
        ...FULL.frames,
        'walk-01': {
          ...FULL.frames['walk-01'],
          pivot: { x: 0.5, y: 1 },
          anchor: { x: 0.5, y: 1 },
        },
      },
    });

    expect(parsed).toStrictEqual(FULL);
  });

  it.each<[string, unknown]>([
    ['no frames', { meta: FULL.meta }],
    ['frames as a list', { ...FULL, frames: [FULL.frames['walk-01']] }],
    ['no meta', { frames: FULL.frames }],
    ['no meta.image', { ...FULL, meta: { scale: 1 } }],
    ['meta.image with ..', { ...FULL, meta: { image: '../x.png' } }],
    ['meta.image starting with /', { ...FULL, meta: { image: '/x.png' } }],
    ['meta.scale 2', { ...FULL, meta: { ...FULL.meta, scale: 2 } }],
    ['meta.scale "0.5"', { ...FULL, meta: { ...FULL.meta, scale: '0.5' } }],
    [
      'an empty frame name',
      { ...FULL, frames: { '': FULL.frames['walk-01'] } },
    ],
    [
      'a frame name too long',
      {
        ...FULL,
        frames: {
          ['x'.repeat(SPRITESHEET_FRAME_NAME_MAX_LENGTH + 1)]:
            FULL.frames['walk-01'],
        },
      },
    ],
    [
      'a __proto__ frame',
      { ...FULL, frames: withProtoKey(FULL.frames, FULL.frames['walk-01']) },
    ],
  ])('rejects %s', (_label, value) => {
    expectRejected(spritesheetSchema, value);
  });
});

describe('spritesheetFrameSchema', () => {
  it.each<[string, unknown]>([
    ['no frame', { rotated: false }],
    ['a zero width', { frame: { x: 0, y: 0, w: 0, h: 2 } }],
    ['a negative x', { frame: { x: -1, y: 0, w: 2, h: 2 } }],
    ['an infinite height', { frame: { x: 0, y: 0, w: 2, h: Infinity } }],
    [
      'rotated not a boolean',
      { frame: { x: 0, y: 0, w: 2, h: 2 }, rotated: 1 },
    ],
    [
      'an undefined trimmed',
      { frame: { x: 0, y: 0, w: 2, h: 2 }, trimmed: undefined },
    ],
    [
      'a sourceSize of 0',
      { frame: { x: 0, y: 0, w: 2, h: 2 }, sourceSize: { w: 0, h: 2 } },
    ],
    // PixiJS floors a frame: a fraction would shift it or leave it empty.
    ['a fractional frame x', { frame: { x: 0.5, y: 0, w: 2, h: 2 } }],
    ['a fractional frame y', { frame: { x: 0, y: 1.25, w: 2, h: 2 } }],
    ['a fractional frame width', { frame: { x: 0, y: 0, w: 0.5, h: 2 } }],
    ['a fractional frame height', { frame: { x: 0, y: 0, w: 2, h: 2.5 } }],
    [
      'a fractional sourceSize',
      { frame: { x: 0, y: 0, w: 2, h: 2 }, sourceSize: { w: 2.5, h: 2 } },
    ],
    [
      'a fractional spriteSourceSize x',
      {
        frame: { x: 0, y: 0, w: 2, h: 2 },
        spriteSourceSize: { x: 0.5, y: 0, w: 2, h: 2 },
      },
    ],
    [
      'a fractional spriteSourceSize width',
      {
        frame: { x: 0, y: 0, w: 2, h: 2 },
        spriteSourceSize: { x: 0, y: 0, w: 1.5, h: 2 },
      },
    ],
  ])('rejects %s', (_label, value) => {
    expectRejected(spritesheetFrameSchema, value);
  });

  it('takes whole pixels, a negative spriteSourceSize offset included', () => {
    expectRoundTrip(spritesheetFrameSchema, {
      frame: { x: 3, y: 4, w: 5, h: 6 },
      spriteSourceSize: { x: -1, y: 2, w: 5, h: 6 },
      sourceSize: { w: 7, h: 8 },
    });
  });
});

describe('spritesheetImagePath', () => {
  it('takes meta.image relative to the sheet, as the import does', () => {
    expect(spritesheetImagePath('img/probe-two-sheet.json', 'sheet.png')).toBe(
      'img/sheet.png',
    );
    expect(spritesheetImagePath('a/b/c.json', 'd/e.png')).toBe('a/b/d/e.png');
    expect(spritesheetImagePath('sheet.json', 'sheet.png')).toBe('sheet.png');
  });
});

describe('spritesheetFitsImage', () => {
  it('holds when every frame lies inside the image, a rotated one taking h × w', () => {
    expect(spritesheetFitsImage(FULL, 80, 48)).toBe(true);
    // walk-02 is rotated: 32 across, 48 down, at x 32.
    expect(spritesheetFitsImage(FULL, 64, 48)).toBe(true);
    expect(spritesheetFitsImage(FULL, 63, 48)).toBe(false);
    expect(spritesheetFitsImage(FULL, 80, 47)).toBe(false);
    expect(spritesheetFitsImage({ frames: {} }, 1, 1)).toBe(true);
  });
});
