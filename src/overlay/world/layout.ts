/**
 * overlay/world (Story 3.6): where each actor stands. Until characters
 * wander (Epic 4), they stand in one row near the bottom right of the
 * world (shared/constants: STAGE_ROW_*), in the order given (StageView's
 * `actors`): the first rightmost, each next one to its left, so a new
 * session's actor never moves the ones already there. An actor that
 * leaves moves those after it right; one that takes another's place (a
 * swap of character, Story 3.9) keeps its slot, and moves those after it
 * when its width differs. Pure.
 *
 * An actor takes its `bounds`' width times its 大小 (the `scale` fixed
 * parameter), then STAGE_ROW_GAP to the next. Its position is its local
 * origin (the centre of its feet) in world coordinates (DIP, origin top
 * left): its scaled `bounds` start at the left of its slot, and its feet
 * are STAGE_ROW_BOTTOM_MARGIN above the world's bottom edge (never above
 * the top). The first actor whose slot would start left of the world's
 * left edge does not fit, nor does any after it: they get no position and
 * are not drawn.
 */
import {
  STAGE_ROW_BOTTOM_MARGIN,
  STAGE_ROW_GAP,
  STAGE_ROW_RIGHT_MARGIN,
} from '../../shared/constants';
import type { LocalBox } from '../../shared/pack-api';

/** A point in world coordinates. */
export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

/** The world's size, in DIP. */
export interface WorldSize {
  readonly width: number;
  readonly height: number;
}

/** One actor to place: its key, its `bounds` and its 大小. */
export interface RowMember<K> {
  readonly key: K;
  readonly bounds: Pick<LocalBox, 'x' | 'width'>;
  readonly scale: number;
}

/** Each member that fits, by key, at its local origin's world position. */
export function rowLayout<K>(
  world: WorldSize,
  members: readonly RowMember<K>[],
): Map<K, WorldPoint> {
  const placed = new Map<K, WorldPoint>();
  const feet = Math.max(0, world.height - STAGE_ROW_BOTTOM_MARGIN);
  let right = world.width - STAGE_ROW_RIGHT_MARGIN;
  for (const { key, bounds, scale } of members) {
    const left = right - bounds.width * scale;
    if (left < 0) {
      break;
    }
    placed.set(key, { x: left - bounds.x * scale, y: feet });
    right = left - STAGE_ROW_GAP;
  }
  return placed;
}
