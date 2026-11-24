/**
 * overlay/renderer (Stories 3.6, 3.7, 3.8): draws a Scene (scene.ts) with
 * PixiJS, on the overlay's one canvas, and makes the packs' textures.
 * PixiJS runs under Node too, so this is unit-tested there
 * (test/overlay/pixi-stage); only loading an image needs the browser, and
 * main.ts passes that in.
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
 * - A bitmap (Story 3.6's last part): one more Sprite in the actor's
 *   container, above its sprites and below its particles, top-left
 *   anchored at the command's `x`, `y` and sized to its `width` x
 *   `height`. Its texture is made from the ImageBitmap itself
 *   (bitmapTexture: its own ImageSource, sampled linearly, outside
 *   PixiJS's global cache and its texture garbage collection, so PixiJS
 *   can upload it again once a lost WebGL context is back). An actor's
 *   bitmap replaced by a new image, once the new one is put up, gone from
 *   its draw, or the actor gone: the old texture is destroyed and its
 *   ImageBitmap closed. An image shown is never closed; one closed (by
 *   this stage) is never shown again; each is closed once. bitmapShown()
 *   says whether an actor has a bitmap texture up (scene.ts gives it the
 *   mouse then).
 * - Particles (Story 3.6's second last part): each emitter particles.ts
 *   runs for a drawn actor is one ParticleContainer in that actor's
 *   container, so it moves, scales and is clipped with it, above all its
 *   sprites, emitters in the order they started. The container's bounds
 *   area is the actor's `bounds` (PixiJS does not work a
 *   ParticleContainer's bounds out). Each particle is one Particle,
 *   centre-anchored, sized, turned, coloured and faded as particles.ts
 *   says; containers and particles are reused from frame to frame. An
 *   emitter gone from particles.ts has its container destroyed.
 *   particleCounts() says how many containers and particles the last
 *   draw() put on screen (main.ts shows them, the e2e tests read them).
 * - The placeholder (Story 3.7): an actor drawn as the placeholder has one
 *   more Graphics in its container (so it takes its place, 大小 and bounds
 *   mask), right after the mask (it has no sprite or bitmap then, and
 *   particles.ts no emitter for it), filled with placeholder.ts's figure
 *   for its `hitbox` in PLACEHOLDER_COLOR. It is made when the actor goes
 *   into the placeholder, kept from frame to frame and drawn again only
 *   when the hitbox changes; its opacity follows placeholderAlpha() of the
 *   time draw() has been given (the render loop's: none, and it stands
 *   still), and draw() returns that opacity (main.ts shows it, the e2e
 *   tests read it). It is destroyed when the actor is drawn otherwise
 *   again, or is gone.
 * - The name tags and state badges (Story 3.8): each actor with a `badge`
 *   has one Sprite in the badge layer (a Container main.ts puts above the
 *   actors' layer, which takes no mouse), in the scene's order, so every
 *   tag is above every character and a lower actor's tag above a higher
 *   one's. Its bottom middle is at the actor's position plus its `anchor`
 *   × its 大小, its top-left corner on a whole device pixel (the scene's
 *   `resolution`), so its text stays sharp; it is not scaled by 大小 nor
 *   clipped by `bounds`. It leaves that place only to stay inside the
 *   canvas (the scene's `canvasWidth`; its top not above the canvas's) or,
 *   placed in the scene's order, to move up a level at a time while it
 *   would cover a tag placed before it (badges.ts's stackBadges). Its texture (badgeTextures) is badges.ts's
 *   painting on a 2D canvas main.ts makes, `resolution` device pixels to
 *   the DIP (its source's resolution, so it is drawn at its size in DIP),
 *   sampled linearly, outside PixiJS's global cache, and made once per
 *   content (name, state, confidence, resolution): actors showing the same
 *   share it. Each draw() destroys the textures no tag used in it, with
 *   their sources; a tag whose content changed takes its new texture at
 *   once. The sprites are kept from frame to frame; an actor no longer
 *   drawn, or drawn without a badge, has its sprite destroyed.
 *   draw() counts the tags it put up (`badges`).
 * - Each preset's texture (particleTextures) is painted in white, from
 *   its PresetDef's shape, on a 2D canvas main.ts makes (not a render
 *   texture: PixiJS uploads the canvas again once a lost WebGL context is
 *   back), made the first time it is needed, outside PixiJS's global
 *   cache, and shared by every particle of that preset; destroy() destroys
 *   them.
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
  Particle,
  ParticleContainer,
  type ParticleProperties,
  Rectangle,
  Sprite,
  Spritesheet,
  type SpritesheetData,
  Texture,
} from 'pixi.js';
import type { ImageBitmapLike } from '../../shared/draw-size';
import type {
  LocalBox,
  PackSpritesheet,
  ParticlePreset,
} from '../../shared/pack-api';
import {
  type BadgeBox,
  type BadgeCanvas,
  type BadgeContent,
  badgeKey,
  badgeLayout,
  measureWith,
  paintBadge,
  stackBadges,
} from './badges';
import {
  type EmitterView,
  PARTICLE_PRESET_DEFS,
  type ParticleShape,
  type ParticleView,
} from './particles';
import {
  PLACEHOLDER_COLOR,
  PLACEHOLDER_PERIOD_MS,
  placeholderAlpha,
  placeholderShape,
} from './placeholder';
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

/**
 * A texture of `image` (a bitmap a pack painted, Story 3.6's last part):
 * its own ImageSource, sampled linearly, cached nowhere, and never
 * unloaded by PixiJS's texture garbage collection (ImageSource's
 * constructor turns that on whatever its options say, so it is turned off
 * after).
 */
