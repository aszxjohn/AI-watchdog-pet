/**
 * overlay/pointer (AD-14): which part of the canvas takes the mouse, and
 * when to tell main. Pure functions: no DOM, no PixiJS, so it is
 * unit-tested under Node; Epic 3's characters use it as it is.
 *
 * World coordinates are the canvas window's client coordinates (DIP, origin
 * top left). The areas that take the mouse are rectangles, each naming
 * what it is (a session key).
 *
 * The overlay owns click-through. Each step takes the pointer state and an
 * input (the cursor moved, left the window, or the areas changed under it)
 * and gives the next state and, only when the cursor goes from over no
 * area to over one or back, a request for main: `{ seq, over }`, with seq
 * 1, 2, 3, ... for this page load (main counts from 0 again when the page
 * reloads). Moving within an area, from one area to another, or outside
 * all of them sends nothing.
 *
 * When the areas change under a cursor that has not moved (the demo square
 * goes away, the world is resized), a cursor that was over an area and is
 * no longer answers `over: false`. The reverse waits for the next move: an
 * area appearing under the last position seen does not turn click-through
 * off, because that position may be stale (forwarded moves stop at the
 * window's edge), and a stale "over" would block clicks to the windows
 * below.
 */
import type { CanvasHover } from '../shared/ipc';

/** A cursor position in world coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A rectangle that takes the mouse, in world coordinates, named by `key`.
 * The left and top edges are inside it, the right and bottom edges not.
 */
export interface HitArea<K> {
  readonly key: K;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PointerState {
  /** The seq of the last request sent; 0 before the first. */
  readonly seq: number;
  /** Whether the last request sent said `over`. */
  readonly over: boolean;
  /** The last cursor position seen in the window; null once it left. */
  readonly at: Point | null;
}

/**
 * What one step gives: the next state, and the request to send main on
 * `canvas:set-hover`, if any.
 */
export interface PointerStep {
  readonly state: PointerState;
  readonly request: CanvasHover | null;
}

/** A page load's start: nothing sent, the cursor not seen. */
export const POINTER_START: PointerState = Object.freeze({
  seq: 0,
  over: false,
  at: null,
});

function contains<K>(area: HitArea<K>, point: Point): boolean {
  return (
    point.x >= area.x &&
    point.x < area.x + area.width &&
    point.y >= area.y &&
    point.y < area.y + area.height
  );
}

/**
 * The area under `point`, or undefined. Areas later in the list are drawn
 * on top, so the last one that contains it wins.
 */
export function hitTest<K>(
  point: Point,
  areas: readonly HitArea<K>[],
): HitArea<K> | undefined {
  for (let index = areas.length - 1; index >= 0; index -= 1) {
    const area = areas[index];
    if (area !== undefined && contains(area, point)) {
      return area;
    }
  }
  return undefined;
}

/** `state` at `at`, over or not; a request only when `over` changes. */
function step(
  state: PointerState,
  at: Point | null,
  over: boolean,
): PointerStep {
  if (over === state.over) {
    return { state: { ...state, at }, request: null };
  }
  const seq = state.seq + 1;
  return { state: { seq, over, at }, request: { seq, over } };
}

/** The cursor moved to `point` while `areas` take the mouse. */
export function pointerMoved<K>(
  state: PointerState,
  point: Point,
  areas: readonly HitArea<K>[],
): PointerStep {
  return step(state, point, hitTest(point, areas) !== undefined);
}

/** The cursor left the window: it is over nothing. */
export function pointerLeft(state: PointerState): PointerStep {
  return step(state, null, false);
}

/**
 * The areas changed while the cursor stayed where it was last seen. Only a
 * cursor that was over an area and no longer is gets a request
 * (`over: false`); see the file comment for why the reverse waits.
 */
export function areasChanged<K>(
  state: PointerState,
  areas: readonly HitArea<K>[],
): PointerStep {
  if (
    !state.over ||
    (state.at !== null && hitTest(state.at, areas) !== undefined)
  ) {
    return { state, request: null };
  }
  return step(state, state.at, false);
}
