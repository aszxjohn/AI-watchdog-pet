/**
 * overlay/renderer/pixi-stage (Stories 3.6, 3.7, 3.8), with PixiJS itself
 * under Node (no renderer, no DOM): the display objects a Scene becomes
 * (the placeholder's and the name tags' included), and the textures the
 * backend makes (spritesheet frames, sampling, the name tags' on fake 2D
 * canvases).
 */
import {
  Container,
  Graphics,
  ImageSource,
  type Particle,
  ParticleContainer,
  Sprite,
  Texture,
  TextureSource,
} from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  EmitterView,
  ParticleView,
} from '../../src/overlay/renderer/particles';
import {
  BADGE_DOT_GAP,
  BADGE_DOT_RADIUS,
  BADGE_LINE_HEIGHT,
  BADGE_NAME_MAX_WIDTH,
  BADGE_PADDING_X,
  BADGE_PADDING_Y,
  BADGE_STACK_GAP,
} from '../../src/overlay/renderer/badges';
import {
  PLACEHOLDER_ALPHA_MAX,
  PLACEHOLDER_ALPHA_MIN,
  PLACEHOLDER_COLOR,
  PLACEHOLDER_PERIOD_MS,
  placeholderAlpha,
  placeholderShape,
} from '../../src/overlay/renderer/placeholder';
import {
  badgeTextures,
  bitmapTexture,
  createPixiStage,
  type PaintCanvas,
  type PaintContext,
  PARTICLE_TEXTURE_SIZE,
  particleTextures,
  pixiTextures,
  sheetTextures,
  type StageBadges,
  type StageParticles,
  TEXTURE_SCALE_MODE,
} from '../../src/overlay/renderer/pixi-stage';
import type {
  Scene,
  SceneActor,
  SceneBadge,
  SceneBitmap,
} from '../../src/overlay/renderer/scene';
import {
  PARTICLE_PRESETS,
  type ParticlePreset,
} from '../../src/shared/pack-api';
import {
  FAKE_CHAR_WIDTH,
  fakeBadgeCanvases,
} from '../helpers/fake-badge-canvas';
import { FakeImageBitmap } from '../helpers/fake-bitmaps';

const BOUNDS = { x: -40, y: -130, width: 80, height: 130 };

function sceneActor(
  actorId: string,
  overrides: Partial<SceneActor> = {},
): SceneActor {
  return {
    actorId,
    sessionKey: `claude-code:${actorId}`,
    packId: 'alpha-pack',
    version: '1.0.0',
    x: 100,
    y: 800,
    scale: 1,
    bounds: BOUNDS,
    sprites: [],
    emitters: [],
    ...overrides,
  };
}

/** The world's width in these scenes, DIP. */
const CANVAS_WIDTH = 1512;

function scene(
  actors: SceneActor[],
  resolution = 1,
  canvasWidth = CANVAS_WIDTH,
): Scene {
  return { actors, resolution, canvasWidth, areas: [], missing: new Set() };
}

/** Where the stage draws the name tags: its layer and textures. */
function stageBadges(
  canvases: ReturnType<typeof fakeBadgeCanvases> = fakeBadgeCanvases(),
): StageBadges {
  return { layer: new Container(), textures: badgeTextures(canvases.create) };
}

/** A texture of its own source, `width` × `height` pixels. */
function textureOf(width = 4, height = 2): Texture {
  return new Texture({ source: new TextureSource({ width, height }) });
}

function setup() {
  const layer = new Container();
  const textures = new Map<string, Texture>([
    ['probe-one-plain', textureOf()],
    ['probe-two-sheet#eyes-open', textureOf()],
  ]);
  const stage = createPixiStage(
    layer,
    (_packId, _version, asset, frame) =>
      textures.get(frame === undefined ? asset : `${asset}#${frame}`),
    // No emitters.
    {
      emittersOf: () => [],
      textures: particleTextures(fakeCanvases().create),
    },
    stageBadges(),
  );
  return { layer, stage, textures };
}

/** An actor container's mask (its first child) and its sprites. */
function partsOf(container: Container) {
  const [mask, ...sprites] = container.children;
  return { mask: mask as Graphics, sprites: sprites as Sprite[] };
}

describe('I/O matrix', () => {
  it('大小與排序: each actor is a container at its place and 大小, put in the scene’s order; its sprites in theirs', () => {
    const { layer, stage } = setup();

    const counts = stage.draw(
      scene([
        sceneActor('a1', {
          x: 1408,
          y: 886,
          scale: 1.5,
          sprites: [
            {
              asset: 'probe-one-plain',
              frame: undefined,
              x: -30,
              y: -110,
              rotation: 0.25,
              scaleX: -30,
              scaleY: 55,
              alpha: 0.7,
            },
          ],
        }),
        sceneActor('a2', {
          x: 1290,
          y: 900,
          scale: 0.9,
          bounds: { x: -40, y: -110, width: 80, height: 110 },
          sprites: [
            {
              asset: 'probe-two-sheet',
              frame: 'eyes-open',
              x: -25,
              y: -96,
              rotation: 0,
              scaleX: 25,
              scaleY: 48,
              alpha: 1,
            },
          ],
        }),
      ]),
    );

    expect(counts).toStrictEqual({
      actors: 2,
      sprites: 2,
      bitmaps: 0,
      placeholders: 0,
      placeholderAlpha: placeholderAlpha(0),
      badges: 0,
    });
    expect(layer.children).toHaveLength(2);
    const [first, second] = layer.children as Container[];
    expect([first?.x, first?.y, first?.scale.x, first?.scale.y]).toStrictEqual([
      1408, 886, 1.5, 1.5,
    ]);
    expect([second?.x, second?.y, second?.scale.x]).toStrictEqual([
      1290, 900, 0.9,
    ]);
    const one = partsOf(first as Container);
    const [sprite] = one.sprites;
    expect(sprite?.visible).toBe(true);
    expect([sprite?.anchor.x, sprite?.anchor.y]).toStrictEqual([0, 0]);
    expect([sprite?.x, sprite?.y]).toStrictEqual([-30, -110]);
    expect([sprite?.scale.x, sprite?.scale.y]).toStrictEqual([-30, 55]);
    expect(sprite?.rotation).toBe(0.25);
    expect(sprite?.alpha).toBe(0.7);
  });

  it('裁切: each container is masked by a rectangle of its bounds, in its own coordinates (a child of it)', () => {
    const { layer, stage } = setup();
    stage.draw(
      scene([
        sceneActor('a1', { scale: 2 }),
        sceneActor('a2', {
          bounds: { x: -40, y: -110, width: 80, height: 110 },
        }),
      ]),
    );

    const rects = (layer.children as Container[]).map((container) => {
      const { mask } = partsOf(container);
      expect(container.mask).toBe(mask);
      expect(mask.parent).toBe(container);
      const { minX, minY, maxX, maxY } = mask.bounds;
      return [minX, minY, maxX - minX, maxY - minY];
    });
    expect(rects).toStrictEqual([
      [-40, -130, 80, 130],
      [-40, -110, 80, 110],
    ]);
  });

  it('a sprite whose texture is not there (loading or failed) is hidden and not counted', () => {
    const { layer, stage } = setup();

    const counts = stage.draw(
      scene([
        sceneActor('a1', {
          sprites: [
            {
              asset: 'probe-one-dots',
              frame: undefined,
              x: 0,
              y: 0,
              rotation: 0,
              scaleX: 1,
              scaleY: 1,
              alpha: 1,
            },
          ],
        }),
      ]),
    );

    expect(counts).toStrictEqual({
      actors: 1,
      sprites: 0,
      bitmaps: 0,
      placeholders: 0,
      placeholderAlpha: placeholderAlpha(0),
      badges: 0,
    });
    expect(partsOf(layer.children[0] as Container).sprites[0]?.visible).toBe(
      false,
    );
  });

  it('加入與移出: an actor gone from the scene has its container destroyed, the others are kept (same objects), reordered as the scene says', () => {
    const { layer, stage } = setup();
    stage.draw(scene([sceneActor('a1'), sceneActor('a2'), sceneActor('a3')]));
    const [one, two, three] = layer.children as Container[];

    stage.draw(scene([sceneActor('a3'), sceneActor('a1')]));

    expect(layer.children).toStrictEqual([three, one]);
    expect(two?.destroyed).toBe(true);
    expect(one?.destroyed).toBe(false);
  });

  it('漏回: an actor with fewer sprites than before loses the extra ones', () => {
    const { layer, stage } = setup();
    const sprite = {
      asset: 'probe-one-plain',
      frame: undefined,
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      alpha: 1,
    };
    stage.draw(scene([sceneActor('a1', { sprites: [sprite, sprite] })]));
    stage.draw(scene([sceneActor('a1', { sprites: [sprite] })]));

    expect(partsOf(layer.children[0] as Container).sprites).toHaveLength(1);
  });
});