export function bitmapTexture(image: ImageBitmapLike): Texture {
  const source = new ImageSource({
    // An ImageBitmap in the overlay, which PixiJS takes.
    resource: image as unknown as ImageResource,
    scaleMode: TEXTURE_SCALE_MODE,
    autoGarbageCollect: false,
  });
  source.autoGarbageCollect = false;
  return new Texture({ source });
}

/** The width and height of a preset's texture, in pixels. */
export const PARTICLE_TEXTURE_SIZE = 32;

/** A canvas gradient, as far as painting a preset's texture goes. */
export interface PaintGradient {
  addColorStop(offset: number, color: string): void;
}

/**
 * The parts of a 2D canvas context (CanvasRenderingContext2D in the
 * overlay) a preset's texture is painted with.
 */
export interface PaintContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
  ): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): PaintGradient;
}

/** A canvas (an HTMLCanvasElement in the overlay) to paint a texture on. */
export interface PaintCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): PaintContext | null;
}

/** A radial fade from white at `stops`' offsets, filling the texture. */
function paintGlow(
  context: PaintContext,
  stops: readonly (readonly [offset: number, alpha: number])[],
): void {
  const half = PARTICLE_TEXTURE_SIZE / 2;
  const gradient = context.createRadialGradient(
    half,
    half,
    0,
    half,
    half,
    half,
  );
  for (const [offset, alpha] of stops) {
    gradient.addColorStop(offset, `rgba(255, 255, 255, ${alpha})`);
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, PARTICLE_TEXTURE_SIZE, PARTICLE_TEXTURE_SIZE);
}

