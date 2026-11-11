import { describe, expect, it, vi } from 'vitest';
import { createCanvasInput } from '../../src/overlay/canvas-input';
import type { DemoSquare } from '../../src/overlay/demo-square';
import type { Point } from '../../src/overlay/pointer';
import type { IpcResult } from '../../src/shared/ipc';
import type { OverlayApi } from '../../src/shared/preload-api';
import type {
  StageCanvas,
  StageSession,
  StageView,
} from '../../src/shared/stage-view';
import type { StateCode } from '../../src/shared/states';

const CANVAS: NonNullable<StageCanvas> = {
  displayId: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
  fallback: false,
};
const BIGGER: NonNullable<StageCanvas> = {
  ...CANVAS,
  displayId: 2,
  bounds: { x: 1512, y: -200, width: 2560, height: 1440 },
};

// The square on CANVAS covers x 1368..1488, y 766..886.
const INSIDE: Point = { x: 1400, y: 800 };
const ALSO_INSIDE: Point = { x: 1480, y: 880 };
const OUTSIDE: Point = { x: 100, y: 100 };
// On BIGGER it covers x 2416..2536, y 1224..1344.
const INSIDE_BIGGER: Point = { x: 2450, y: 1250 };

function demo(state: StateCode): StageSession {
  return {
    sessionKey: 'demo:1',
    source: 'demo',
    displayName: '示範',
    state,
    confidence: 'exact',
  };
}

function view(
  sessions: StageSession[],
  canvas: StageCanvas = CANVAS,
): Pick<StageView, 'canvas' | 'sessions'> {
  return { canvas, sessions };
}

const OK: IpcResult<null> = { ok: true, data: null };
const REJECTED: IpcResult<null> = {
  ok: false,
  error: { code: 'sender-rejected', message: 'nope' },
};

/** A fake overlay preload API that records the canvas requests, in order. */
function fakeApi(reply: IpcResult<null> = OK) {
  const calls: unknown[][] = [];
  const api: Pick<OverlayApi, 'canvas'> = {
    canvas: {
      async ready() {
        return OK;
      },
      async setHover(hover) {
        calls.push(['setHover', hover]);
        return reply;
      },
      async contextMenu(sessionKey) {
        calls.push(['contextMenu', sessionKey]);
        return reply;
      },
    },
  };
  return { api, calls };
}

/** A canvas input with a recording api and draw; `ready` makes it drawable. */
function setup(options: { ready?: boolean; reply?: IpcResult<null> } = {}) {
  const { api, calls } = fakeApi(options.reply);
  const drawn: (DemoSquare | null)[] = [];
  const logError = vi.fn<(message: string) => void>();
  const input = createCanvasInput({
    api,
    draw: (square) => {
      drawn.push(square);
    },
    logError,
  });
  if (options.ready ?? true) {
    input.onCanvasReady();
  }
  return { input, calls, drawn, logError };
}

function hover(seq: number, over: boolean) {
  return ['setHover', { seq, over }];
}

