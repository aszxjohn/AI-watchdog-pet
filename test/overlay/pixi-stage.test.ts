/**
 * overlay/renderer/pixi-stage (Story 3.6), with PixiJS itself under Node
 * (no renderer, no DOM): the display objects a Scene becomes, and the
 * textures the backend makes (spritesheet frames, sampling).
 */
import { Container, Graphics, Sprite, Texture, TextureSource } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  createPixiStage,
  pixiTextures,
  sheetTextures,
  TEXTURE_SCALE_MODE,
} from '../../src/overlay/renderer/pixi-stage';
import type { Scene, SceneActor } from '../../src/overlay/renderer/scene';

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
  const stage = createPixiStage(layer, (_packId, _version, asset, frame) =>
    textures.get(frame === undefined ? asset : `${asset}#${frame}`),
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

    expect(counts).toStrictEqual({ actors: 2, sprites: 2 });
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

    expect(counts).toStrictEqual({ actors: 1, sprites: 0 });
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