/** Paints `shape` in white on a PARTICLE_TEXTURE_SIZE square canvas. */
export function paintParticle(
  context: PaintContext,
  shape: ParticleShape,
): void {
  const size = PARTICLE_TEXTURE_SIZE;
  const half = size / 2;
  switch (shape) {
    case 'spark': {
      // A glowing point with a four-pointed star over it.
      paintGlow(context, [
        [0, 1],
        [0.3, 0.6],
        [1, 0],
      ]);
      const arm = half - 1;
      const waist = 2;
      context.fillStyle = 'rgba(255, 255, 255, 0.9)';
      context.beginPath();
      context.moveTo(half, half - arm);
      context.lineTo(half + waist, half - waist);
      context.lineTo(half + arm, half);
      context.lineTo(half + waist, half + waist);
      context.lineTo(half, half + arm);
      context.lineTo(half - waist, half + waist);
      context.lineTo(half - arm, half);
      context.lineTo(half - waist, half - waist);
      context.closePath();
      context.fill();
      return;
    }
    case 'puff':
      // Soft all the way to its edge.
      paintGlow(context, [
        [0, 1],
        [0.5, 0.5],
        [1, 0],
      ]);
      return;
    case 'square':
      // A clear pixel or two round it: its edges stay straight when it turns.
      context.fillStyle = '#ffffff';
      context.fillRect(2, 2, size - 4, size - 4);
      return;
    case 'bubble':
      // A ring, faintly filled, with a highlight up on the left.
      context.fillStyle = 'rgba(255, 255, 255, 0.15)';
      context.beginPath();
      context.arc(half, half, half - 3, 0, 2 * Math.PI);
      context.fill();
      context.strokeStyle = '#ffffff';
      context.lineWidth = 3;
      context.beginPath();
      context.arc(half, half, half - 3, 0, 2 * Math.PI);
      context.stroke();
      context.fillStyle = 'rgba(255, 255, 255, 0.9)';
      context.beginPath();
      context.arc(half - 5, half - 5, 3, 0, 2 * Math.PI);
      context.fill();
      return;
  }
}

/** The presets' textures (see the module comment). */
export interface ParticleTextures {
  /** `preset`'s texture, made the first time it is asked for. */
  get(preset: ParticlePreset): Texture;
  /** Destroys every texture made, with its source. */
  destroy(): void;
}

/** The presets' textures, painted on canvases `createCanvas` makes. */
export function particleTextures(
  createCanvas: () => PaintCanvas,
): ParticleTextures {
  const made = new Map<ParticlePreset, Texture>();
  return {
    get(preset) {
      let texture = made.get(preset);
      if (texture === undefined) {
        const canvas = createCanvas();
        canvas.width = PARTICLE_TEXTURE_SIZE;
        canvas.height = PARTICLE_TEXTURE_SIZE;
        const context = canvas.getContext('2d');
        // Without a 2D context the texture stays clear: nothing is drawn.
        if (context !== null) {
          paintParticle(context, PARTICLE_PRESET_DEFS[preset].shape);
        }
        texture = new Texture({
          source: new ImageSource({
            // An HTMLCanvasElement in the overlay, which PixiJS takes.
            resource: canvas as unknown as ImageResource,
            scaleMode: TEXTURE_SCALE_MODE,
          }),
        });
        made.set(preset, texture);
      }
      return texture;
    },
    destroy() {
      for (const texture of made.values()) {
        texture.destroy(true);
      }
      made.clear();
    },
  };
}

/** A name tag's texture (Story 3.8), with the tag's size. */
export interface BadgeTexture {
  readonly texture: Texture;
  /** The tag's size, DIP (badges.ts's layout). */
  readonly width: number;
  readonly height: number;
}

/** The name tags' textures (see the module comment). */
export interface BadgeTextures {
  /**
   * The texture of `content` at `resolution`, made the first time it is
   * asked for (and not swept since), shared by every tag of the same
   * content.
   */
  get(content: BadgeContent, resolution: number): BadgeTexture;
  /**
   * Destroys every texture not asked for since the last sweep(), with its
   * source.
   */
  sweep(): void;
  /** How many textures there are now. */
  count(): number;
  /** Destroys every texture made, with its source. */
  destroy(): void;
}

