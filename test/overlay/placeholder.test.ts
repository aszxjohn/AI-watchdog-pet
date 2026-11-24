/**
 * overlay/renderer/placeholder (Story 3.7): the stage's own placeholder,
 * as numbers: the figure filling a character's hitbox, and its opacity by
 * the render loop's time.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_ALPHA_MAX,
  PLACEHOLDER_ALPHA_MIN,
  PLACEHOLDER_COLOR,
  PLACEHOLDER_PERIOD_MS,
  placeholderAlpha,
  placeholderShape,
  type PlaceholderShape,
} from '../../src/overlay/renderer/placeholder';
import type { LocalBox } from '../../src/shared/pack-api';

/** The contract pack's probe-one's hitbox. */
const PROBE_ONE_HITBOX: LocalBox = { x: -30, y: -110, width: 60, height: 110 };

/** The smallest box holding `shape`, as [x, y, width, height]. */
function extentOf({ head, body }: PlaceholderShape): number[] {
  const left = Math.min(head.x - head.radius, body.x);
  const top = Math.min(head.y - head.radius, body.y);
  const right = Math.max(head.x + head.radius, body.x + body.width);
  const bottom = Math.max(head.y + head.radius, body.y + body.height);
  return [left, top, right - left, bottom - top];
}

describe('I/O matrix', () => {
  it('佔位: the figure fills the hitbox: a round head at its top in the middle, and under it a body with round corners, its whole width, down to its bottom', () => {
    const shape = placeholderShape(PROBE_ONE_HITBOX);
    const { head, body } = shape;

    expect(extentOf(shape)).toStrictEqual([-30, -110, 60, 110]);
    expect(head.x).toBe(0);
    expect(head.y - head.radius).toBe(-110);
    expect(head.radius).toBeGreaterThan(0);
    expect([body.x, body.width]).toStrictEqual([-30, 60]);
    expect(body.y + body.height).toBeCloseTo(0);
    // A neck: the head stands clear of the body.
    expect(body.y).toBeGreaterThan(head.y + head.radius);
    // Round corners, no rounder than its shorter side allows.
    expect(body.radius).toBeGreaterThan(0);
    expect(body.radius).toBeLessThanOrEqual(
      Math.min(body.width, body.height) / 2,
    );
    // The body is the bigger part, as a figure's is.
    expect(body.height).toBeGreaterThan(head.radius * 2);
  });

  it.each<[string, LocalBox]>([
    ['probe-two’s', { x: -25, y: -96, width: 50, height: 96 }],
    ['a wide', { x: -100, y: -40, width: 200, height: 40 }],
    ['a tall', { x: -5, y: -300, width: 10, height: 300 }],
    ['a tiny', { x: 3, y: 4, width: 0.5, height: 0.25 }],
    ['an off-centre', { x: 12, y: -20, width: 30, height: 70 }],
  ])(
    '佔位: for %s hitbox the figure stays inside it, top to bottom and its whole width, its parts do not overlap and each has a size',
    (_label, hitbox) => {
      const shape = placeholderShape(hitbox);
      const { head, body } = shape;
      const [x, y, width, height] = extentOf(shape);

      expect(x).toBeCloseTo(hitbox.x);
      expect(width).toBeCloseTo(hitbox.width);
      expect(y).toBeCloseTo(hitbox.y);
      expect(height).toBeCloseTo(hitbox.height);
      expect(head.x).toBeCloseTo(hitbox.x + hitbox.width / 2);
      expect(head.radius).toBeGreaterThan(0);
      expect(head.radius * 2).toBeLessThanOrEqual(hitbox.width);
      expect(body.height).toBeGreaterThan(0);
      expect(body.y).toBeGreaterThan(head.y + head.radius);
      expect(body.radius).toBeGreaterThan(0);
      expect(body.radius).toBeLessThanOrEqual(
        Math.min(body.width, body.height) / 2,
      );
    },
  );

  it('佔位: a half-clear grey, the same for every state (nothing of a state goes in)', () => {
    const red = (PLACEHOLDER_COLOR >> 16) & 0xff;
    const green = (PLACEHOLDER_COLOR >> 8) & 0xff;
    const blue = PLACEHOLDER_COLOR & 0xff;
    expect(new Set([red, green, blue]).size).toBe(1);
    expect(red).toBeGreaterThan(0x40);
    expect(red).toBeLessThan(0xc0);
    expect(PLACEHOLDER_ALPHA_MIN).toBeGreaterThan(0);
    expect(PLACEHOLDER_ALPHA_MAX).toBeGreaterThan(PLACEHOLDER_ALPHA_MIN);
    expect(PLACEHOLDER_ALPHA_MAX).toBeLessThan(1);
    // placeholderShape takes the hitbox only, placeholderAlpha the time only.
    expect(placeholderShape.length).toBe(1);
    expect(placeholderAlpha.length).toBe(1);
  });

  it('佔位: its opacity rises and falls once about every 2 seconds: full at 0 and each period after, faintest half way, smoothly between, never outside its range', () => {
    expect(PLACEHOLDER_PERIOD_MS).toBe(2000);
    expect(placeholderAlpha(0)).toBeCloseTo(PLACEHOLDER_ALPHA_MAX);
    expect(placeholderAlpha(PLACEHOLDER_PERIOD_MS / 2)).toBeCloseTo(
      PLACEHOLDER_ALPHA_MIN,
    );
    expect(placeholderAlpha(PLACEHOLDER_PERIOD_MS)).toBeCloseTo(
      PLACEHOLDER_ALPHA_MAX,
    );
    expect(placeholderAlpha(PLACEHOLDER_PERIOD_MS * 7.5)).toBeCloseTo(
      PLACEHOLDER_ALPHA_MIN,
    );
    const middle = (PLACEHOLDER_ALPHA_MIN + PLACEHOLDER_ALPHA_MAX) / 2;
    expect(placeholderAlpha(PLACEHOLDER_PERIOD_MS / 4)).toBeCloseTo(middle);
    let before = placeholderAlpha(0);
    for (let time = 10; time <= PLACEHOLDER_PERIOD_MS * 2; time += 10) {
      const alpha = placeholderAlpha(time);
      expect(alpha).toBeGreaterThanOrEqual(PLACEHOLDER_ALPHA_MIN - 1e-9);
      expect(alpha).toBeLessThanOrEqual(PLACEHOLDER_ALPHA_MAX + 1e-9);
      // Smooth: 10 ms never moves it by more than a hundredth.
      expect(Math.abs(alpha - before)).toBeLessThan(0.01);
      before = alpha;
    }
  });

  it('佔位: a time that is not a number counts as 0', () => {
    for (const time of [Number.NaN, Infinity, -Infinity]) {
      expect(placeholderAlpha(time)).toBe(placeholderAlpha(0));
    }
  });

  it('佔位: it is plain numbers: the module imports no PixiJS and loads nothing', () => {
    const source = readFileSync(
      new URL('../../src/overlay/renderer/placeholder.ts', import.meta.url),
      'utf8',
    );
    const imports = [
      ...source.matchAll(/^import[\s\S]*?from '([^']+)';$/gm),
    ].map((match) => match[1]);
    expect(imports).toStrictEqual(['../../shared/pack-api']);
  });
});
