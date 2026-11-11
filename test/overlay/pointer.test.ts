import { describe, expect, it } from 'vitest';
import {
  areasChanged,
  hitTest,
  POINTER_START,
  pointerLeft,
  pointerMoved,
  type HitArea,
  type Point,
  type PointerState,
  type PointerStep,
} from '../../src/overlay/pointer';
import type { CanvasHover as HoverRequest } from '../../src/shared/ipc';

/** A 120x120 area, like the demo square's. */
const SQUARE: HitArea<string> = {
  key: 'demo:1',
  x: 1368,
  y: 838,
  width: 120,
  height: 120,
};
const AREAS = [SQUARE];
const INSIDE: Point = { x: 1400, y: 900 };
const ALSO_INSIDE: Point = { x: 1480, y: 950 };
const OUTSIDE: Point = { x: 100, y: 100 };
const ALSO_OUTSIDE: Point = { x: 1367, y: 900 };

type Input =
  | { readonly move: Point; readonly areas?: readonly HitArea<string>[] }
  | { readonly leave: true }
  | { readonly areas: readonly HitArea<string>[] };

/** Runs `inputs` from the start of a page load; the requests each one gave. */
function run(...inputs: Input[]): {
  readonly state: PointerState;
  readonly requests: (HoverRequest | null)[];
} {
  let state = POINTER_START;
  const requests: (HoverRequest | null)[] = [];
  for (const input of inputs) {
    let result: PointerStep;
    if ('move' in input) {
      result = pointerMoved(state, input.move, input.areas ?? AREAS);
    } else if ('leave' in input) {
      result = pointerLeft(state);
    } else {
      result = areasChanged(state, input.areas);
    }
    state = result.state;
    requests.push(result.request);
  }
  return { state, requests };
}

describe('hitTest', () => {
  it('finds the area under the point; the left and top edges are inside, the right and bottom edges not', () => {
    expect(hitTest(INSIDE, AREAS)).toBe(SQUARE);
    expect(hitTest({ x: 1368, y: 838 }, AREAS)).toBe(SQUARE);
    expect(hitTest({ x: 1487.9, y: 957.9 }, AREAS)).toBe(SQUARE);
    expect(hitTest({ x: 1488, y: 900 }, AREAS)).toBeUndefined();
    expect(hitTest({ x: 1400, y: 958 }, AREAS)).toBeUndefined();
    expect(hitTest({ x: 1367.9, y: 900 }, AREAS)).toBeUndefined();
    expect(hitTest({ x: 1400, y: 837.9 }, AREAS)).toBeUndefined();
  });

  it('finds nothing when no area takes the mouse', () => {
    expect(hitTest(INSIDE, [])).toBeUndefined();
  });

  it('picks the last area listed (drawn on top) where areas overlap', () => {
    const below: HitArea<string> = {
      key: 'a',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
    };
    const above: HitArea<string> = {
      key: 'b',
      x: 25,
      y: 25,
      width: 50,
      height: 50,
    };
    expect(hitTest({ x: 30, y: 30 }, [below, above])?.key).toBe('b');
    expect(hitTest({ x: 10, y: 10 }, [below, above])?.key).toBe('a');
    expect(hitTest({ x: 70, y: 70 }, [below, above])?.key).toBe('b');
  });
});