describe('createCanvasInput', () => {
  it('移到方塊上 / 移開: move in sends over: true, moving within sends nothing, move out sends over: false', () => {
    const { input, calls } = setup();
    input.onView(view([demo('approval')]));

    input.onMouseMove(OUTSIDE);
    expect(calls).toStrictEqual([]);
    input.onMouseMove(INSIDE);
    expect(calls).toStrictEqual([hover(1, true)]);
    input.onMouseMove(ALSO_INSIDE);
    expect(calls).toStrictEqual([hover(1, true)]);
    input.onMouseMove(OUTSIDE);
    expect(calls).toStrictEqual([hover(1, true), hover(2, false)]);
  });

  it('游標離開視窗 while over sends over: false', () => {
    const { input, calls } = setup();
    input.onView(view([demo('approval')]));
    input.onMouseMove(INSIDE);

    input.onMouseLeave();

    expect(calls).toStrictEqual([hover(1, true), hover(2, false)]);
  });

  it('出現 / 跟著變 / 消失: draws the square each time it changes, and nothing once demo mode is off', () => {
    const { input, drawn } = setup();

    input.onView(view([demo('approval')]));
    input.onView(view([demo('approval')]));
    input.onView(view([demo('done')]));
    input.onView(view([]));

    expect(
      drawn.map((square) => (square === null ? null : square.label)),
    ).toStrictEqual([null, '要你批准', '做完了', null]);
  });

  it('消失 under a still cursor: demo mode off sends over: false with the next seq', () => {
    const { input, calls } = setup();
    input.onView(view([demo('approval')]));
    input.onMouseMove(INSIDE);

    input.onView(view([]));

    expect(calls).toStrictEqual([hover(1, true), hover(2, false)]);
    // Nothing takes the mouse any more.
    input.onMouseMove(ALSO_INSIDE);
    expect(input.onContextMenu(INSIDE)).toBe(false);
    expect(calls).toStrictEqual([hover(1, true), hover(2, false)]);
  });

  it("右鍵 on the square asks for the demo session's menu, says to preventDefault, then counts as the cursor leaving", () => {
    const { input, calls } = setup();
    input.onView(view([demo('approval')]));
    input.onMouseMove(INSIDE);

    expect(input.onContextMenu(INSIDE)).toBe(true);

    expect(calls).toStrictEqual([
      hover(1, true),
      ['contextMenu', 'demo:1'],
      hover(2, false),
    ]);
    // Once the menu closes, the next move decides again.
    input.onMouseMove(ALSO_INSIDE);
    expect(calls.at(-1)).toStrictEqual(hover(3, true));
  });

  it('右鍵 on the square without a move before it: the menu request alone', () => {
    const { input, calls } = setup();
    input.onView(view([demo('approval')]));

    expect(input.onContextMenu(INSIDE)).toBe(true);

    expect(calls).toStrictEqual([['contextMenu', 'demo:1']]);
  });

  it('右鍵 anywhere else asks for nothing and says not to preventDefault', () => {
    const { input, calls } = setup();
    input.onView(view([demo('approval')]));
    input.onMouseMove(OUTSIDE);

    expect(input.onContextMenu(OUTSIDE)).toBe(false);
    expect(calls).toStrictEqual([]);
  });

  it('the hit area follows a world-size change: over: false where it was, over: true where it went', () => {
    const { input, calls } = setup();
    input.onView(view([demo('approval')]));
    input.onMouseMove(INSIDE);

    input.onView(view([demo('approval')], BIGGER));
    expect(calls).toStrictEqual([hover(1, true), hover(2, false)]);

    input.onMouseMove(ALSO_INSIDE);
    expect(input.onContextMenu(INSIDE)).toBe(false);
    expect(calls).toStrictEqual([hover(1, true), hover(2, false)]);

    input.onMouseMove(INSIDE_BIGGER);
    expect(calls.at(-1)).toStrictEqual(hover(3, true));
  });

  it('before the canvas has initialised, the square is not drawn and nothing takes the mouse', () => {
    const { input, calls, drawn } = setup({ ready: false });
    input.onView(view([demo('approval')]));

    input.onMouseMove(INSIDE);
    expect(input.onContextMenu(INSIDE)).toBe(false);
    expect(calls).toStrictEqual([]);
    expect(drawn).toStrictEqual([]);

    // Once it can draw: the latest square is drawn, and then it takes the mouse.
    input.onView(view([demo('error')]));
    input.onCanvasReady();
    expect(drawn.map((square) => square?.state)).toStrictEqual(['error']);
    expect(calls).toStrictEqual([]);
    input.onMouseMove(ALSO_INSIDE);
    expect(calls).toStrictEqual([hover(1, true)]);
  });

  it('a canvas that never initialises never takes the mouse', () => {
    const { input, calls, drawn } = setup({ ready: false });
    input.onView(view([demo('approval')]));

    for (const point of [OUTSIDE, INSIDE, ALSO_INSIDE]) {
      input.onMouseMove(point);
      expect(input.onContextMenu(point)).toBe(false);
    }
    input.onMouseLeave();

    expect(calls).toStrictEqual([]);
    expect(drawn).toStrictEqual([]);
  });

  it('logs a rejected request', async () => {
    const { input, logError } = setup({ reply: REJECTED });
    input.onView(view([demo('approval')]));

    input.onMouseMove(INSIDE);
    input.onContextMenu(INSIDE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logError.mock.calls).toStrictEqual([
      ['[overlay] canvas:set-hover: sender-rejected: nope'],
      ['[overlay] canvas:context-menu: sender-rejected: nope'],
      ['[overlay] canvas:set-hover: sender-rejected: nope'],
    ]);
  });

  it('without a preload API it sends nothing but still says to preventDefault on the square', () => {
    const drawn: (DemoSquare | null)[] = [];
    const input = createCanvasInput({
      api: undefined,
      draw: (square) => {
        drawn.push(square);
      },
    });
    input.onCanvasReady();
    input.onView(view([demo('approval')]));

    expect(() => {
      input.onMouseMove(INSIDE);
      input.onMouseLeave();
    }).not.toThrow();
    expect(input.onContextMenu(INSIDE)).toBe(true);
    expect(drawn).toHaveLength(2);
  });
});
