import { describe, expect, it } from 'vitest';
import {
  DEMO_SQUARE_COLORS,
  DEMO_SQUARE_DARK_TEXT,
  DEMO_SQUARE_BOTTOM_MARGIN,
  DEMO_SQUARE_LIGHT_TEXT,
  DEMO_SQUARE_RIGHT_MARGIN,
  DEMO_SQUARE_SIZE,
  demoSquare,
  demoSquareAreas,
} from '../../src/overlay/demo-square';
import {
  areasChanged,
  pointerMoved,
  POINTER_START,
} from '../../src/overlay/pointer';
import type {
  StageCanvas,
  StageSession,
  StageView,
} from '../../src/shared/stage-view';
import {
  STATE_CODES,
  STATE_DISPLAY_NAMES,
  type StateCode,
} from '../../src/shared/states';

const CANVAS: NonNullable<StageCanvas> = {
  displayId: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
  fallback: false,
};

function demo(state: StateCode): StageSession {
  return {
    sessionKey: 'demo:1',
    source: 'demo',
    displayName: '示範',
    state,
    confidence: 'exact',
  };
}

const CODEX: StageSession = {
  sessionKey: 'codex:s1',
  source: 'codex',
  displayName: 'proj',
  state: 'working',
  confidence: 'exact',
};

function view(
  sessions: StageSession[],
  canvas: StageCanvas = CANVAS,
): Pick<StageView, 'canvas' | 'sessions'> {
  return { canvas, sessions };
}

describe('demoSquare', () => {
  it('出現: demo mode on in 要你批准 puts an approval-coloured square 24 DIP from the right and 96 DIP above the bottom, labelled 要你批准', () => {
    expect(demoSquare(view([demo('approval')]))).toStrictEqual({
      sessionKey: 'demo:1',
      state: 'approval',
      x: 1512 - 24 - 120,
      y: 982 - 96 - 120,
      size: 120,
      fill: '#ff6d00',
      textColor: '#212121',
      label: '要你批准',
    });
    expect(DEMO_SQUARE_SIZE).toBe(120);
    expect(DEMO_SQUARE_RIGHT_MARGIN).toBe(24);
    expect(DEMO_SQUARE_BOTTOM_MARGIN).toBe(96);
  });

  it('stays clear of a 48 DIP Windows taskbar along the bottom', () => {
    const square = demoSquare(view([demo('working')]));
    expect((square?.y ?? 0) + (square?.size ?? 0)).toBeLessThanOrEqual(
      982 - 48,
    );
  });

  it('跟著變: 做完了 changes the colour and the label, not the place', () => {
    const before = demoSquare(view([demo('approval')]));
    const after = demoSquare(view([demo('done')]));
    expect(after).toMatchObject({ fill: '#00c853', label: '做完了' });
    expect([after?.x, after?.y, after?.size]).toStrictEqual([
      before?.x,
      before?.y,
      before?.size,
    ]);
  });

  it('消失: nothing to draw once demo mode is off (no demo session)', () => {
    expect(demoSquare(view([]))).toBeNull();
    expect(demoSquare(view([CODEX]))).toBeNull();
  });

  it('nothing to draw before main has placed the canvas', () => {
    expect(demoSquare(view([demo('approval')], null))).toBeNull();
  });

  it('finds the demo session among others, by source', () => {
    expect(demoSquare(view([CODEX, demo('error')]))?.sessionKey).toBe('demo:1');
  });

  it.each(STATE_CODES)(
    '%s: the colour from the design notes and its Chinese name',
    (state) => {
      const square = demoSquare(view([demo(state)]));
      expect(square?.fill).toBe(DEMO_SQUARE_COLORS[state]);
      expect(square?.label).toBe(STATE_DISPLAY_NAMES[state]);
      expect(square?.textColor).toBe(
        ['approval', 'decision', 'done', 'waiting'].includes(state)
          ? DEMO_SQUARE_DARK_TEXT
          : DEMO_SQUARE_LIGHT_TEXT,
      );
    },
  );

  it('dark text on the light fills (approval, decision, done, waiting), white on the rest', () => {
    const colours = Object.fromEntries(
      STATE_CODES.map((state) => [
        state,
        demoSquare(view([demo(state)]))?.textColor,
      ]),
    );
    expect(colours).toStrictEqual({
      waiting: '#212121',
      thinking: '#ffffff',
      working: '#ffffff',
      approval: '#212121',
      decision: '#212121',
      done: '#212121',
      idle: '#ffffff',
      error: '#ffffff',
    });
  });

  it('has one distinct colour per state, as listed in the design notes', () => {
    expect(DEMO_SQUARE_COLORS).toStrictEqual({
      thinking: '#7c4dff',
      working: '#2979ff',
      approval: '#ff6d00',
      decision: '#ffd600',
      error: '#d50000',
      done: '#00c853',
      waiting: '#b0bec5',
      idle: '#546e7a',
    });
    expect(DEMO_SQUARE_LIGHT_TEXT).toBe('#ffffff');
  });

  it('follows the world size (another display)', () => {
    const square = demoSquare(
      view([demo('thinking')], {
        ...CANVAS,
        bounds: { x: 1512, y: -200, width: 2560, height: 1440 },
      }),
    );
    expect([square?.x, square?.y]).toStrictEqual([2560 - 144, 1440 - 216]);
  });

  it('a world too small for the margins keeps it on screen at the top-left edge', () => {
    const square = demoSquare(
      view([demo('idle')], {
        ...CANVAS,
        bounds: { x: 0, y: 0, width: 100, height: 130 },
      }),
    );
    expect([square?.x, square?.y]).toStrictEqual([0, 0]);
  });
});

describe('demoSquareAreas', () => {
  it('is the square, named by its session key; nothing without a square', () => {
    const square = demoSquare(view([demo('approval')]));
    expect(demoSquareAreas(square)).toStrictEqual([
      { key: 'demo:1', x: 1368, y: 766, width: 120, height: 120 },
    ]);
    expect(demoSquareAreas(null)).toStrictEqual([]);
  });

  it('消失 under the cursor: the areas going with the square send over: false', () => {
    const on = demoSquareAreas(demoSquare(view([demo('approval')])));
    const moved = pointerMoved(POINTER_START, { x: 1400, y: 800 }, on);
    expect(moved.request).toStrictEqual({ seq: 1, over: true });

    const off = demoSquareAreas(demoSquare(view([])));
    expect(areasChanged(moved.state, off).request).toStrictEqual({
      seq: 2,
      over: false,
    });
  });
});
