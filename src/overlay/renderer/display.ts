/**
 * overlay/renderer (Story 3.6): what main.ts sets on PixiJS's application
 * for the display, as small functions over the parts it touches, so they
 * are unit-tested under Node with fakes.
 *
 * - The render loop draws at most TICK_HZ frames a second: a pack's draw
 *   changes at most once a tick, so a faster display would only redraw the
 *   same picture.
 * - The canvas draws at its display's `scaleFactor` (StageView `canvas`):
 *   moved to a display of another scale, it stays sharp and the same size
 *   in DIP. Until the canvas is placed, the resolution stays as it is.
 */
import { TICK_HZ } from '../../shared/constants';
import type { StageCanvas } from '../../shared/stage-view';
import { canvasResolution } from '../world/world';

/** The part of PixiJS's Ticker the cap sets. */
export interface FrameRateTicker {
  maxFPS: number;
}

/** Caps `ticker` (the render loop) at TICK_HZ frames a second. */
export function capFrameRate(ticker: FrameRateTicker): void {
  ticker.maxFPS = TICK_HZ;
}

/** The parts of PixiJS's renderer the resolution step uses. */
export interface ResolutionRenderer {
  readonly resolution: number;
  resize(width: number, height: number, resolution: number): void;
}

/**
 * Sets `renderer`'s resolution to `canvas`'s scaleFactor, keeping the
 * screen's size (`screen`, DIP); nothing when the canvas is not placed or
 * the resolution is that already. Returns the resolution it draws at now.
 */
export function followResolution(
  renderer: ResolutionRenderer,
  canvas: StageCanvas,
  screen: { readonly width: number; readonly height: number },
): number {
  const resolution = canvasResolution(canvas, renderer.resolution);
  if (resolution !== renderer.resolution) {
    renderer.resize(screen.width, screen.height, resolution);
  }
  return resolution;
}
