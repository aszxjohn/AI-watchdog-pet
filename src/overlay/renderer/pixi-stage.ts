/**
 * overlay/renderer (Story 3.6): draws a Scene (scene.ts) with PixiJS, on
 * the overlay's one canvas, and makes the packs' textures. PixiJS runs
 * under Node too, so this is unit-tested there (test/overlay/pixi-stage);
 * only loading an image needs the browser, and main.ts passes that in.
 *
 * - Each drawn actor is one Container at its position and 大小, clipped by
 *   a rectangle mask of its `bounds` (a child of it, so it moves and
 *   scales with it), holding one Sprite per sprite command, top-left
 *   anchored. Containers and sprites are kept from frame to frame and
 *   reused; an actor no longer drawn has its container destroyed (its
 *   textures stay with the texture store).
 * - Actors are put in the scene's order, bottom first.
 * - A sprite whose texture is not there (still loading, or failed) is
 *   hidden for that frame.
 * - The textures (pixiTextures): images main.ts loads with `Image` from
 *   `pack://` (crossorigin, which the `pack` scheme's corsEnabled
 *   answers), each made into its own ImageSource and Texture, sampled
 *   linearly (stated, not left to PixiJS's default; the author docs say
 *   so, and that spritesheet frames need transparent padding between
 *   them), and spritesheet frames from PixiJS's Spritesheet over it, all
 *   outside PixiJS's global cache (textures.ts).
 */
import {
  Container,
  Graphics,
  type ImageResource,
  ImageSource,
  Sprite,
  Spritesheet,
  type SpritesheetData,
  Texture,
} from 'pixi.js';
import type { PackSpritesheet } from '../../shared/pack-api';
import type { Scene } from './scene';
import type { TextureBackend } from './textures';

/** How the packs' textures are sampled (author docs, section 8.1). */
export const TEXTURE_SCALE_MODE = 'linear';

/** An image the browser loaded (an `HTMLImageElement` in the overlay). */
export interface LoadedImage {
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

/** The frames of `sheet` over `texture`, by name, cached nowhere. */
export function sheetTextures(
  texture: Texture,
  sheet: PackSpritesheet,
): ReadonlyMap<string, Texture> {
  const data: SpritesheetData = {
    frames: sheet.frames,
    meta: { scale: 1 },
  };
  return new Map(
    Object.entries(new Spritesheet({ texture, data }).parseSync()),
  );
}

/**
 * How the overlay makes textures: PixiJS's, from the images `loadImage`
 * gives (main.ts loads them with `Image`).
 */
export function pixiTextures<I extends LoadedImage>(
  loadImage: (url: string) => Promise<I>,
): TextureBackend<I, Texture> {
  return {
    loadImage,
    sizeOf: (image) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }),
    imageTexture: (image) =>
      new Texture({
        source: new ImageSource({
          // An HTMLImageElement in the overlay, which PixiJS takes.
          resource: image as unknown as ImageResource,
          scaleMode: TEXTURE_SCALE_MODE,
        }),
      }),
    sheetTextures,
    destroy: (texture, base) => {
      texture.destroy(base);
    },
  };
}

/** One actor's display objects. */
interface ActorNode {
  readonly container: Container;
  readonly mask: Graphics;
  readonly sprites: Sprite[];
  /** The bounds the mask was drawn for. */
  bounds: string;
}

/** What one draw() put on screen. */
export interface StageCounts {
  readonly actors: number;
  readonly sprites: number;
}

export interface PixiStage {
  /** Puts `scene` on screen (it shows at the next render). */
  draw(scene: Scene): StageCounts;
}

export function createPixiStage(
  layer: Container,
  texture: (
    packId: string,
    version: string,
    asset: string,
    frame: string | undefined,
  ) => Texture | undefined,
): PixiStage {
  const nodes = new Map<string, ActorNode>();

  function nodeOf(actorId: string): ActorNode {
    let node = nodes.get(actorId);
    if (node === undefined) {
      const container = new Container();
      const mask = new Graphics();
      container.addChild(mask);
      container.mask = mask;
      node = { container, mask, sprites: [], bounds: '' };
      nodes.set(actorId, node);
    }
    return node;
  }

  return {
    draw(scene) {
      const drawn = new Set<string>();
      const order: Container[] = [];
      let sprites = 0;
      for (const actor of scene.actors) {
        drawn.add(actor.actorId);
        const node = nodeOf(actor.actorId);
        node.container.position.set(actor.x, actor.y);
        node.container.scale.set(actor.scale);
        const { x, y, width, height } = actor.bounds;
        const bounds = `${x} ${y} ${width} ${height}`;
        if (node.bounds !== bounds) {
          node.mask.clear().rect(x, y, width, height).fill(0xffffff);
          node.bounds = bounds;
        }
        actor.sprites.forEach((command, index) => {
          let sprite = node.sprites[index];
          if (sprite === undefined) {
            sprite = new Sprite();
            sprite.anchor.set(0);
            node.container.addChild(sprite);
            node.sprites.push(sprite);
          }
          const shown = texture(
            actor.packId,
            actor.version,
            command.asset,
            command.frame,
          );
          if (shown === undefined) {
            sprite.visible = false;
            return;
          }
          sprite.texture = shown;
          sprite.visible = true;
          sprite.position.set(command.x, command.y);
          sprite.rotation = command.rotation;
          sprite.scale.set(command.scaleX, command.scaleY);
          sprite.alpha = command.alpha;
          sprites += 1;
        });
        for (const extra of node.sprites.splice(actor.sprites.length)) {
          extra.destroy();
        }
        order.push(node.container);
      }
      for (const [actorId, node] of nodes) {
        if (!drawn.has(actorId)) {
          node.container.destroy({ children: true });
          nodes.delete(actorId);
        }
      }
      // Rebuilt only when the order changed: PixiJS redoes its render
      // instructions after a change of children.
      const children = layer.children;
      if (
        children.length !== order.length ||
        order.some((container, index) => children[index] !== container)
      ) {
        layer.removeChildren();
        if (order.length > 0) {
          layer.addChild(...order);
        }
      }
      return { actors: order.length, sprites };
    },
  };
}