/** The name tags' textures, painted on canvases `createCanvas` makes. */
export function badgeTextures(createCanvas: () => BadgeCanvas): BadgeTextures {
  const made = new Map<string, BadgeTexture>();
  const asked = new Set<string>();
  return {
    get(content, resolution) {
      const key = badgeKey(content, resolution);
      asked.add(key);
      let badge = made.get(key);
      if (badge === undefined) {
        const canvas = createCanvas();
        const context = canvas.getContext('2d');
        // Without a 2D context nothing is measured or painted: a clear tag.
        const layout = badgeLayout(
          content,
          context === null ? () => 0 : measureWith(context),
        );
        // Sizing the canvas clears it (and its context's state).
        canvas.width = Math.ceil(layout.width * resolution);
        canvas.height = Math.ceil(layout.height * resolution);
        if (context !== null) {
          paintBadge(context, layout, resolution);
        }
        badge = {
          texture: new Texture({
            source: new ImageSource({
              // An HTMLCanvasElement in the overlay, which PixiJS takes.
              resource: canvas as unknown as ImageResource,
              resolution,
              scaleMode: TEXTURE_SCALE_MODE,
            }),
          }),
          width: layout.width,
          height: layout.height,
        };
        made.set(key, badge);
      }
      return badge;
    },
    sweep() {
      for (const [key, badge] of made) {
        if (!asked.has(key)) {
          badge.texture.destroy(true);
          made.delete(key);
        }
      }
      asked.clear();
    },
    count: () => made.size,
    destroy() {
      for (const badge of made.values()) {
        badge.texture.destroy(true);
      }
      made.clear();
      asked.clear();
    },
  };
}

/** Where pixi-stage draws the name tags and state badges (Story 3.8). */
export interface StageBadges {
  /** The badge layer: above the actors' layer, on the same stage. */
  readonly layer: Container;
  /** The tags' textures. */
  readonly textures: BadgeTextures;
}

/** `value` (DIP) on the nearest whole device pixel at `resolution`. */
function onDevicePixel(value: number, resolution: number): number {
  return Math.round(value * resolution) / resolution;
}

/** What pixi-stage draws particles from (Story 3.6). */
export interface StageParticles {
  /** `actorId`'s emitters (particles.ts), oldest first. */
  emittersOf(actorId: string): readonly EmitterView[];
  /** The presets' textures. */
  readonly textures: ParticleTextures;
}

/**
 * What a particle's container works out each frame: where, how big,
 * turned, coloured and faded, all of which change as it lives.
 */
const PARTICLE_PROPERTIES: ParticleProperties & Record<string, boolean> =
  Object.freeze({
    position: true,
    vertex: true,
    rotation: true,
    color: true,
    uvs: false,
  });

/** `box` as a PixiJS rectangle. */
function rectangleOf({ x, y, width, height }: LocalBox): Rectangle {
  return new Rectangle(x, y, width, height);
}

/** Makes `container`'s particles show `views`, reusing what it has. */
function showParticles(
  container: ParticleContainer<Particle>,
  views: readonly ParticleView[],
): void {
  const children = container.particleChildren;
  if (children.length > views.length) {
    container.removeParticles(views.length);
  } else if (children.length < views.length) {
    const added: Particle[] = [];
    for (let i = children.length; i < views.length; i += 1) {
      added.push(
        new Particle({
          texture: container.texture,
          anchorX: 0.5,
          anchorY: 0.5,
        }),
      );
    }
    container.addParticle(...added);
  }
  views.forEach((view, index) => {
    const particle = children[index];
    if (particle === undefined) {
      return;
    }
    const scale = view.size / PARTICLE_TEXTURE_SIZE;
    particle.x = view.x;
    particle.y = view.y;
    particle.scaleX = scale;
    particle.scaleY = scale;
    particle.rotation = view.rotation;
    if (particle.tint !== view.color) {
      particle.tint = view.color;
    }
    particle.alpha = view.alpha;
  });
}

/** An actor's bitmap on screen. */
interface ShownBitmap {
  readonly sprite: Sprite;
  readonly image: ImageBitmapLike;
  readonly texture: Texture;
}

/** One actor's display objects. */
interface ActorNode {
  readonly container: Container;
  readonly mask: Graphics;
  readonly sprites: Sprite[];
  /** Its bitmap, while it has one up. */
  bitmap: ShownBitmap | null;
  /** Its emitters' containers, by EmitterView id, oldest first. */
  readonly emitters: Map<number, ParticleContainer<Particle>>;
  /** The bounds the mask was drawn for. */
  bounds: string;
  /** Its placeholder (Story 3.7), while it is drawn as one. */
  placeholder: Graphics | null;
  /** The hitbox the placeholder was drawn for. */
  placeholderBox: string;
}

