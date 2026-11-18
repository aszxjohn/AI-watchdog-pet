/**
 * overlay/canvas-input (AD-14, Story 3.6): the drawn actors' hit areas
 * take the mouse; hover requests go to main on `canvas:set-hover`; a
 * right-click opens no menu.
 */
import { describe, expect, it, vi } from 'vitest';
import { createCanvasInput } from '../../src/overlay/canvas-input';
import { hitTest, type HitArea, type Point } from '../../src/overlay/pointer';
import type { SessionKey } from '../../src/shared/detection-events';
import type { IpcResult } from '../../src/shared/ipc';
import type { OverlayApi } from '../../src/shared/preload-api';

/** An actor's hitbox × 大小 at its place: x 1380..1440, y 776..886. */
const ONE: HitArea<SessionKey> = {
  key: 'demo:1',
  x: 1380,
  y: 776,
  width: 60,
  height: 110,
};
/** Another one, overlapping ONE's left part: x 1350..1400. */
const TWO: HitArea<SessionKey> = {
  key: 'claude-code:two',
  x: 1350,
  y: 790,
  width: 50,
  height: 96,
};

const INSIDE: Point = { x: 1420, y: 800 };
const ALSO_INSIDE: Point = { x: 1430, y: 880 };
const OUTSIDE: Point = { x: 100, y: 100 };
const OVERLAP: Point = { x: 1390, y: 820 };

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
      async gpu() {
        return OK;
      },
    },
  };
  return { api, calls };
}

function setup(options: { reply?: IpcResult<null> } = {}) {
  const { api, calls } = fakeApi(options.reply);
  const logError = vi.fn<(message: string) => void>();
  const input = createCanvasInput({ api, logError });
  return { input, calls, logError };
}

function hover(seq: number, over: boolean) {
  return ['setHover', { seq, over }];
}

describe('I/O matrix', () => {
  it('滑鼠: moving onto an actor turns click-through off (over: true), moving within it sends nothing, moving off turns it back on', () => {
    const { input, calls } = setup();
    input.setAreas([ONE]);

    input.onMouseMove(OUTSIDE);
    expect(calls).toStrictEqual([]);
    input.onMouseMove(INSIDE);
    expect(calls).toStrictEqual([hover(1, true)]);
    input.onMouseMove(ALSO_INSIDE);
    expect(calls).toStrictEqual([hover(1, true)]);
    input.onMouseMove(OUTSIDE);
    expect(calls).toStrictEqual([hover(1, true), hover(2, false)]);
  });

  it('滑鼠: two actors overlap: the one drawn on top (last) is the one under the cursor; moving from one onto the other sends nothing', () => {
    const { input, calls } = setup();
    input.setAreas([ONE, TWO]);

    expect(hitTest(OVERLAP, [ONE, TWO])?.key).toBe(TWO.key);
    expect(hitTest(OVERLAP, [TWO, ONE])?.key).toBe(ONE.key);
    input.onMouseMove(OVERLAP);
    expect(calls).toStrictEqual([hover(1, true)]);
    input.onMouseMove(INSIDE);
    input.onMouseMove({ x: 1360, y: 880 });
    expect(calls).toStrictEqual([hover(1, true)]);
  });

  it('滑鼠: 右鍵 on an actor asks main for its menu (canvas:context-menu, the actor on top), says to preventDefault, and leaves click-through as it is (no menu opens yet)', () => {
    const { input, calls } = setup();
    input.setAreas([ONE, TWO]);
    input.onMouseMove(OVERLAP);

    expect(input.onContextMenu(OVERLAP)).toBe(true);
    expect(input.onContextMenu(INSIDE)).toBe(true);

    expect(calls).toStrictEqual([
      hover(1, true),
      ['contextMenu', TWO.key],
      ['contextMenu', ONE.key],
    ]);
  });

  it('滑鼠: 右鍵 anywhere else asks for nothing and says not to preventDefault', () => {
    const { input, calls } = setup();
    input.setAreas([ONE]);
    input.onMouseMove(OUTSIDE);

    expect(input.onContextMenu(OUTSIDE)).toBe(false);
    expect(calls).toStrictEqual([]);
  });

  it('加入與移出: the actor under a still cursor leaves: over: false with the next seq, and nothing takes the mouse there any more', () => {
    const { input, calls } = setup();
    input.setAreas([ONE]);
    input.onMouseMove(INSIDE);

    input.setAreas([]);

    expect(calls).toStrictEqual([hover(1, true), hover(2, false)]);
    input.onMouseMove(ALSO_INSIDE);
    expect(input.onContextMenu(INSIDE)).toBe(false);
    expect(calls).toStrictEqual([hover(1, true), hover(2, false)]);
  });

  it('示範方塊: nothing takes the mouse before the first drawn frame (no square, no demo-only area)', () => {
    const { input, calls } = setup();

    for (const point of [OUTSIDE, INSIDE, ALSO_INSIDE]) {
      input.onMouseMove(point);
      expect(input.onContextMenu(point)).toBe(false);
    }
    input.onMouseLeave();

    expect(calls).toStrictEqual([]);
  });
});

describe('createCanvasInput', () => {
  it('游標離開視窗 while over sends over: false', () => {
    const { input, calls } = setup();
    input.setAreas([ONE]);
    input.onMouseMove(INSIDE);

    input.onMouseLeave();

    expect(calls).toStrictEqual([hover(1, true), hover(2, false)]);
  });

  it('an area appearing under the last position seen waits for the next move', () => {
    const { input, calls } = setup();
    input.onMouseMove(INSIDE);

    input.setAreas([ONE]);
    expect(calls).toStrictEqual([]);

    input.onMouseMove(ALSO_INSIDE);
    expect(calls).toStrictEqual([hover(1, true)]);
  });

  it('the same areas again (every display frame) change nothing; a moved area is followed', () => {
    const { input, calls } = setup();
    input.setAreas([ONE]);
    input.onMouseMove(INSIDE);
    input.setAreas([{ ...ONE }]);
    expect(calls).toStrictEqual([hover(1, true)]);

    input.setAreas([{ ...ONE, x: 0 }]);
    expect(calls).toStrictEqual([hover(1, true), hover(2, false)]);
  });

  it('logs a rejected request', async () => {
    const { input, logError } = setup({ reply: REJECTED });
    input.setAreas([ONE]);

    input.onMouseMove(INSIDE);
    input.onContextMenu(INSIDE);
    input.onMouseMove(OUTSIDE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logError.mock.calls).toStrictEqual([
      ['[overlay] canvas:set-hover: sender-rejected: nope'],
      ['[overlay] canvas:context-menu: sender-rejected: nope'],
      ['[overlay] canvas:set-hover: sender-rejected: nope'],
    ]);
  });

  it('without a preload API it sends nothing but still says to preventDefault on an actor', () => {
    const input = createCanvasInput({ api: undefined });
    input.setAreas([ONE]);

    expect(() => {
      input.onMouseMove(INSIDE);
      input.onMouseLeave();
    }).not.toThrow();
    expect(input.onContextMenu(INSIDE)).toBe(true);
  });
});
