/**
 * overlay/renderer/pixi-stage (Story 3.6), with PixiJS itself under Node
 * (no renderer, no DOM): the display objects a Scene becomes, and the
 * textures the backend makes (spritesheet frames, sampling).
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
import { describe, expect, it } from 'vitest';
import type {
  EmitterView,
  ParticleView,
} from '../../src/overlay/renderer/particles';
import {
  bitmapTexture,
  createPixiStage,
  type PaintCanvas,
  type PaintContext,
  PARTICLE_TEXTURE_SIZE,
  particleTextures,
  pixiTextures,
  sheetTextures,
  type StageParticles,
  TEXTURE_SCALE_MODE,
} from '../../src/overlay/renderer/pixi-stage';
import type {
  Scene,
  SceneActor,
  SceneBitmap,
} from '../../src/overlay/renderer/scene';
import {
  PARTICLE_PRESETS,
  type ParticlePreset,
} from '../../src/shared/pack-api';
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

function scene(actors: SceneActor[]): Scene {
  return { actors, areas: [], missing: new Set() };
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

    expect(counts).toStrictEqual({ actors: 2, sprites: 2, bitmaps: 0 });
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

    expect(counts).toStrictEqual({ actors: 1, sprites: 0, bitmaps: 0 });
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
  const stage = createPixiStage(layer, () => sprite, particles);
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

    expect(counts).toStrictEqual({ actors: 1, sprites: 0, bitmaps: 0 });
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

    expect(counts).toStrictEqual({ actors: 1, sprites: 1, bitmaps: 1 });
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