/** What one draw() put on screen. */
export interface StageCounts {
  /** Actors, placeholders included. */
  readonly actors: number;
  readonly sprites: number;
  /** Bitmaps (Story 3.6's last part). */
  readonly bitmaps: number;
  /** Actors drawn as the placeholder (Story 3.7). */
  readonly placeholders: number;
  /**
   * The placeholders' opacity this draw() worked out (placeholderAlpha() of
   * the time it has been given), whether or not any was drawn.
   */
  readonly placeholderAlpha: number;
  /** Name tags and state badges (Story 3.8). */
  readonly badges: number;
}

/** The particles one draw() put on screen. */
export interface StageParticleCounts {
  /** ParticleContainers, one per emitter. */
  readonly emitters: number;
  /** Particles in them, all together. */
  readonly particles: number;
}

export interface PixiStage {
  /**
   * Puts `scene` on screen (it shows at the next render), with each drawn
   * actor's particles as they are now, the placeholders' opacity moved on
   * by `dtMs` (the render loop's time since its last frame; 0 by default:
   * none moves).
   */
  draw(scene: Scene, dtMs?: number): StageCounts;
  /** The particles the last draw() put on screen; none before any. */
  particleCounts(): StageParticleCounts;
  /** Whether `actorId` has a bitmap texture up since the last draw(). */
  bitmapShown(actorId: string): boolean;
  /**
   * Destroys every actor's display objects (their bitmaps closed), the
   * name tags, the presets' textures and the tags'.
   */
  destroy(): void;
}

/**
 * Makes `layer`'s children `order`, only when they differ: PixiJS redoes
 * its render instructions after a change of children.
 */
function reorder(layer: Container, order: readonly Container[]): void {
  const children = layer.children;
  if (
    children.length !== order.length ||
    order.some((child, index) => children[index] !== child)
  ) {
    layer.removeChildren();
    if (order.length > 0) {
      layer.addChild(...order);
    }
  }
}