/** A 2D context that writes down what is painted with it. */
function recordingContext(calls: string[]): PaintContext {
  const context: PaintContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    beginPath: () => calls.push('beginPath'),
    closePath: () => calls.push('closePath'),
    moveTo: (x, y) => calls.push(`moveTo ${x} ${y}`),
    lineTo: (x, y) => calls.push(`lineTo ${x} ${y}`),
    arc: (x, y, radius) => calls.push(`arc ${x} ${y} ${radius}`),
    fill: () => calls.push(`fill ${String(context.fillStyle)}`),
    stroke: () =>
      calls.push(`stroke ${String(context.strokeStyle)} ${context.lineWidth}`),
    fillRect: (x, y, width, height) =>
      calls.push(
        `fillRect ${x} ${y} ${width} ${height} ${String(context.fillStyle)}`,
      ),
    createRadialGradient: () => ({
      addColorStop: (offset, color) => calls.push(`stop ${offset} ${color}`),
      toString: () => 'gradient',
    }),
  };
  return context;
}

/** Canvases that write down what is painted on them, in order made. */
function fakeCanvases() {
  const made: { canvas: PaintCanvas; calls: string[] }[] = [];
  return {
    made,
    create: (): PaintCanvas => {
      const calls: string[] = [];
      const canvas: PaintCanvas = {
        width: 300,
        height: 150,
        getContext: () => recordingContext(calls),
      };
      made.push({ canvas, calls });
      return canvas;
    },
  };
}

function particle(overrides: Partial<ParticleView> = {}): ParticleView {
  return {
    x: 2,
    y: -118,
    size: 8,
    rotation: 0.5,
    color: 0xfff4b0,
    alpha: 0.75,
    ...overrides,
  };
}

function emitter(
  id: number,
  preset: ParticlePreset,
  particles: readonly ParticleView[],
): EmitterView {
  return { id, emitterId: `e${id}`, preset, active: true, particles };
}

/** A pixi-stage drawing particles from `emitters`, by actor. */
function setupParticles() {
  const layer = new Container();
  const emitters = new Map<string, EmitterView[]>();
  const canvases = fakeCanvases();
  const particles: StageParticles = {
    emittersOf: (actorId) => emitters.get(actorId) ?? [],
    textures: particleTextures(canvases.create),
  };
  const sprite = textureOf();
  const stage = createPixiStage(layer, () => sprite, particles, stageBadges());
  return { layer, stage, emitters, particles, canvases };
}

/** An actor's particle containers (after its mask and sprites). */
function emittersIn(container: Container): ParticleContainer<Particle>[] {
  return container.children.filter(
    (child): child is ParticleContainer<Particle> =>
      child instanceof ParticleContainer,
  );
}

const SPRITE_COMMAND = {
  asset: 'probe-one-plain',
  frame: undefined,
  x: -30,
  y: -110,
  rotation: 0,
  scaleX: 30,
  scaleY: 55,
  alpha: 1,
};

describe('I/O matrix', () => {
  it('粒子出現: each emitter of a drawn actor is a ParticleContainer in its container above its sprites, with its preset’s texture and the actor’s bounds as its bounds area; its particles as particles.ts has them', () => {
    const { layer, stage, emitters, particles } = setupParticles();
    emitters.set('a1', [
      emitter(1, 'sparkle', [particle(), particle({ x: -3, color: 0xffffff })]),
    ]);

    stage.draw(scene([sceneActor('a1', { sprites: [SPRITE_COMMAND] })]));

    // What it put on screen, for main.ts's data attributes.
    expect(stage.particleCounts()).toStrictEqual({ emitters: 1, particles: 2 });
    const container = layer.children[0] as Container;
    const [mask, sprite, sparkle] = container.children;
    expect(mask).toBeInstanceOf(Graphics);
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sparkle).toBeInstanceOf(ParticleContainer);
    const emitterNode = sparkle as ParticleContainer<Particle>;
    expect(emitterNode.texture).toBe(particles.textures.get('sparkle'));
    const area = emitterNode.boundsArea;
    expect([area.x, area.y, area.width, area.height]).toStrictEqual([
      -40, -130, 80, 130,
    ]);
    const [first, second] = emitterNode.particleChildren;
    expect(emitterNode.particleChildren).toHaveLength(2);
    expect([first?.x, first?.y]).toStrictEqual([2, -118]);
    expect([first?.anchorX, first?.anchorY]).toStrictEqual([0.5, 0.5]);
    expect(first?.scaleX).toBeCloseTo(8 / PARTICLE_TEXTURE_SIZE);
    expect(first?.scaleY).toBeCloseTo(8 / PARTICLE_TEXTURE_SIZE);
    expect(first?.rotation).toBe(0.5);
    expect(first?.tint).toBe(0xfff4b0);
    expect(first?.alpha).toBe(0.75);
    expect(first?.texture).toBe(emitterNode.texture);
    expect(second?.tint).toBe(0xffffff);

    // A sprite added later still goes under the particles.
    stage.draw(
      scene([sceneActor('a1', { sprites: [SPRITE_COMMAND, SPRITE_COMMAND] })]),
    );
    expect(
      container.children.map((child) =>
        child instanceof ParticleContainer
          ? 'particles'
          : child instanceof Sprite
            ? 'sprite'
            : child === container.mask
              ? 'mask'
              : 'other',
      ),
    ).toStrictEqual(['mask', 'sprite', 'sprite', 'particles']);
  });

  it('粒子跟隨: the same emitter keeps its container and particles from frame to frame; they take the new values, and their number follows', () => {
    const { layer, stage, emitters } = setupParticles();
    emitters.set('a1', [emitter(1, 'sparkle', [particle(), particle()])]);
    stage.draw(scene([sceneActor('a1')]));
    const [node] = emittersIn(layer.children[0] as Container);
    const [kept] = node?.particleChildren ?? [];

    emitters.set('a1', [
      emitter(1, 'sparkle', [particle({ x: 30, y: -60, alpha: 0.2 })]),
    ]);
    stage.draw(scene([sceneActor('a1')]));

    expect(emittersIn(layer.children[0] as Container)).toStrictEqual([node]);
    expect(node?.particleChildren).toHaveLength(1);
    expect(node?.particleChildren[0]).toBe(kept);
    expect([kept?.x, kept?.y, kept?.alpha]).toStrictEqual([30, -60, 0.2]);

    emitters.set('a1', [
      emitter(1, 'sparkle', [particle(), particle(), particle()]),
    ]);
    stage.draw(scene([sceneActor('a1')]));
    expect(node?.particleChildren).toHaveLength(3);
  });

  it('大小與裁切: the particles are in the actor’s container, so they take its 大小 and are clipped by its bounds mask', () => {
    const { layer, stage, emitters } = setupParticles();
    emitters.set('a1', [emitter(1, 'confetti', [particle({ y: -200 })])]);

    stage.draw(scene([sceneActor('a1', { scale: 1.5 })]));

    const container = layer.children[0] as Container;
    const [node] = emittersIn(container);
    expect(node?.parent).toBe(container);
    expect(container.scale.x).toBe(1.5);
    expect(container.mask).toBe(container.children[0]);
    // Bounds that change move the bounds area with the mask.
    stage.draw(
      scene([
        sceneActor('a1', {
          scale: 1.5,
          bounds: { x: -50, y: -150, width: 100, height: 150 },
        }),
      ]),
    );
    const area = node?.boundsArea;
    expect([area?.x, area?.y, area?.width, area?.height]).toStrictEqual([
      -50, -150, 100, 150,
    ]);
  });

  it('粒子停止: an emitter gone from particles.ts has its container destroyed; the later ones keep theirs, in the order they started', () => {
    const { layer, stage, emitters } = setupParticles();
    emitters.set('a1', [
      emitter(1, 'sparkle', [particle()]),
      emitter(2, 'smoke', [particle()]),
    ]);
    stage.draw(scene([sceneActor('a1')]));
    const [first, second] = emittersIn(layer.children[0] as Container);

    emitters.set('a1', [
      emitter(2, 'smoke', [particle()]),
      emitter(3, 'bubbles', [particle()]),
    ]);
    stage.draw(scene([sceneActor('a1')]));

    const now = emittersIn(layer.children[0] as Container);
    expect(first?.destroyed).toBe(true);
    expect(now[0]).toBe(second);
    expect(now).toHaveLength(2);
    expect(now[1]?.texture).not.toBe(second?.texture);

    // All of them gone: none on screen.
    emitters.set('a1', []);
    stage.draw(scene([sceneActor('a1')]));
    expect(emittersIn(layer.children[0] as Container)).toStrictEqual([]);
    expect(stage.particleCounts()).toStrictEqual({ emitters: 0, particles: 0 });
  });

  it('actor 離場: an actor gone takes its emitters’ containers with it; the presets’ textures stay for the others', () => {
    const { layer, stage, emitters, particles } = setupParticles();
    emitters.set('a1', [emitter(1, 'sparkle', [particle()])]);
    emitters.set('a2', [emitter(2, 'sparkle', [particle()])]);
    stage.draw(scene([sceneActor('a1'), sceneActor('a2')]));
    const [gone] = emittersIn(layer.children[0] as Container);
    expect(stage.particleCounts()).toStrictEqual({ emitters: 2, particles: 2 });

    stage.draw(scene([sceneActor('a2')]));

    expect(stage.particleCounts()).toStrictEqual({ emitters: 1, particles: 1 });
    expect(gone?.destroyed).toBe(true);
    expect(particles.textures.get('sparkle').destroyed).toBe(false);
    const [left] = emittersIn(layer.children[0] as Container);
    expect(left?.texture).toBe(particles.textures.get('sparkle'));
  });

  it('粒子出現: emitters of an actor not in the scene are neither drawn nor counted; none before any draw', () => {
    const { stage, emitters } = setupParticles();
    expect(stage.particleCounts()).toStrictEqual({ emitters: 0, particles: 0 });
    emitters.set('a9', [emitter(1, 'sparkle', [particle()])]);

    stage.draw(scene([sceneActor('a1')]));

    expect(stage.particleCounts()).toStrictEqual({ emitters: 0, particles: 0 });
  });

  it('hit area: drawing particles changes nothing but the actor’s own container (no sprite is added for them)', () => {
    const { layer, stage, emitters } = setupParticles();
    emitters.set('a1', [emitter(1, 'sparkle', [particle()])]);

    const counts = stage.draw(scene([sceneActor('a1')]));

    expect(counts).toStrictEqual({
      actors: 1,
      sprites: 0,
      bitmaps: 0,
      placeholders: 0,
      placeholderAlpha: placeholderAlpha(0),
      badges: 0,
    });
    expect(layer.children).toHaveLength(1);
  });
});

