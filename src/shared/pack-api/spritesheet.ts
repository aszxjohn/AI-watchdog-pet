import { z } from '../zod-setup';
import { withoutProtoKey } from './common';
import { packPathSchema } from './manifest';

/**
 * A spritesheet asset's JSON (API 1.0, Story 3.6): the PixiJS / TexturePacker
 * "JSON Hash" format, as far as the stage reads it. The stage checks it when
 * it loads the sheet and hands PixiJS only what this schema keeps:
 *
 * - `frames`: frame name → its rectangle in the image (`frame`, whole
 *   pixels), and optionally `rotated`, `trimmed`, `spriteSourceSize` and
 *   `sourceSize` (whole pixels too), which PixiJS applies as it does for
 *   any sheet. Other
 *   fields of a frame (`pivot`, `anchor`, `borders`…) are dropped: a
 *   sprite is placed by its own `x` and `y` only.
 * - `meta.image`: the sheet's image, relative to the JSON file (the import
 *   checked it names a PNG of the pack); `meta.size`: its size in pixels;
 *   `meta.scale`: 1 or left out (`"1"`, as TexturePacker writes it, is the
 *   same). Other `meta` fields are dropped.
 * - `animations` and anything else at the top level is dropped: a pack
 *   picks each frame itself with a sprite command's `frame`.
 */

/** Longest frame name, in UTF-16 units. */
export const SPRITESHEET_FRAME_NAME_MAX_LENGTH = 256;

/** A size in pixels, above 0 (the image's, in `meta.size`). */
const sheetSizeSchema = z.object({
  w: z.number().positive(),
  h: z.number().positive(),
});

/**
 * A frame's size in whole pixels, above 0. Frame rectangles are whole
 * pixels: PixiJS floors them, so a fraction would shift the frame or make
 * it empty, and the check against the image would miss it.
 */
const framePixelsSchema = z.object({
  w: z.int().positive(),
  h: z.int().positive(),
});

/** A rectangle in whole pixels: `x`, `y` at least 0, `w`, `h` above 0. */
const sheetRectSchema = framePixelsSchema.extend({
  x: z.int().nonnegative(),
  y: z.int().nonnegative(),
});

/** One frame of a sheet. */
export const spritesheetFrameSchema = z.object({
  /** Where it is in the image (a rotated frame takes `h` × `w` there). */
  frame: sheetRectSchema,
  /** Stored turned 90° clockwise in the image. */
  rotated: z.boolean().exactOptional(),
  /** False ignores `spriteSourceSize` and `sourceSize`. */
  trimmed: z.boolean().exactOptional(),
  /** Where the trimmed frame sits in the untrimmed one. */
  spriteSourceSize: framePixelsSchema
    .extend({ x: z.int(), y: z.int() })
    .exactOptional(),
  /** The untrimmed frame's size. */
  sourceSize: framePixelsSchema.exactOptional(),
});

export type SpritesheetFrame = z.infer<typeof spritesheetFrameSchema>;

/** A spritesheet asset's JSON, as the stage keeps it. */
export const spritesheetSchema = z.object({
  frames: withoutProtoKey(
    z.record(
      z.string().min(1).max(SPRITESHEET_FRAME_NAME_MAX_LENGTH),
      spritesheetFrameSchema,
    ),
  ),
  meta: z.object({
    image: packPathSchema,
    size: sheetSizeSchema.exactOptional(),
    scale: z.union([z.literal(1), z.literal('1')]).exactOptional(),
  }),
});

export type PackSpritesheet = z.infer<typeof spritesheetSchema>;

/**
 * The pack path of a sheet's image: `meta.image` taken relative to the
 * folder of the sheet's own path, as PixiJS and the import do.
 */
export function spritesheetImagePath(sheetPath: string, image: string): string {
  const slash = sheetPath.lastIndexOf('/');
  return slash < 0 ? image : `${sheetPath.slice(0, slash)}/${image}`;
}

/**
 * Whether every frame of `sheet` lies inside an image `width` × `height`
 * pixels (a rotated frame takes `h` × `w` there).
 */
export function spritesheetFitsImage(
  sheet: Pick<PackSpritesheet, 'frames'>,
  width: number,
  height: number,
): boolean {
  return Object.values(sheet.frames).every(({ frame, rotated }) => {
    const across = rotated === true ? frame.h : frame.w;
    const down = rotated === true ? frame.w : frame.h;
    return frame.x + across <= width && frame.y + down <= height;
  });
}
