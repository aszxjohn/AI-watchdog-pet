import { describe, expect, it } from 'vitest';
import {
  bitmapCommandSchema,
  DRAW_COMMAND_TYPES,
  drawCommandSchema,
  drawMessageSchema,
  EMITTER_ID_MAX_LENGTH,
  particlesCommandSchema,
  SPRITE_COMMAND_DEFAULTS,
  spriteCommandSchema,
} from '../../../src/shared/pack-api';
import { expectRejected, expectRoundTrip } from '../schema-helpers';
import { expectRuleIssue } from './issues';
import { changed, removed, withProtoKey } from './samples';

const SPRITE = { type: 'sprite', asset: 'body-dots', x: 0, y: 0 };

const FULL_SPRITE = {
  type: 'sprite',
  asset: 'sheet',
  frame: 'walk-03',
  x: -12.5,
  y: -3,
  rotation: -Math.PI / 6,
  scaleX: -1,
  scaleY: 1.25,
  alpha: 0.4,
  z: -2,
};

const PARTICLES = {
  type: 'particles',
  emitterId: 'trail',
  preset: 'sparkle',
  x: 4,
  y: -60,
  params: { count: 12, startColor: '#ffcc00', loop: true },
};

/**
 * In Node there is no ImageBitmap; any object stands in for one, which is
 * why the schema only asks for an object.
 */
const BITMAP = {
  type: 'bitmap',
  image: {},
  x: -40,
  y: -100,
  width: 80,
  height: 100,
};

const DRAW = {
  type: 'draw',
  seq: 42,
  actors: {
    a1: [FULL_SPRITE, PARTICLES],
    a3: [SPRITE, BITMAP],
    a6: [],
  },
};

describe('I/O matrix', () => {
  it('訊息與 draw: a valid draw round-trips', () => {
    expectRoundTrip(drawMessageSchema, DRAW);
  });

  it.each([
    ['sprite', FULL_SPRITE],
    ['particles', PARTICLES],
    ['bitmap', BITMAP],
  ])('訊息與 draw: a valid %s command round-trips', (_label, command) => {
    expectRoundTrip(drawCommandSchema, command);
  });

  it.each(['text', 'line', 'html', 'draw', ''])(
    '訊息與 draw: a command of unknown type %o is rejected',
    (type) => {
      expectRejected(drawCommandSchema, changed(SPRITE, ['type'], type));
      expectRejected(
        drawMessageSchema,
        changed(DRAW, ['actors', 'a3', 0, 'type'], type),
      );
    },
  );

  it('訊息與 draw: a message whose type is not draw is rejected', () => {
    expectRejected(drawMessageSchema, changed(DRAW, ['type'], 'frame'));
  });

  it.each([
    ['the draw', [] as const],
    ['a sprite', ['actors', 'a1', 0] as const],
    ['a particles command', ['actors', 'a1', 1] as const],
    ['a bitmap command', ['actors', 'a3', 1] as const],
  ])('訊息與 draw: %s with an extra field is rejected', (_label, at) => {
    expectRejected(drawMessageSchema, changed(DRAW, [...at, 'tint'], 0xff0000));
  });
});

describe('drawMessageSchema', () => {
  it.each([
    ['no actors', { type: 'draw', seq: 0, actors: {} }],
    [
      'an actor that draws nothing',
      { type: 'draw', seq: 1, actors: { a1: [] } },
    ],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(drawMessageSchema, value);
  });

  it.each([
    ['no seq', removed(DRAW, ['seq'])],
    ['a negative seq', changed(DRAW, ['seq'], -1)],
    ['a fractional seq', changed(DRAW, ['seq'], 0.5)],
    ['actors as a list', changed(DRAW, ['actors'], [[SPRITE]])],
    ['an empty actor id', changed(DRAW, ['actors', ''], [SPRITE])],
    [
      'an actor id past the limit',
      changed(DRAW, ['actors', 'x'.repeat(65)], []),
    ],
    ['commands that are not a list', changed(DRAW, ['actors', 'a1'], SPRITE)],
    ['a null command', changed(DRAW, ['actors', 'a1', 0], null)],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(drawMessageSchema, value);
  });

  it('rejects an actor keyed __proto__ as reserved-key', () => {
    const actors = withProtoKey(DRAW.actors, [SPRITE]);
    expect(Object.keys(actors)).toContain('__proto__');
    expectRuleIssue(drawMessageSchema, { ...DRAW, actors }, 'reserved-key', [
      'actors',
    ]);
  });

  it('rejects one actor naming an emitter id twice as duplicate-emitter-id', () => {
    expectRuleIssue(
      drawMessageSchema,
      changed(DRAW, ['actors', 'a1', 2], { ...PARTICLES, x: 0 }),
      'duplicate-emitter-id',
      ['actors', 'a1'],
    );
  });

  it('lets two actors each have an emitter with the same id', () => {
    expectRoundTrip(
      drawMessageSchema,
      changed(DRAW, ['actors', 'a3', 2], PARTICLES),
    );
  });

  it('lets one actor have two emitters with different ids', () => {
    expectRoundTrip(
      drawMessageSchema,
      changed(DRAW, ['actors', 'a1', 2], { ...PARTICLES, emitterId: 'smoke' }),
    );
  });
});