describe('the particle textures', () => {
  it('四種 preset: one texture per preset, made once, on its own 32-pixel canvas, painted in white in its own shape, sampled linearly', () => {
    const canvases = fakeCanvases();
    const textures = particleTextures(canvases.create);

    const made = PARTICLE_PRESETS.map((preset) => textures.get(preset));

    expect(new Set(made).size).toBe(PARTICLE_PRESETS.length);
    expect(textures.get('sparkle')).toBe(made[0]);
    expect(canvases.made).toHaveLength(PARTICLE_PRESETS.length);
    made.forEach((texture, index) => {
      const canvas = canvases.made[index]?.canvas;
      expect([canvas?.width, canvas?.height]).toStrictEqual([
        PARTICLE_TEXTURE_SIZE,
        PARTICLE_TEXTURE_SIZE,
      ]);
      expect(texture.source).toBeInstanceOf(ImageSource);
      expect(texture.source.resource).toBe(canvas);
      expect(texture.source.scaleMode).toBe(TEXTURE_SCALE_MODE);
    });
    const painted = canvases.made.map(({ calls }) => calls.join('\n'));
    expect(new Set(painted).size).toBe(PARTICLE_PRESETS.length);
    for (const calls of canvases.made.map((each) => each.calls)) {
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // White only: the particles' colours are their tint.
        expect(call).not.toMatch(/rgba\((?!255, 255, 255,)/);
        expect(call).not.toMatch(/#(?!ffffff)[0-9a-f]{6}/);
      }
    }
    // The square and the bubble: a filled square, and a stroked ring.
    expect(canvases.made[2]?.calls).toContain('fillRect 2 2 28 28 #ffffff');
    expect(canvases.made[3]?.calls).toContain('stroke #ffffff 3');
  });

  it('a canvas without a 2D context gives a clear texture, not an error', () => {
    const textures = particleTextures(() => ({
      width: 0,
      height: 0,
      getContext: () => null,
    }));

    expect(textures.get('smoke')).toBeInstanceOf(Texture);
  });

  it('destroy() destroys the presets’ textures with their sources, and the stage’s with it', () => {
    const { stage, particles, emitters } = setupParticles();
    emitters.set('a1', [emitter(1, 'bubbles', [particle()])]);
    stage.draw(scene([sceneActor('a1')]));
    const texture = particles.textures.get('bubbles');
    const { source } = texture;

    stage.destroy();

    expect(texture.destroyed).toBe(true);
    expect(source.destroyed).toBe(true);
    expect(stage.particleCounts()).toStrictEqual({ emitters: 0, particles: 0 });
  });
});

describe('the textures', () => {
  it('spritesheet: sheetTextures gives each frame its rectangle of the image, a rotated one turned back', () => {
    const base = textureOf(8, 4);
    const frames = sheetTextures(base, {
      frames: {
        open: { frame: { x: 0, y: 0, w: 2, h: 2 } },
        // Stored turned: 1 wide, 3 high in the image.
        turned: { frame: { x: 2, y: 0, w: 3, h: 1 }, rotated: true },
        trimmed: {
          frame: { x: 4, y: 0, w: 2, h: 2 },
          spriteSourceSize: { x: 1, y: 1, w: 2, h: 2 },
          sourceSize: { w: 4, h: 4 },
        },
      },
      meta: { image: 'sheet.png' },
    });

    expect([...frames.keys()]).toStrictEqual(['open', 'turned', 'trimmed']);
    const rect = (name: string) => {
      const frame = frames.get(name)?.frame;
      return [frame?.x, frame?.y, frame?.width, frame?.height];
    };
    expect(rect('open')).toStrictEqual([0, 0, 2, 2]);
    expect(rect('turned')).toStrictEqual([2, 0, 1, 3]);
    expect(frames.get('turned')?.rotate).toBe(2);
    expect(rect('trimmed')).toStrictEqual([4, 0, 2, 2]);
    expect([
      frames.get('trimmed')?.orig.width,
      frames.get('trimmed')?.trim?.x,
    ]).toStrictEqual([4, 1]);
    for (const texture of frames.values()) {
      expect(texture.source).toBe(base.source);
    }
  });

  it('an image texture has its own source, sampled linearly', () => {
    const backend = pixiTextures(async () => ({
      naturalWidth: 4,
      naturalHeight: 2,
      width: 4,
      height: 2,
    }));
    const image = { naturalWidth: 4, naturalHeight: 2, width: 4, height: 2 };

    const one = backend.imageTexture(image);
    const two = backend.imageTexture(image);

    expect(TEXTURE_SCALE_MODE).toBe('linear');
    expect(one.source.scaleMode).toBe('linear');
    expect(one.source).not.toBe(two.source);
    expect(backend.sizeOf(image)).toStrictEqual({ width: 4, height: 2 });
  });
});

// ---------------------------------------------------------------------------
// Bitmaps (Story 3.6's last part): FakeImageBitmap stands in for the
// ImageBitmaps a pack sends; PixiJS takes it as an ImageSource's resource.

function bitmapOf(
  image: FakeImageBitmap,
  overrides: Partial<SceneBitmap> = {},
): SceneBitmap {
  return { image, x: -32, y: -100, width: 60, height: 90, ...overrides };
}

/** What each child of an actor's container is. */
function layout(container: Container, bitmap: Sprite | undefined): string[] {
  return container.children.map((child) =>
    child === container.mask
      ? 'mask'
      : child === bitmap
        ? 'bitmap'
        : child instanceof ParticleContainer
          ? 'particles'
          : child instanceof Sprite
            ? 'sprite'
            : 'other',
  );
}

/** The Sprite showing `texture`'s source in `container`, if any. */
function spriteOf(
  container: Container,
  image: FakeImageBitmap,
): Sprite | undefined {
  return container.children.find(
    (child): child is Sprite =>
      child instanceof Sprite && child.texture.source.resource === image,
  );
}

describe('I/O matrix', () => {
  it('bitmap 出現: an actor’s bitmap is one Sprite in its container (so it takes its 大小 and bounds mask), above its sprites and under its particles, top-left at x, y and width x height base pixels; counted as a bitmap', () => {
    const { layer, stage, emitters } = setupParticles();
    emitters.set('a1', [emitter(1, 'sparkle', [particle()])]);
    const image = new FakeImageBitmap(64, 32);

    const counts = stage.draw(
      scene([
        sceneActor('a1', {
          scale: 1.5,
          sprites: [SPRITE_COMMAND],
          bitmap: bitmapOf(image),
        }),
      ]),
    );

    expect(counts).toStrictEqual({
      actors: 1,
      sprites: 1,
      bitmaps: 1,
      placeholders: 0,
      placeholderAlpha: placeholderAlpha(0),
      badges: 0,
    });
    const container = layer.children[0] as Container;
    const sprite = spriteOf(container, image);
    expect(sprite).toBeDefined();
    expect(layout(container, sprite)).toStrictEqual([
      'mask',
      'sprite',
      'bitmap',
      'particles',
    ]);
    expect([sprite?.x, sprite?.y]).toStrictEqual([-32, -100]);
    expect([sprite?.anchor.x, sprite?.anchor.y]).toStrictEqual([0, 0]);
    expect([sprite?.width, sprite?.height]).toStrictEqual([60, 90]);
    expect(sprite?.scale.x).toBeCloseTo(60 / 64);
    expect(sprite?.scale.y).toBeCloseTo(90 / 32);
    expect(sprite?.visible).toBe(true);
    expect(container.scale.x).toBe(1.5);
    expect(stage.bitmapShown('a1')).toBe(true);
    expect(stage.bitmapShown('a2')).toBe(false);

    // Sprites added later still go under it.
    stage.draw(
      scene([
        sceneActor('a1', {
          sprites: [SPRITE_COMMAND, SPRITE_COMMAND],
          bitmap: bitmapOf(image),
        }),
      ]),
    );
    expect(layout(container, sprite)).toStrictEqual([
      'mask',
      'sprite',
      'sprite',
      'bitmap',
      'particles',
    ]);
  });

  it('bitmap 出現: its texture is its own ImageSource over the ImageBitmap, sampled linearly, outside the global cache and PixiJS’s texture garbage collection', () => {
    const image = new FakeImageBitmap(16, 8);

    const texture = bitmapTexture(image);

    expect(texture.source).toBeInstanceOf(ImageSource);
    expect(texture.source.resource).toBe(image);
    expect(texture.source.autoGarbageCollect).toBe(false);
    expect(texture.source.scaleMode).toBe(TEXTURE_SCALE_MODE);
    expect([texture.width, texture.height]).toStrictEqual([16, 8]);
    expect(bitmapTexture(image).source).not.toBe(texture.source);
    expect(image.closes).toBe(0);
  });

  it('釋放: a new image is put up first; then the old texture is destroyed with its source and the old ImageBitmap closed; the one shown is not closed; the same image again changes nothing', () => {
    const { layer, stage } = setup();
    const first = new FakeImageBitmap();
    // Another pixel size than the first's 8 x 8, drawn at another size.
    const second = new FakeImageBitmap(32, 16);
    stage.draw(scene([sceneActor('a1', { bitmap: bitmapOf(first) })]));
    const container = layer.children[0] as Container;
    const sprite = spriteOf(container, first);
    const firstTexture = sprite?.texture;
    const firstSource = firstTexture?.source;

    stage.draw(scene([sceneActor('a1', { bitmap: bitmapOf(first) })]));
    expect(sprite?.texture).toBe(firstTexture);
    expect(first.closes).toBe(0);
    expect([sprite?.width, sprite?.height]).toStrictEqual([60, 90]);
    expect(sprite?.scale.x).toBeCloseTo(60 / 8);
    expect(sprite?.scale.y).toBeCloseTo(90 / 8);
    // What the sprite shows when the old image is closed.
    let shownAtClose: unknown;
    const closeFirst = first.close.bind(first);
    first.close = () => {
      shownAtClose = sprite?.texture.source.resource;
      closeFirst();
    };

    stage.draw(
      scene([
        sceneActor('a1', {
          bitmap: bitmapOf(second, { x: 5, width: 100, height: 40 }),
        }),
      ]),
    );

    // The same sprite, now over the new image, which was up before the old
    // one was closed, at the new command's size over the new image's.
    expect(shownAtClose).toBe(second);
    expect(spriteOf(container, second)).toBe(sprite);
    expect(sprite?.x).toBe(5);
    expect([sprite?.width, sprite?.height]).toStrictEqual([100, 40]);
    expect(sprite?.scale.x).toBeCloseTo(100 / 32);
    expect(sprite?.scale.y).toBeCloseTo(40 / 16);
    expect(firstTexture?.destroyed).toBe(true);
    expect(firstSource?.destroyed).toBe(true);
    expect(first.closes).toBe(1);
    expect(second.closes).toBe(0);
    expect(sprite?.texture.source.destroyed).toBe(false);
  });

  it('釋放: a bitmap gone from the actor’s draw, the actor gone, or the stage destroyed: its sprite and texture are destroyed and its ImageBitmap closed, once', () => {
    const { layer, stage } = setup();
    const gone = new FakeImageBitmap();
    const left = new FakeImageBitmap();
    const last = new FakeImageBitmap();
    stage.draw(
      scene([
        sceneActor('a1', { bitmap: bitmapOf(gone) }),
        sceneActor('a2', { bitmap: bitmapOf(left) }),
      ]),
    );
    const a1 = layer.children[0] as Container;
    const goneSprite = spriteOf(a1, gone);
    const goneSource = goneSprite?.texture.source;
    const leftSource = spriteOf(layer.children[1] as Container, left)?.texture
      .source;

    // a1 draws no bitmap now; a2 has left.
    const counts = stage.draw(scene([sceneActor('a1')]));
    expect(counts.bitmaps).toBe(0);
    expect(goneSprite?.destroyed).toBe(true);
    expect(layout(a1, undefined)).toStrictEqual(['mask']);
    expect(goneSource?.destroyed).toBe(true);
    expect(leftSource?.destroyed).toBe(true);
    expect([gone.closes, left.closes]).toStrictEqual([1, 1]);
    expect(stage.bitmapShown('a1')).toBe(false);

    stage.draw(scene([sceneActor('a1', { bitmap: bitmapOf(last) })]));
    const lastSprite = spriteOf(layer.children[0] as Container, last);
    const lastTexture = lastSprite?.texture;
    const lastSource = lastTexture?.source;
    expect(last.closes).toBe(0);
    stage.destroy();
    expect(lastSprite?.destroyed).toBe(true);
    expect(lastTexture?.destroyed).toBe(true);
    expect(lastSource?.destroyed).toBe(true);
    expect(last.closes).toBe(1);
    expect([gone.closes, left.closes]).toStrictEqual([1, 1]);
  });

  it('釋放: an image this stage closed (its actor was not drawn for a frame, its draw unchanged) is never shown again nor closed twice; a new image is', () => {
    const { layer, stage } = setup();
    const image = new FakeImageBitmap();
    stage.draw(scene([sceneActor('a1', { bitmap: bitmapOf(image) })]));
    stage.draw(scene([]));
    expect(image.closes).toBe(1);

    const counts = stage.draw(
      scene([sceneActor('a1', { bitmap: bitmapOf(image) })]),
    );

    expect(counts.bitmaps).toBe(0);
    expect(image.closes).toBe(1);
    expect(stage.bitmapShown('a1')).toBe(false);
    expect(layout(layer.children[0] as Container, undefined)).toStrictEqual([
      'mask',
    ]);
    const fresh = new FakeImageBitmap();
    expect(
      stage.draw(scene([sceneActor('a1', { bitmap: bitmapOf(fresh) })]))
        .bitmaps,
    ).toBe(1);
  });

  it('context 還原: the same scene drawn again, as once a lost context is back, keeps the same sprite, texture and source (PixiJS uploads it again from its ImageBitmap): nothing is destroyed or closed', () => {
    const { layer, stage } = setup();
    const image = new FakeImageBitmap();
    const shown = scene([sceneActor('a1', { bitmap: bitmapOf(image) })]);
    stage.draw(shown);
    const sprite = spriteOf(layer.children[0] as Container, image);
    const texture = sprite?.texture;

    // Lost: nothing is drawn (main.ts does not call draw()); restored: the
    // next frame draws the same.
    const counts = stage.draw(shown);

    expect(counts.bitmaps).toBe(1);
    expect(spriteOf(layer.children[0] as Container, image)).toBe(sprite);
    expect(sprite?.texture).toBe(texture);
    expect(texture?.source.destroyed).toBe(false);
    expect(texture?.source.resource).toBe(image);
    expect(texture?.source.autoGarbageCollect).toBe(false);
    expect(image.closes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The placeholder (Story 3.7): an actor whose state does not map is drawn
// as the stage's own figure, a Graphics, instead of its pack's draw.

/** The contract pack's probe-one's hitbox. */
const HITBOX = { x: -30, y: -110, width: 60, height: 110 };

/** An actor drawn as the placeholder for `hitbox`. */
function placeholderActor(
  actorId: string,
  overrides: Partial<SceneActor> = {},
  hitbox = HITBOX,
): SceneActor {
  return sceneActor(actorId, { placeholder: hitbox, ...overrides });
}

/** The placeholder in an actor's container: a Graphics that is not its mask. */
function placeholderIn(container: Container): Graphics | undefined {
  return container.children.find(
    (child): child is Graphics =>
      child instanceof Graphics && child !== container.mask,
  );
}

/** What each child of an actor's container is, the placeholder named. */
function layoutOf(container: Container): string[] {
  const placeholder = placeholderIn(container);
  return container.children.map((child) =>
    child === container.mask
      ? 'mask'
      : child === placeholder
        ? 'placeholder'
        : child instanceof ParticleContainer
          ? 'particles'
          : child instanceof Sprite
            ? 'sprite'
            : 'other',
  );
}

/** A Graphics' bounds, as [x, y, width, height]. */
function boxOf(graphics: Graphics | undefined): number[] {
  const bounds = graphics?.bounds;
  return bounds === undefined
    ? []
    : [
        bounds.minX,
        bounds.minY,
        bounds.maxX - bounds.minX,
        bounds.maxY - bounds.minY,
      ];
}

describe('I/O matrix', () => {
  it('佔位: an actor drawn as the placeholder has one Graphics in its container right after the mask (so it takes its place, 大小 and bounds mask), filling its hitbox with a grey circle and rounded rectangle, at full opacity at first; counted as a placeholder and an actor', () => {
    const { layer, stage } = setup();

    const counts = stage.draw(
      scene([placeholderActor('a1', { x: 1408, y: 886, scale: 1.5 })]),
    );

    expect(counts).toStrictEqual({
      actors: 1,
      sprites: 0,
      bitmaps: 0,
      placeholders: 1,
      placeholderAlpha: placeholderAlpha(0),
      badges: 0,
    });
    const container = layer.children[0] as Container;
    expect(layoutOf(container)).toStrictEqual(['mask', 'placeholder']);
    const graphics = placeholderIn(container);
    expect(graphics?.parent).toBe(container);
    expect(container.mask).toBe(container.children[0]);
    expect([container.x, container.y, container.scale.x]).toStrictEqual([
      1408, 886, 1.5,
    ]);
    expect(boxOf(graphics)).toStrictEqual([-30, -110, 60, 110]);
    const head = placeholderShape(HITBOX).head;
    const body = placeholderShape(HITBOX).body;
    const fills = (graphics?.context.instructions ?? []).map((instruction) => {
      if (instruction.action !== 'fill') {
        return [instruction.action];
      }
      const { style, path } = instruction.data;
      return [
        style.color,
        style.alpha,
        ...path.shapePath.shapePrimitives.map(({ shape }) => shape),
      ];
    });
    expect(fills).toStrictEqual([
      [
        PLACEHOLDER_COLOR,
        1,
        expect.objectContaining({
          type: 'circle',
          x: head.x,
          y: head.y,
          radius: head.radius,
        }),
      ],
      [
        PLACEHOLDER_COLOR,
        1,
        expect.objectContaining({
          type: 'roundedRectangle',
          x: body.x,
          y: body.y,
          width: body.width,
          height: body.height,
          radius: body.radius,
        }),
      ],
    ]);
    expect(graphics?.alpha).toBeCloseTo(PLACEHOLDER_ALPHA_MAX);
    expect(graphics?.visible).toBe(true);
  });

  it('佔位: its opacity follows the time draw() is given (the render loop’s): faintest half a period on, full again after a whole one; a draw() given no time (the render loop stopped) leaves it standing still', () => {
    const { layer, stage } = setup();
    const shown = scene([placeholderActor('a1')]);
    stage.draw(shown, 33);
    const graphics = placeholderIn(layer.children[0] as Container);
    expect(graphics?.alpha).toBeCloseTo(placeholderAlpha(33));

    stage.draw(shown, PLACEHOLDER_PERIOD_MS / 2 - 33);
    expect(graphics?.alpha).toBeCloseTo(PLACEHOLDER_ALPHA_MIN);
    stage.draw(shown);
    stage.draw(shown, 0);
    expect(graphics?.alpha).toBeCloseTo(PLACEHOLDER_ALPHA_MIN);
    stage.draw(shown, PLACEHOLDER_PERIOD_MS / 2);
    expect(graphics?.alpha).toBeCloseTo(PLACEHOLDER_ALPHA_MAX);
    // A time that is not a number moves nothing.
    stage.draw(shown, Number.NaN);
    stage.draw(shown, -50);
    expect(graphics?.alpha).toBeCloseTo(PLACEHOLDER_ALPHA_MAX);
  });

  it('佔位 opacity: draw() returns the opacity it drew the placeholders at (main.ts shows it as placeholderAlpha), the Graphics’ own at every draw; with no placeholder it is still worked out, the time going on', () => {
    const { layer, stage } = setup();
    const shown = scene([placeholderActor('a1')]);

    let counts = stage.draw(shown);
    const graphics = placeholderIn(layer.children[0] as Container);
    expect(counts.placeholderAlpha).toBe(placeholderAlpha(0));
    expect(graphics?.alpha).toBe(counts.placeholderAlpha);

    // [time given, the render loop's time since the first draw].
    for (const [dtMs, timeMs] of [
      [300, 300],
      [450, 750],
      // No time: it stands still.
      [0, 750],
      // Past a whole period: kept to one.
      [1500, 250],
    ] as const) {
      counts = stage.draw(shown, dtMs);
      expect(counts.placeholderAlpha).toBe(placeholderAlpha(timeMs));
      expect(graphics?.alpha).toBe(counts.placeholderAlpha);
    }
    expect(new Set([0, 300, 750, 250].map(placeholderAlpha)).size).toBe(4);

    counts = stage.draw(scene([sceneActor('a1')]), 250);
    expect(counts).toMatchObject({
      placeholders: 0,
      placeholderAlpha: placeholderAlpha(500),
      badges: 0,
    });
  });

  it('佔位: the same Graphics is kept from frame to frame and drawn again only when the hitbox changes; then it fills the new one', () => {
    const { layer, stage } = setup();
    stage.draw(scene([placeholderActor('a1')]));
    const container = layer.children[0] as Container;
    const graphics = placeholderIn(container);
    expect(graphics).toBeDefined();
    const clear = vi.spyOn(graphics as Graphics, 'clear');

    stage.draw(scene([placeholderActor('a1', { x: 500, scale: 2 })]), 100);
    expect(placeholderIn(container)).toBe(graphics);
    expect(clear).not.toHaveBeenCalled();
    expect(container.x).toBe(500);

    const other = { x: -25, y: -96, width: 50, height: 96 };
    stage.draw(scene([placeholderActor('a1', {}, other)]));
    expect(placeholderIn(container)).toBe(graphics);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(boxOf(graphics)).toStrictEqual([-25, -96, 50, 96]);
    expect(graphics?.context.instructions).toHaveLength(2);
  });

  it('狀態變回: drawn with its pack’s draw again, its Graphics is destroyed and its sprites take its place after the mask; nothing is counted as a placeholder', () => {
    const { layer, stage } = setup();
    stage.draw(scene([placeholderActor('a1')]));
    const container = layer.children[0] as Container;
    const graphics = placeholderIn(container);

    const counts = stage.draw(
      scene([sceneActor('a1', { sprites: [SPRITE_COMMAND] })]),
    );

    expect(counts).toStrictEqual({
      actors: 1,
      sprites: 1,
      bitmaps: 0,
      placeholders: 0,
      placeholderAlpha: placeholderAlpha(0),
      badges: 0,
    });
    expect(graphics?.destroyed).toBe(true);
    expect(layer.children[0]).toBe(container);
    expect(layoutOf(container)).toStrictEqual(['mask', 'sprite']);

    // And into the placeholder again: a new Graphics.
    stage.draw(scene([placeholderActor('a1')]));
    const again = placeholderIn(container);
    expect(again).toBeDefined();
    expect(again).not.toBe(graphics);
    expect(layoutOf(container)).toStrictEqual(['mask', 'placeholder']);
  });

  it('資源: going into the placeholder, its sprites are destroyed and its bitmap released as in 3.6 (sprite and texture destroyed, ImageBitmap closed once); its emitters, gone from particles.ts, take their containers with them', () => {
    const { layer, stage, emitters } = setupParticles();
    const image = new FakeImageBitmap();
    emitters.set('a1', [emitter(1, 'sparkle', [particle()])]);
    stage.draw(
      scene([
        sceneActor('a1', {
          sprites: [SPRITE_COMMAND, SPRITE_COMMAND],
          bitmap: bitmapOf(image),
        }),
      ]),
    );
    const container = layer.children[0] as Container;
    const [sprite] = container.children.filter(
      (child): child is Sprite =>
        child instanceof Sprite && child.texture.source.resource !== image,
    );
    const bitmapSprite = spriteOf(container, image);
    const bitmapSource = bitmapSprite?.texture.source;
    const [emitterNode] = emittersIn(container);

    // particles.ts has nothing for an actor in the placeholder (main.ts
    // leaves it out of sync()).
    emitters.set('a1', []);
    const counts = stage.draw(scene([placeholderActor('a1')]));

    expect(counts).toStrictEqual({
      actors: 1,
      sprites: 0,
      bitmaps: 0,
      placeholders: 1,
      placeholderAlpha: placeholderAlpha(0),
      badges: 0,
    });
    expect(sprite?.destroyed).toBe(true);
    expect(bitmapSprite?.destroyed).toBe(true);
    expect(bitmapSource?.destroyed).toBe(true);
    expect(image.closes).toBe(1);
    expect(stage.bitmapShown('a1')).toBe(false);
    expect(emitterNode?.destroyed).toBe(true);
    expect(stage.particleCounts()).toStrictEqual({ emitters: 0, particles: 0 });
    expect(layoutOf(container)).toStrictEqual(['mask', 'placeholder']);

    stage.draw(scene([placeholderActor('a1')]));
    expect(image.closes).toBe(1);
  });

  it('加入與移出: the actor gone takes its placeholder with it, the others keep theirs; destroy() destroys them all', () => {
    const { layer, stage } = setup();
    stage.draw(
      scene([
        placeholderActor('a1'),
        placeholderActor('a2'),
        sceneActor('a3', { sprites: [SPRITE_COMMAND] }),
      ]),
    );
    const [one, two] = (layer.children as Container[]).map(placeholderIn);

    const counts = stage.draw(
      scene([
        placeholderActor('a2'),
        sceneActor('a3', { sprites: [SPRITE_COMMAND] }),
      ]),
    );

    expect(counts).toMatchObject({ actors: 2, placeholders: 1 });
    expect(one?.destroyed).toBe(true);
    expect(two?.destroyed).toBe(false);
    stage.destroy();
    expect(two?.destroyed).toBe(true);
  });
});

// Story 3.8: the name tags and state badges.

/** A badge for probe-one: name 'gundam-pet', working, exact. */
function badgeOf(overrides: Partial<SceneBadge> = {}): SceneBadge {
  return {
    name: 'gundam-pet',
    state: 'working',
    confidence: 'exact',
    anchor: { x: 0, y: -124 },
    ...overrides,
  };
}

/**
 * The size of badgeOf()'s tag with the fake canvases' measuring
 * (FAKE_CHAR_WIDTH DIP a code point): its name, gundam-pet, is its widest
 * line; two lines high.
 */
const TAG = {
  width: 10 * FAKE_CHAR_WIDTH + BADGE_PADDING_X * 2,
  height: BADGE_PADDING_Y * 2 + BADGE_LINE_HEIGHT * 2,
};

/** A pixi-stage drawing name tags on fake canvases. */
function setupBadges() {
  const layer = new Container();
  const canvases = fakeBadgeCanvases();
  const badges = stageBadges(canvases);
  const sprite = textureOf();
  const stage = createPixiStage(
    layer,
    () => sprite,
    {
      emittersOf: () => [],
      textures: particleTextures(fakeCanvases().create),
    },
    badges,
  );
  return { layer, stage, badges, canvases };
}

/** A name wider than BADGE_NAME_MAX_WIDTH: its tag is as wide as one gets. */
const WIDE_NAME = 'x'.repeat(
  Math.ceil(BADGE_NAME_MAX_WIDTH / FAKE_CHAR_WIDTH) + 10,
);

/** One level up: a tag's height and the gap. */
const LEVEL = TAG.height + BADGE_STACK_GAP;

/** A tag's box, as stackBadges has it. */
interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Each tag's box, in the badge layer's order. */
function boxesOf(badges: StageBadges): Box[] {
  return tagsIn(badges).map((tag) => ({
    left: tag.x,
    top: tag.y,
    width: tag.width,
    height: tag.height,
  }));
}

/**
 * Where `box`'s tag is wanted, right above the anchor of an actor at `x`
 * (y 800, anchor 0, -124, 大小 1).
 */
function wantedAt(
  x: number,
  box: Box | undefined,
): { left: number; top: number } {
  const width = box?.width ?? NaN;
  return { left: x - width / 2, top: 800 - 124 - TAG.height };
}

/** Whether two boxes overlap (touching edges do not). */
function overlap(a: Box | undefined, b: Box | undefined): boolean {
  if (a === undefined || b === undefined) {
    return true;
  }
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

/** The tags in the badge layer, in order. */
function tagsIn(badges: StageBadges): Sprite[] {
  return badges.layer.children as Sprite[];
}

describe('I/O matrix', () => {
  it('出現: an actor with a badge has one Sprite in the badge layer, its bottom middle at its position plus anchor × 大小, at the tag’s size in DIP whatever its 大小, not in its container (so neither scaled nor clipped); counted as a badge', () => {
    const { layer, stage, badges } = setupBadges();

    const counts = stage.draw(
      scene(
        [
          sceneActor('a1', {
            x: 100,
            y: 800,
            scale: 1.5,
            sprites: [SPRITE_COMMAND],
            badge: badgeOf(),
          }),
        ],
        2,
      ),
    );

    expect(counts).toMatchObject({ actors: 1, sprites: 1, badges: 1 });
    const [tag] = tagsIn(badges);
    expect(tag).toBeInstanceOf(Sprite);
    expect(tag?.parent).toBe(badges.layer);
    expect([tag?.anchor.x, tag?.anchor.y]).toStrictEqual([0, 0]);
    expect([tag?.scale.x, tag?.scale.y]).toStrictEqual([1, 1]);
    expect([tag?.width, tag?.height]).toStrictEqual([TAG.width, TAG.height]);
    // Bottom middle: x 100 + 0 × 1.5, y 800 - 124 × 1.5.
    expect([
      (tag?.x ?? 0) + TAG.width / 2,
      (tag?.y ?? 0) + TAG.height,
    ]).toStrictEqual([100, 800 - 124 * 1.5]);
    // The actor's container holds its mask and sprite only.
    const container = layer.children[0] as Container;
    expect(container.children).toHaveLength(2);
    expect(container.children).not.toContain(tag);
    expect(tag?.mask ?? null).toBeNull();
  });

  it('出現: an anchor off the middle is scaled by 大小 too: the bottom middle at x + anchor.x × 大小, y + anchor.y × 大小', () => {
    const { stage, badges } = setupBadges();
    stage.draw(
      scene([
        sceneActor('a1', {
          x: 100,
          y: 800,
          scale: 1.5,
          badge: badgeOf({ anchor: { x: 10, y: -124 } }),
        }),
      ]),
    );

    const [tag] = tagsIn(badges);
    expect([
      (tag?.x ?? 0) + TAG.width / 2,
      (tag?.y ?? 0) + TAG.height,
    ]).toStrictEqual([100 + 10 * 1.5, 800 - 124 * 1.5]);
  });

  it('名牌互疊: two neighbours (centres 96 DIP apart) whose tags are wider than that: the first stays right above its anchor, the second goes up one level (its height and BADGE_STACK_GAP); neither overlaps the other', () => {
    const { stage, badges } = setupBadges();
    stage.draw(
      scene([
        sceneActor('a1', { x: 1000, badge: badgeOf({ name: WIDE_NAME }) }),
        sceneActor('a2', { x: 1096, badge: badgeOf({ name: WIDE_NAME }) }),
      ]),
    );

    const [one, two] = boxesOf(badges);
    expect(one?.width).toBeGreaterThan(96);
    expect(one).toMatchObject(wantedAt(1000, one));
    expect(two).toMatchObject({
      left: wantedAt(1096, two).left,
      top: wantedAt(1096, two).top - LEVEL,
    });
    expect(overlap(one, two)).toBe(false);
  });

  it('名牌互疊: two tags far apart both stay right above their anchors', () => {
    const { stage, badges } = setupBadges();
    stage.draw(
      scene([
        sceneActor('a1', { x: 600, badge: badgeOf({ name: WIDE_NAME }) }),
        sceneActor('a2', { x: 1000, badge: badgeOf({ name: WIDE_NAME }) }),
      ]),
    );

    const [one, two] = boxesOf(badges);
    expect(one).toMatchObject(wantedAt(600, one));
    expect(two).toMatchObject(wantedAt(1000, two));
  });

  it('名牌互疊: three in a row 96 DIP apart: levels 0, 1, 0 (the third clears the first); packed closer, 0, 1, 2; no two overlap either way', () => {
    const { stage, badges } = setupBadges();
    const row = (gap: number) => {
      stage.draw(
        scene(
          [0, 1, 2].map((index) =>
            sceneActor(`a${index}`, {
              x: 800 + index * gap,
              badge: badgeOf({ name: WIDE_NAME }),
            }),
          ),
        ),
      );
      const boxes = boxesOf(badges);
      for (const [a, b] of [
        [0, 1],
        [0, 2],
        [1, 2],
      ] as const) {
        expect(overlap(boxes[a], boxes[b])).toBe(false);
      }
      return boxes.map(
        (box, index) =>
          (wantedAt(800 + index * gap, box).top - (box?.top ?? NaN)) / LEVEL,
      );
    };

    expect(row(96)).toStrictEqual([0, 1, 0]);
    expect(row(30)).toStrictEqual([0, 1, 2]);
  });

  it('邊緣: the rightmost actor (its origin 64 DIP from the right edge) has its wide tag moved left to end at the canvas’s right edge; one at the left edge starts at 0; one whose tag would go above the canvas has its top at 0', () => {
    const { stage, badges } = setupBadges();
    stage.draw(
      scene([
        sceneActor('a1', {
          x: CANVAS_WIDTH - 64,
          badge: badgeOf({ name: WIDE_NAME }),
        }),
        sceneActor('a2', { x: 20, badge: badgeOf({ name: WIDE_NAME }) }),
        sceneActor('a3', { x: 700, y: 100, badge: badgeOf() }),
      ]),
    );

    const [right, left, high] = boxesOf(badges);
    expect((right?.width ?? 0) / 2).toBeGreaterThan(64);
    expect(right).toMatchObject({
      left: CANVAS_WIDTH - (right?.width ?? NaN),
      top: wantedAt(0, right).top,
    });
    expect(left).toMatchObject({ left: 0, top: wantedAt(0, left).top });
    expect(high?.top).toBe(0);
  });

  it('不接滑鼠: the badge layer and its tags take no PixiJS events', () => {
    const { stage, badges } = setupBadges();
    stage.draw(scene([sceneActor('a1', { badge: badgeOf() })]));

    expect(badges.layer.eventMode).toBe('none');
    expect(badges.layer.interactiveChildren).toBe(false);
    expect(tagsIn(badges)[0]?.eventMode).toBe('none');
  });

  it('解析度: the tag’s texture is painted on its own canvas at the scene’s resolution (the canvas display’s scaleFactor), its source’s resolution, so it is drawn at its size in DIP, sampled linearly', () => {
    const { stage, badges, canvases } = setupBadges();
    stage.draw(scene([sceneActor('a1', { badge: badgeOf() })], 2));

    const [tag] = tagsIn(badges);
    const [made] = canvases.made;
    expect(canvases.made).toHaveLength(1);
    expect([made?.canvas.width, made?.canvas.height]).toStrictEqual([
      TAG.width * 2,
      TAG.height * 2,
    ]);
    const source = tag?.texture.source;
    expect(source).toBeInstanceOf(ImageSource);
    expect(source?.resource).toBe(made?.canvas);
    expect(source?.resolution).toBe(2);
    expect(source?.scaleMode).toBe(TEXTURE_SCALE_MODE);
    expect([tag?.texture.width, tag?.texture.height]).toStrictEqual([
      TAG.width,
      TAG.height,
    ]);
    expect(made?.calls[0]).toBe('setTransform 2 0 0 2 0 0');
    expect(made?.calls.join('\n')).toContain('fillText "gundam-pet"');
  });

  it('解析度: the tag’s top-left corner is on the nearest whole device pixel, so its text stays sharp', () => {
    const { stage, badges } = setupBadges();
    // The exact corner: its bottom middle at x, y - 124.
    const exact = [100.3 - TAG.width / 2, 800.2 - 124 - TAG.height];

    const cornerAt = (resolution: number): number[] => {
      stage.draw(
        scene(
          [sceneActor('a1', { x: 100.3, y: 800.2, badge: badgeOf() })],
          resolution,
        ),
      );
      const [tag] = tagsIn(badges);
      return [tag?.x ?? NaN, tag?.y ?? NaN];
    };

    // At 1, whole DIP: x.3 and y.2 rounded down.
    expect(cornerAt(1)).toStrictEqual(exact.map(Math.round));
    for (const resolution of [1.5, 2]) {
      cornerAt(resolution).forEach((value, index) => {
        const pixels = value * resolution;
        expect(Math.abs(pixels - Math.round(pixels))).toBeLessThan(1e-9);
        expect(
          Math.abs(value - (exact[index] ?? NaN)) * resolution,
        ).toBeLessThanOrEqual(0.5);
      });
    }
  });

  it('推測: an inferred state’s tag is a texture of its own, painted otherwise (a ring, not a dot, and ？ after the state’s name)', () => {
    const { stage, badges, canvases } = setupBadges();
    stage.draw(
      scene([
        sceneActor('a1', { badge: badgeOf() }),
        sceneActor('a2', { badge: badgeOf({ confidence: 'inferred' }) }),
      ]),
    );

    const [exact, inferred] = tagsIn(badges);
    expect(exact?.texture).not.toBe(inferred?.texture);
    const [one, two] = canvases.made.map((each) => each.calls.join('\n'));
    expect(one).not.toContain('stroke');
    expect(one).toContain('fillText "工作中"');
    expect(two).toMatch(/^stroke /m);
    expect(two).toContain('fillText "工作中？"');
  });

  it('佔位: an actor drawn as the placeholder has its tag too; counted as a placeholder and a badge', () => {
    const { stage, badges } = setupBadges();
    const counts = stage.draw(
      scene([placeholderActor('a1', { badge: badgeOf({ state: 'error' }) })]),
    );

    expect(counts).toMatchObject({ actors: 1, placeholders: 1, badges: 1 });
    expect(tagsIn(badges)).toHaveLength(1);
  });

  it('關閉: an actor with no badge (its badges fixed parameter off) has no tag; one with an empty list has one', () => {
    const { stage, badges } = setupBadges();
    const counts = stage.draw(
      scene([
        sceneActor('a1', { sprites: [SPRITE_COMMAND] }),
        sceneActor('a2', { badge: badgeOf() }),
      ]),
    );

    expect(counts).toMatchObject({ actors: 2, badges: 1 });
    expect(tagsIn(badges)).toHaveLength(1);
    expect(badges.textures.count()).toBe(1);
  });

  it('重疊: the tags are in the badge layer, in the scene’s order (a lower actor’s above), not among the actors’ containers; reordered as the scene says', () => {
    const { layer, stage, badges } = setupBadges();
    const back = sceneActor('a1', { y: 700, badge: badgeOf({ name: 'one' }) });
    const front = sceneActor('a2', { y: 800, badge: badgeOf({ name: 'two' }) });

    stage.draw(scene([back, front]));
    const [one, two] = tagsIn(badges);
    stage.draw(
      scene([
        { ...front, y: 600 },
        { ...back, y: 900 },
      ]),
    );

    expect(layer.children.every((child) => !(child instanceof Sprite))).toBe(
      true,
    );
    expect(tagsIn(badges)).toStrictEqual([two, one]);
    expect([one?.destroyed, two?.destroyed]).toStrictEqual([false, false]);
  });

  it('同內容共用: tags of the same content share one texture, made on one canvas', () => {
    const { stage, badges, canvases } = setupBadges();
    stage.draw(
      scene([
        sceneActor('a1', { badge: badgeOf() }),
        sceneActor('a2', { badge: badgeOf({ anchor: { x: 0, y: -104 } }) }),
      ]),
    );

    const [one, two] = tagsIn(badges);
    expect(one?.texture).toBe(two?.texture);
    expect(canvases.made).toHaveLength(1);
    expect(badges.textures.count()).toBe(1);
  });

  it('改名: a tag whose name, state or confidence changed shows its new texture at the next draw, the same Sprite; the old texture, used by no tag, is destroyed with its source', () => {
    const { stage, badges } = setupBadges();
    stage.draw(scene([sceneActor('a1', { badge: badgeOf() })]));
    const [tag] = tagsIn(badges);
    const before = tag?.texture;
    const source = before?.source;

    for (const changes of [
      { name: 'renamed' },
      { name: 'renamed', state: 'done' as const },
      {
        name: 'renamed',
        state: 'done' as const,
        confidence: 'inferred' as const,
      },
    ]) {
      const shown = tag?.texture;
      stage.draw(scene([sceneActor('a1', { badge: badgeOf(changes) })]));
      expect(tagsIn(badges)).toStrictEqual([tag]);
      expect(tag?.texture).not.toBe(shown);
      expect(shown?.destroyed).toBe(true);
    }
    expect(before?.destroyed).toBe(true);
    expect(source?.destroyed).toBe(true);
    expect(badges.textures.count()).toBe(1);
  });

  it('離場: an actor gone takes its tag with it; a texture another tag still uses stays; once no tag uses it, it is destroyed with its source', () => {
    const { stage, badges } = setupBadges();
    const both = [
      sceneActor('a1', { badge: badgeOf() }),
      sceneActor('a2', { badge: badgeOf() }),
    ];
    stage.draw(scene(both));
    const [one, two] = tagsIn(badges);
    const texture = one?.texture;
    const source = texture?.source;

    const counts = stage.draw(scene([both[1] as SceneActor]));

    expect(counts.badges).toBe(1);
    expect(one?.destroyed).toBe(true);
    expect(tagsIn(badges)).toStrictEqual([two]);
    expect(texture?.destroyed).toBe(false);

    expect(stage.draw(scene([])).badges).toBe(0);
    expect(two?.destroyed).toBe(true);
    expect(tagsIn(badges)).toStrictEqual([]);
    expect(texture?.destroyed).toBe(true);
    expect(source?.destroyed).toBe(true);
    expect(badges.textures.count()).toBe(0);
  });

  it('關閉: an actor whose badge goes off (still drawn) has its tag destroyed, and its texture with no other tag', () => {
    const { stage, badges } = setupBadges();
    stage.draw(scene([sceneActor('a1', { badge: badgeOf() })]));
    const [tag] = tagsIn(badges);

    const counts = stage.draw(scene([sceneActor('a1')]));

    expect(counts).toMatchObject({ actors: 1, badges: 0 });
    expect(tag?.destroyed).toBe(true);
    expect(badges.textures.count()).toBe(0);
  });

  it('換螢幕: a new resolution paints a new texture at it; the old one is destroyed', () => {
    const { stage, badges, canvases } = setupBadges();
    const actors = [sceneActor('a1', { badge: badgeOf() })];
    stage.draw(scene(actors, 2));
    const before = tagsIn(badges)[0]?.texture;

    stage.draw(scene(actors, 1));

    const after = tagsIn(badges)[0]?.texture;
    expect(after?.source.resolution).toBe(1);
    expect(before?.destroyed).toBe(true);
    expect(canvases.made.map(({ canvas }) => canvas.width)).toStrictEqual([
      TAG.width * 2,
      TAG.width,
    ]);
  });

  it('context 還原: the same scene drawn again keeps the same tag and texture (PixiJS uploads it again from its canvas): nothing is destroyed or painted again', () => {
    const { stage, badges, canvases } = setupBadges();
    const actors = [sceneActor('a1', { badge: badgeOf() })];
    stage.draw(scene(actors, 2));
    const [tag] = tagsIn(badges);
    const texture = tag?.texture;

    stage.draw(scene(actors, 2));

    expect(tagsIn(badges)).toStrictEqual([tag]);
    expect(tag?.texture).toBe(texture);
    expect(texture?.destroyed).toBe(false);
    expect(canvases.made).toHaveLength(1);
  });

  it('destroy() destroys the tags and their textures with their sources', () => {
    const { stage, badges } = setupBadges();
    stage.draw(scene([sceneActor('a1', { badge: badgeOf() })]));
    const [tag] = tagsIn(badges);
    const texture = tag?.texture;
    const source = texture?.source;

    stage.destroy();

    expect(tag?.destroyed).toBe(true);
    expect(texture?.destroyed).toBe(true);
    expect(source?.destroyed).toBe(true);
    expect(tagsIn(badges)).toStrictEqual([]);
    expect(badges.textures.count()).toBe(0);
  });
});

describe('the name tags’ textures', () => {
  it('a canvas without a 2D context gives a clear texture, nothing measured (the dot and the padding only), not an error', () => {
    const textures = badgeTextures(
      fakeBadgeCanvases({ noContext: true }).create,
    );

    const badge = textures.get(badgeOf(), 2);

    expect(badge.texture).toBeInstanceOf(Texture);
    expect([badge.width, badge.height]).toStrictEqual([
      BADGE_DOT_RADIUS * 2 + BADGE_DOT_GAP + BADGE_PADDING_X * 2,
      TAG.height,
    ]);
  });

  it('sweep() keeps what was asked for since the last sweep and destroys the rest; the same content asked again is the same texture', () => {
    const textures = badgeTextures(fakeBadgeCanvases().create);
    const one = textures.get(badgeOf(), 1);
    const two = textures.get(badgeOf({ name: 'other' }), 1);
    expect(textures.get(badgeOf(), 1)).toBe(one);
    textures.sweep();
    expect(textures.count()).toBe(2);

    textures.get(badgeOf(), 1);
    textures.sweep();

    expect(textures.count()).toBe(1);
    expect(one.texture.destroyed).toBe(false);
    expect(two.texture.destroyed).toBe(true);
    textures.destroy();
    expect(one.texture.destroyed).toBe(true);
    expect(textures.count()).toBe(0);
  });
});