export function createPixiStage(
  layer: Container,
  texture: (
    packId: string,
    version: string,
    asset: string,
    frame: string | undefined,
  ) => Texture | undefined,
  particles: StageParticles,
  badges: StageBadges,
): PixiStage {
  const nodes = new Map<string, ActorNode>();
  /** Each name tag on screen (Story 3.8), by actor id. */
  const tags = new Map<string, Sprite>();
  // The tags take no mouse (canvas-input's areas are the characters').
  badges.layer.eventMode = 'none';
  badges.layer.interactiveChildren = false;
  let particleCounts: StageParticleCounts = { emitters: 0, particles: 0 };
  /** The images this stage has closed: none is shown again or closed twice. */
  const closed = new WeakSet<object>();
  /** The render loop's time draw() has been given, ms (the placeholders'). */
  let elapsedMs = 0;

  function nodeOf(actorId: string): ActorNode {
    let node = nodes.get(actorId);
    if (node === undefined) {
      const container = new Container();
      const mask = new Graphics();
      container.addChild(mask);
      container.mask = mask;
      node = {
        container,
        mask,
        sprites: [],
        bitmap: null,
        emitters: new Map(),
        bounds: '',
        placeholder: null,
        placeholderBox: '',
      };
      nodes.set(actorId, node);
    }
    return node;
  }

  /** Destroys `texture` with its source and closes `image`, once. */
  function release(texture: Texture, image: ImageBitmapLike): void {
    texture.destroy(true);
    if (!closed.has(image)) {
      closed.add(image);
      try {
        image.close();
      } catch {
        // Nothing more to free.
      }
    }
  }

  /** Takes `node`'s bitmap off the screen, released. */
  function dropBitmap(node: ActorNode): void {
    const shown = node.bitmap;
    if (shown === null) {
      return;
    }
    node.bitmap = null;
    shown.sprite.destroy();
    release(shown.texture, shown.image);
  }

  /**
   * `node`'s bitmap as `bitmap` says (none: taken off), above its sprites;
   * whether one is up.
   */
  function drawBitmap(
    node: ActorNode,
    bitmap: Scene['actors'][number]['bitmap'],
  ): boolean {
    if (bitmap === undefined || closed.has(bitmap.image)) {
      dropBitmap(node);
      return false;
    }
    let shown = node.bitmap;
    if (shown === null || shown.image !== bitmap.image) {
      const texture = bitmapTexture(bitmap.image);
      let sprite = shown?.sprite;
      if (sprite === undefined) {
        sprite = new Sprite();
        sprite.anchor.set(0);
        // After the mask and the sprites, under the particles.
        node.container.addChildAt(sprite, 1 + node.sprites.length);
      }
      sprite.texture = texture;
      const before = shown;
      shown = { sprite, image: bitmap.image, texture };
      node.bitmap = shown;
      // The new one is up: the old one goes.
      if (before !== null) {
        release(before.texture, before.image);
      }
    }
    const { sprite } = shown;
    sprite.position.set(bitmap.x, bitmap.y);
    sprite.width = bitmap.width;
    sprite.height = bitmap.height;
    sprite.visible = true;
    return true;
  }

  /** Takes `node`'s placeholder off the screen, destroyed. */
  function dropPlaceholder(node: ActorNode): void {
    const shown = node.placeholder;
    if (shown === null) {
      return;
    }
    node.placeholder = null;
    node.placeholderBox = '';
    shown.destroy();
  }

  /**
   * `node`'s placeholder for `hitbox` (none: taken off), at `alpha`;
   * whether one is up.
   */
  function drawPlaceholder(
    node: ActorNode,
    hitbox: LocalBox | undefined,
    alpha: number,
  ): boolean {
    if (hitbox === undefined) {
      dropPlaceholder(node);
      return false;
    }
    let shown = node.placeholder;
    if (shown === null) {
      shown = new Graphics();
      // After the mask, the sprites and the bitmap (an actor in the
      // placeholder has none left by now), under any particles.
      node.container.addChildAt(
        shown,
        1 + node.sprites.length + (node.bitmap === null ? 0 : 1),
      );
      node.placeholder = shown;
    }
    const { x, y, width, height } = hitbox;
    const box = `${x} ${y} ${width} ${height}`;
    if (node.placeholderBox !== box) {
      const { head, body } = placeholderShape(hitbox);
      shown
        .clear()
        .circle(head.x, head.y, head.radius)
        .fill(PLACEHOLDER_COLOR)
        .roundRect(body.x, body.y, body.width, body.height, body.radius)
        .fill(PLACEHOLDER_COLOR);
      node.placeholderBox = box;
    }
    shown.alpha = alpha;
    return true;
  }

  /** Destroys `node`, its bitmap released first. */
  function destroyNode(node: ActorNode): void {
    dropBitmap(node);
    node.container.destroy({ children: true });
  }

  /**
   * `actor`'s name tag, showing its badge now, at `resolution`, and where
   * it is wanted (see the module comment); stackBadges() places it.
   */
  function drawTag(
    actor: Scene['actors'][number],
    badge: NonNullable<Scene['actors'][number]['badge']>,
    resolution: number,
  ): { readonly tag: Sprite; readonly wanted: BadgeBox } {
    const shown = badges.textures.get(badge, resolution);
    let tag = tags.get(actor.actorId);
    if (tag === undefined) {
      tag = new Sprite();
      tag.anchor.set(0);
      tag.eventMode = 'none';
      tags.set(actor.actorId, tag);
    }
    if (tag.texture !== shown.texture) {
      tag.texture = shown.texture;
    }
    // Its bottom middle at the anchor × 大小, its corner on a device pixel.
    const middle = actor.x + badge.anchor.x * actor.scale;
    const bottom = actor.y + badge.anchor.y * actor.scale;
    return {
      tag,
      wanted: {
        left: onDevicePixel(middle - shown.width / 2, resolution),
        top: onDevicePixel(bottom - shown.height, resolution),
        width: shown.width,
        height: shown.height,
      },
    };
  }

  /**
   * `node`'s emitters as particles.ts has them now, above its sprites;
   * returns how many particles they hold.
   */
  function drawEmitters(
    node: ActorNode,
    actorId: string,
    bounds: LocalBox,
  ): number {
    const kept = new Set<number>();
    let count = 0;
    for (const view of particles.emittersOf(actorId)) {
      kept.add(view.id);
      let emitter = node.emitters.get(view.id);
      if (emitter === undefined) {
        emitter = new ParticleContainer<Particle>({
          texture: particles.textures.get(view.preset),
          boundsArea: rectangleOf(bounds),
          dynamicProperties: PARTICLE_PROPERTIES,
        });
        // Last: above the sprites and the emitters that started before.
        node.container.addChild(emitter);
        node.emitters.set(view.id, emitter);
      }
      showParticles(emitter, view.particles);
      count += emitter.particleChildren.length;
    }
    for (const [id, emitter] of node.emitters) {
      if (!kept.has(id)) {
        emitter.destroy();
        node.emitters.delete(id);
      }
    }
    return count;
  }

  return {
    draw(scene, dtMs = 0) {
      if (dtMs > 0 && Number.isFinite(dtMs)) {
        // Kept to one period: the opacity repeats every PLACEHOLDER_PERIOD_MS.
        elapsedMs = (elapsedMs + dtMs) % PLACEHOLDER_PERIOD_MS;
      }
      const alpha = placeholderAlpha(elapsedMs);
      const drawn = new Set<string>();
      const order: Container[] = [];
      /** The name tags, in the scene's order. */
      const tagOrder: Sprite[] = [];
      /** Where each of them is wanted, in the same order. */
      const wanted: BadgeBox[] = [];
      const tagged = new Set<string>();
      let sprites = 0;
      let bitmaps = 0;
      let placeholders = 0;
      let emitters = 0;
      let alive = 0;
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
          for (const emitter of node.emitters.values()) {
            emitter.boundsArea = rectangleOf(actor.bounds);
          }
        }
        actor.sprites.forEach((command, index) => {
          let sprite = node.sprites[index];
          if (sprite === undefined) {
            sprite = new Sprite();
            sprite.anchor.set(0);
            // After the mask and the other sprites, under the particles.
            node.container.addChildAt(sprite, 1 + node.sprites.length);
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
        if (drawBitmap(node, actor.bitmap)) {
          bitmaps += 1;
        }
        if (drawPlaceholder(node, actor.placeholder, alpha)) {
          placeholders += 1;
        }
        alive += drawEmitters(node, actor.actorId, actor.bounds);
        emitters += node.emitters.size;
        order.push(node.container);
        if (actor.badge !== undefined) {
          tagged.add(actor.actorId);
          const shown = drawTag(actor, actor.badge, scene.resolution);
          tagOrder.push(shown.tag);
          wanted.push(shown.wanted);
        }
      }
      for (const [actorId, node] of nodes) {
        if (!drawn.has(actorId)) {
          destroyNode(node);
          nodes.delete(actorId);
        }
      }
      for (const [actorId, tag] of tags) {
        if (!tagged.has(actorId)) {
          tag.destroy();
          tags.delete(actorId);
        }
      }
      // No tag uses the others now.
      badges.textures.sweep();
      // In the canvas, none over another (whole DIP steps: still on pixels).
      stackBadges(wanted, scene.canvasWidth).forEach(({ left, top }, index) => {
        tagOrder[index]?.position.set(left, top);
      });
      // Each rebuilt only when its order changed.
      reorder(layer, order);
      reorder(badges.layer, tagOrder);
      particleCounts = { emitters, particles: alive };
      return {
        actors: order.length,
        sprites,
        bitmaps,
        placeholders,
        placeholderAlpha: alpha,
        badges: tagOrder.length,
      };
    },

    particleCounts: () => particleCounts,

    bitmapShown: (actorId) => (nodes.get(actorId)?.bitmap ?? null) !== null,

    destroy() {
      for (const node of nodes.values()) {
        destroyNode(node);
      }
      nodes.clear();
      layer.removeChildren();
      for (const tag of tags.values()) {
        tag.destroy();
      }
      tags.clear();
      badges.layer.removeChildren();
      particleCounts = { emitters: 0, particles: 0 };
      particles.textures.destroy();
      badges.textures.destroy();
    },
  };
}
