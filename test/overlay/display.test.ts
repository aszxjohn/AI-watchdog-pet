/**
 * overlay/renderer/display (Story 3.6): the render loop's frame-rate cap
 * and the resolution step main.ts takes at each StageView, with fakes (and
 * PixiJS's own Ticker for the cap).
 */
import { Ticker } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  capFrameRate,
  followResolution,
  type ResolutionRenderer,
} from '../../src/overlay/renderer/display';
import { TICK_HZ } from '../../src/shared/constants';
import type { StageCanvas } from '../../src/shared/stage-view';

function canvas(scaleFactor: number): StageCanvas {
  return {
    displayId: 2,
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    scaleFactor,
    fallback: false,
  };
}

/** A fake renderer at `resolution` that records its resizes. */
function renderer(resolution: number) {
  const resizes: number[][] = [];
  const fake: ResolutionRenderer = {
    resolution,
    resize(width, height, next) {
      resizes.push([width, height, next]);
    },
  };
  return { fake, resizes };
}

const SCREEN = { width: 1512, height: 982 };

describe('I/O matrix', () => {
  it('換螢幕: a canvas moved to a display of scaleFactor 2 from one of 1: the renderer is resized to resolution 2 at the same DIP size', () => {
    const { fake, resizes } = renderer(1);

    expect(followResolution(fake, canvas(2), SCREEN)).toBe(2);
    expect(resizes).toStrictEqual([[1512, 982, 2]]);
  });

  it('換螢幕: the same scaleFactor, or no canvas placed yet: nothing is resized', () => {
    const same = renderer(2);
    expect(followResolution(same.fake, canvas(2), SCREEN)).toBe(2);
    expect(same.resizes).toStrictEqual([]);

    const unplaced = renderer(1.5);
    expect(followResolution(unplaced.fake, null, SCREEN)).toBe(1.5);
    expect(unplaced.resizes).toStrictEqual([]);
  });
});

describe('capFrameRate', () => {
  it(`caps the render loop at ${TICK_HZ} frames a second`, () => {
    const fake = { maxFPS: 0 };
    capFrameRate(fake);
    expect(fake.maxFPS).toBe(TICK_HZ);

    const ticker = new Ticker();
    capFrameRate(ticker);
    expect(ticker.maxFPS).toBe(TICK_HZ);
    ticker.destroy();
  });
});