describe('the hover state machine', () => {
  it('starts with nothing sent and the cursor not seen', () => {
    expect(POINTER_START).toStrictEqual({ seq: 0, over: false, at: null });
  });

  it('移到方塊上: moving in from outside sends over: true once, seq 1', () => {
    const { requests, state } = run({ move: OUTSIDE }, { move: INSIDE });
    expect(requests).toStrictEqual([null, { seq: 1, over: true }]);
    expect(state).toStrictEqual({ seq: 1, over: true, at: INSIDE });
  });

  it('移開: moving out sends over: false once; moving within or outside sends nothing', () => {
    const { requests } = run(
      { move: INSIDE },
      { move: ALSO_INSIDE },
      { move: INSIDE },
      { move: OUTSIDE },
      { move: ALSO_OUTSIDE },
      { move: OUTSIDE },
    );
    expect(requests).toStrictEqual([
      { seq: 1, over: true },
      null,
      null,
      { seq: 2, over: false },
      null,
      null,
    ]);
  });

  it('counts seq up by one per request, across many crossings', () => {
    const inputs: Input[] = [];
    for (let crossing = 0; crossing < 5; crossing += 1) {
      inputs.push({ move: INSIDE }, { move: OUTSIDE });
    }
    const { requests } = run(...inputs);
    expect(requests).toStrictEqual(
      Array.from({ length: 10 }, (_, index) => ({
        seq: index + 1,
        over: index % 2 === 0,
      })),
    );
  });

  it('moving from one area straight onto another sends nothing', () => {
    const other: HitArea<string> = { ...SQUARE, key: 'demo:2', x: 1248 };
    const { requests } = run(
      { move: INSIDE, areas: [other, SQUARE] },
      { move: { x: 1300, y: 900 }, areas: [other, SQUARE] },
    );
    expect(requests).toStrictEqual([{ seq: 1, over: true }, null]);
  });

  it('游標離開視窗: leaving while over sends over: false; leaving while not over sends nothing', () => {
    expect(run({ move: INSIDE }, { leave: true }).requests).toStrictEqual([
      { seq: 1, over: true },
      { seq: 2, over: false },
    ]);
    expect(run({ move: OUTSIDE }, { leave: true }).requests).toStrictEqual([
      null,
      null,
    ]);
    expect(run({ leave: true }).requests).toStrictEqual([null]);
  });

  it('forgets the position once the cursor left the window', () => {
    expect(run({ move: INSIDE }, { leave: true }).state).toStrictEqual({
      seq: 2,
      over: false,
      at: null,
    });
  });

  it('消失: the square going away under the cursor sends over: false', () => {
    const { requests, state } = run({ move: INSIDE }, { areas: [] });
    expect(requests).toStrictEqual([
      { seq: 1, over: true },
      { seq: 2, over: false },
    ]);
    expect(state).toStrictEqual({ seq: 2, over: false, at: INSIDE });
  });

  it('the square moving away from under the cursor (the world resized) sends over: false', () => {
    const moved = { ...SQUARE, x: 200, y: 200 };
    expect(run({ move: INSIDE }, { areas: [moved] }).requests).toStrictEqual([
      { seq: 1, over: true },
      { seq: 2, over: false },
    ]);
  });

  it('areas changing while the cursor stays over one sends nothing', () => {
    const bigger = { ...SQUARE, width: 200 };
    expect(run({ move: INSIDE }, { areas: [bigger] }).requests).toStrictEqual([
      { seq: 1, over: true },
      null,
    ]);
  });

  it('出現 under a still cursor waits for the next move: a stale position never blocks clicks', () => {
    const { requests } = run(
      { move: INSIDE, areas: [] },
      { areas: AREAS },
      { move: ALSO_INSIDE },
    );
    expect(requests).toStrictEqual([null, null, { seq: 1, over: true }]);
  });

  it('areas changing while the cursor is outside the window sends nothing', () => {
    const { requests } = run(
      { move: INSIDE },
      { leave: true },
      { areas: [] },
      { areas: AREAS },
    );
    expect(requests).toStrictEqual([
      { seq: 1, over: true },
      { seq: 2, over: false },
      null,
      null,
    ]);
  });

  it('does not change the state it is given', () => {
    const before: PointerState = { seq: 3, over: false, at: OUTSIDE };
    const copy = structuredClone(before);
    pointerMoved(before, INSIDE, AREAS);
    pointerLeft(before);
    areasChanged(before, []);
    expect(before).toStrictEqual(copy);
  });
});
