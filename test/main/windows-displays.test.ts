import { describe, expect, it } from 'vitest';
import {
  describePlacement,
  resolveCanvasPlacement,
  toStageDisplays,
  type ScreenDisplay,
} from '../../src/main/windows/displays';
import {
  DISPLAY_LABEL_MAX_LENGTH,
  stageCanvasSchema,
  stageDisplaysSchema,
} from '../../src/shared/stage-view';

/** What Electron's screen.getAllDisplays() gives, trimmed to what is read. */
const BUILT_IN: ScreenDisplay = {
  id: 1,
  label: 'Built-in Retina Display',
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
};
const EXTERNAL: ScreenDisplay = {
  id: 69733632,
  label: 'DELL U2720Q',
  bounds: { x: 1512, y: -200, width: 2560, height: 1440 },
  scaleFactor: 1.5,
};

describe('toStageDisplays', () => {
  it('lists every display in order, marking the primary one', () => {
    const displays = toStageDisplays([BUILT_IN, EXTERNAL], BUILT_IN.id);

    expect(displays).toStrictEqual([
      { ...BUILT_IN, primary: true },
      { ...EXTERNAL, primary: false },
    ]);
    expect(stageDisplaysSchema.safeParse(displays).success).toBe(true);
  });

  it('follows the primary display when it changes', () => {
    expect(
      toStageDisplays([BUILT_IN, EXTERNAL], EXTERNAL.id).map((d) => d.primary),
    ).toStrictEqual([false, true]);
  });

  it('copies only the fields StageView carries', () => {
    const electronDisplay = {
      ...BUILT_IN,
      workArea: { x: 0, y: 25, width: 1512, height: 957 },
      internal: true,
      rotation: 0,
    };

    expect(
      Object.keys(toStageDisplays([electronDisplay], 1)[0] ?? {}),
    ).toStrictEqual(['id', 'label', 'bounds', 'scaleFactor', 'primary']);
  });

  it('keeps an unnamed display, rounds its bounds and fixes a bad scale factor', () => {
    const [display] = toStageDisplays(
      [
        {
          id: 7,
          label: '',
          bounds: { x: -0.4, y: 10.6, width: 1919.5, height: 0.2 },
          scaleFactor: 0,
        },
      ],
      7,
    );

    expect(display).toStrictEqual({
      id: 7,
      label: '',
      bounds: { x: 0, y: 11, width: 1920, height: 1 },
      scaleFactor: 1,
      primary: true,
    });
    expect(stageDisplaysSchema.safeParse([display]).success).toBe(true);
  });

  it('cuts a label that is too long', () => {
    const [display] = toStageDisplays(
      [{ ...BUILT_IN, label: 'x'.repeat(DISPLAY_LABEL_MAX_LENGTH + 50) }],
      1,
    );

    expect(display?.label).toHaveLength(DISPLAY_LABEL_MAX_LENGTH);
  });

  it.each([
    ['negative', -5],
    ['fractional', 1.5],
    ['past the safe integers', 2 ** 60],
  ])('leaves out a display whose id is %s', (_label, id) => {
    const displays = toStageDisplays([{ ...EXTERNAL, id }, BUILT_IN], 1);

    expect(displays.map((d) => d.id)).toStrictEqual([1]);
    expect(stageDisplaysSchema.safeParse(displays).success).toBe(true);
  });
});

describe('resolveCanvasPlacement', () => {
  const displays = toStageDisplays([BUILT_IN, EXTERNAL], BUILT_IN.id);

  it('puts the canvas on the primary display when the setting is null', () => {
    expect(resolveCanvasPlacement(null, displays)).toStrictEqual({
      displayId: 1,
      bounds: BUILT_IN.bounds,
      scaleFactor: 2,
      fallback: false,
    });
  });

  it('puts it on the chosen display when that is connected', () => {
    expect(resolveCanvasPlacement(EXTERNAL.id, displays)).toStrictEqual({
      displayId: EXTERNAL.id,
      bounds: EXTERNAL.bounds,
      scaleFactor: 1.5,
      fallback: false,
    });
  });

  it('falls back to the primary display while the chosen one is unplugged, and moves back once it returns', () => {
    const unplugged = toStageDisplays([BUILT_IN], BUILT_IN.id);

    expect(resolveCanvasPlacement(EXTERNAL.id, unplugged)).toStrictEqual({
      displayId: 1,
      bounds: BUILT_IN.bounds,
      scaleFactor: 2,
      fallback: true,
    });
    expect(resolveCanvasPlacement(EXTERNAL.id, displays)).toMatchObject({
      displayId: EXTERNAL.id,
      fallback: false,
    });
  });

  it('follows a new primary display when the setting is null', () => {
    const swapped = toStageDisplays([BUILT_IN, EXTERNAL], EXTERNAL.id);

    expect(resolveCanvasPlacement(null, swapped)?.displayId).toBe(EXTERNAL.id);
  });

  it('uses the first display when none is marked primary', () => {
    const noPrimary = toStageDisplays([EXTERNAL, BUILT_IN], 999);

    expect(resolveCanvasPlacement(null, noPrimary)?.displayId).toBe(
      EXTERNAL.id,
    );
    expect(resolveCanvasPlacement(5, noPrimary)).toMatchObject({
      displayId: EXTERNAL.id,
      fallback: true,
    });
  });

  it('is null when there is no display', () => {
    expect(resolveCanvasPlacement(null, [])).toBeNull();
    expect(resolveCanvasPlacement(1, [])).toBeNull();
  });

  it('always answers a valid StageView canvas section, never sharing bounds', () => {
    for (const wanted of [null, 1, EXTERNAL.id, 42]) {
      const placement = resolveCanvasPlacement(wanted, displays);
      expect(stageCanvasSchema.safeParse(placement).success).toBe(true);
      expect(placement?.bounds).not.toBe(
        displays.find((d) => d.id === placement?.displayId)?.bounds,
      );
    }
  });
});

describe('describePlacement', () => {
  it('names the display, size, position and scale', () => {
    expect(
      describePlacement({
        displayId: 5,
        bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1.25,
        fallback: false,
      }),
    ).toBe('display 5, 1920x1080 at -1920,0, scale 1.25');
  });
});