describe('sprite commands', () => {
  it('lists the three command types, one per command schema', () => {
    expect([...DRAW_COMMAND_TYPES]).toStrictEqual([
      'sprite',
      'particles',
      'bitmap',
    ]);
    expect(
      drawCommandSchema.options.map((option) => option.shape.type.value),
    ).toStrictEqual([...DRAW_COMMAND_TYPES]);
  });

  it('leaves out rotation 0, scale 1, alpha 1 and z 0 by default', () => {
    expect(SPRITE_COMMAND_DEFAULTS).toStrictEqual({
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      alpha: 1,
      z: 0,
    });
    expect(Object.isFrozen(SPRITE_COMMAND_DEFAULTS)).toBe(true);
  });

  it.each([
    ['the fewest fields', SPRITE],
    ['every field', FULL_SPRITE],
    ['alpha 0', changed(SPRITE, ['alpha'], 0)],
    ['alpha 1', changed(SPRITE, ['alpha'], 1)],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(spriteCommandSchema, value);
  });

  it.each([
    ['no asset', removed(SPRITE, ['asset'])],
    ['a bad asset key', changed(SPRITE, ['asset'], 'Body')],
    ['no x', removed(SPRITE, ['x'])],
    ['an infinite y', changed(SPRITE, ['y'], Infinity)],
    ['a NaN rotation', changed(SPRITE, ['rotation'], Number.NaN)],
    ['an empty frame', changed(SPRITE, ['frame'], '')],
    ['a numeric frame', changed(SPRITE, ['frame'], 3)],
    ['alpha above 1', changed(SPRITE, ['alpha'], 1.01)],
    ['alpha below 0', changed(SPRITE, ['alpha'], -0.01)],
    ['a fractional z', changed(SPRITE, ['z'], 0.5)],
    ['a scale set to undefined', changed(SPRITE, ['scaleX'], undefined)],
    ['an extra field', changed(SPRITE, ['tint'], 0)],
  ])('rejects %s', (_label, value) => {
    expectRejected(spriteCommandSchema, value);
  });
});

describe('particles commands', () => {
  it.each([
    ['with params', PARTICLES],
    ['without params', removed(PARTICLES, ['params'])],
    [
      'the longest emitter id',
      changed(PARTICLES, ['emitterId'], 'e'.repeat(EMITTER_ID_MAX_LENGTH)),
    ],
    [
      'any id-style preset (v1.0)',
      changed(PARTICLES, ['preset'], 'my-own-preset'),
    ],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(particlesCommandSchema, value);
  });

  it('rejects a parameter named __proto__ as reserved-key', () => {
    const params = withProtoKey(PARTICLES.params, 1);
    expectRuleIssue(
      particlesCommandSchema,
      { ...PARTICLES, params },
      'reserved-key',
      ['params'],
    );
  });

  it.each([
    ['an empty emitter id', changed(PARTICLES, ['emitterId'], '')],
    [
      'an emitter id past the limit',
      changed(PARTICLES, ['emitterId'], 'e'.repeat(EMITTER_ID_MAX_LENGTH + 1)),
    ],
    ['a preset that is not an id', changed(PARTICLES, ['preset'], 'Sparkle')],
    ['no preset', removed(PARTICLES, ['preset'])],
    ['an object parameter', changed(PARTICLES, ['params', 'color'], { r: 1 })],
    ['an empty parameter name', changed(PARTICLES, ['params', ''], 1)],
    ['params as a list', changed(PARTICLES, ['params'], [1])],
    ['an extra field', changed(PARTICLES, ['actorId'], 'a2')],
  ])('rejects %s', (_label, value) => {
    expectRejected(particlesCommandSchema, value);
  });
});

describe('bitmap commands', () => {
  it('round-trips with any object as the image', () => {
    expectRoundTrip(bitmapCommandSchema, BITMAP);
  });

  it.each([
    ['a null image', changed(BITMAP, ['image'], null)],
    ['a list as the image', changed(BITMAP, ['image'], [])],
    ['a string as the image', changed(BITMAP, ['image'], 'data:image/png')],
    ['no image', removed(BITMAP, ['image'])],
  ])('rejects %s as bitmap-image-not-object', (_label, value) => {
    expectRuleIssue(bitmapCommandSchema, value, 'bitmap-image-not-object', [
      'image',
    ]);
  });

  it.each([
    ['width 0', changed(BITMAP, ['width'], 0)],
    ['a negative height', changed(BITMAP, ['height'], -1)],
    ['an infinite width', changed(BITMAP, ['width'], Infinity)],
    ['an extra field', changed(BITMAP, ['alpha'], 1)],
  ])('rejects %s', (_label, value) => {
    expectRejected(bitmapCommandSchema, value);
  });
});
