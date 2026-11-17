/**
 * overlay/renderer (Story 3.6): what to draw this display frame, worked out
 * as plain data: no PixiJS and no DOM, so it is unit-tested under Node.
 * pixi-stage.ts draws it.
 *
 * - An actor is placed (world/layout.ts) when its pack is installed, its
 *   character is in StageView's `characters` and the pack's look (its
 *   manifest at the version installed) has come; one whose character is
 *   missing from `characters` (or from that manifest) is reported in
 *   `missing`, by pack, and drawn nowhere.
 * - A placed actor is drawn when its state maps (world/states.ts: in the
 *   character's `states` or its `fallback`) and its pack's latest valid
 *   draw, made by the version installed, has it: its sprite commands,
 *   ordered by `z` (ties keep the pack's order). An empty list draws
 *   nothing but the actor is there. A state that does not map draws
 *   nothing of it (the placeholder is Story 3.7), nor does a draw that
 *   leaves it out.
 * - Each drawn actor sits at its position, scaled by its 大小 (the `scale`
 *   fixed parameter), clipped to its manifest `bounds`. Actors are drawn
 *   by `y`, lower on the screen on top (ties keep StageView's order).
 * - A sprite: the image's top-left corner at `x`, `y` in the actor's local
 *   coordinates (base pixels); one image pixel is one base pixel times
 *   `scaleX`, `scaleY` (a negative one flips it about that corner), turned
 *   by `rotation` about that corner, at `alpha`. Left-out fields take
 *   SPRITE_COMMAND_DEFAULTS.
 * - A drawn actor with at least one sprite on screen (its texture loaded:
 *   `ready`) takes the mouse over its manifest `hitbox` times its 大小, at
 *   its position, named by its session key; the one drawn on top comes
 *   last (pointer.ts gives the last one under the cursor). Any other actor
 *   takes no mouse: not drawn, an empty list, or only sprites whose
 *   textures are still loading or failed, so nothing invisible catches a
 *   click.
 */
import type { SessionKey } from '../../shared/detection-events';
import {
  type LocalBox,
  type PackCharacter,
  SPRITE_COMMAND_DEFAULTS,
} from '../../shared/pack-api';
import type { StageCharacter, StageView } from '../../shared/stage-view';
import type { PackLook } from '../looks';
import type { PackDraw } from '../pack-host/host';
import type { SpriteCommand } from '../pack-host/draw-rules';
import { packIdOf } from '../pack-host/rules';
import type { HitArea } from '../pointer';
import {
  rowLayout,
  type RowMember,
  type WorldPoint,
  type WorldSize,
} from '../world/layout';
import { mappedState } from '../world/states';

/** One sprite to draw, every field given. */
export interface SceneSprite {
  /** The key in the pack's `assets`. */
  readonly asset: string;
  /** The spritesheet frame; undefined for an image. */
  readonly frame: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly alpha: number;
}

/** One actor to draw. */
export interface SceneActor {
  readonly actorId: string;
  readonly sessionKey: SessionKey;
  readonly packId: string;
  /** The pack version its textures come from. */
  readonly version: string;
  /** Its local origin, in world coordinates (DIP). */
  readonly x: number;
  readonly y: number;
  /** Its 大小. */
  readonly scale: number;
  /** What it is clipped to, in its local coordinates. */
  readonly bounds: LocalBox;
  /** Its sprites, bottom first. */
  readonly sprites: readonly SceneSprite[];
}

/** What to draw this display frame. */
export interface Scene {
  /** The actors drawn, bottom first. */
  readonly actors: readonly SceneActor[];
  /** What takes the mouse, top last. */
  readonly areas: readonly HitArea<SessionKey>[];
  /**
   * The installed packs with an actor whose character the stage has no
   * values for (StageView's `characters`, or the pack's manifest).
   */
  readonly missing: ReadonlySet<string>;
}

export interface SceneInput {
  readonly view: Pick<StageView, 'actors' | 'characters' | 'packs' | 'canvas'>;
  /** The look of the version of a pack installed now, once it came. */
  readonly look: (packId: string) => PackLook | undefined;
  /** A pack's latest valid draw. */
  readonly draw: (packId: string) => PackDraw | undefined;
  /** Whether a sprite's texture is there to draw it with (textures.ts). */
  readonly ready: (
    packId: string,
    version: string,
    asset: string,
    frame: string | undefined,
  ) => boolean;
  /**
   * Where the actors stand (world/layout.ts's row by default; Epic 4's
   * wandering gives its own).
   */
  readonly place?: (
    world: WorldSize,
    members: readonly RowMember<string>[],
  ) => ReadonlyMap<string, WorldPoint>;
}

/** A sprite command with every field given. */
export function sceneSprite(command: SpriteCommand): SceneSprite {
  return {
    asset: command.asset,
    frame: command.frame,
    x: command.x,
    y: command.y,
    rotation: command.rotation ?? SPRITE_COMMAND_DEFAULTS.rotation,
    scaleX: command.scaleX ?? SPRITE_COMMAND_DEFAULTS.scaleX,
    scaleY: command.scaleY ?? SPRITE_COMMAND_DEFAULTS.scaleY,
    alpha: command.alpha ?? SPRITE_COMMAND_DEFAULTS.alpha,
  };
}

/** `commands` as sprites, ordered by `z` (stable). */
export function sceneSprites(
  commands: readonly SpriteCommand[],
): SceneSprite[] {
  return commands
    .map((command, index) => ({
      command,
      index,
      z: command.z ?? SPRITE_COMMAND_DEFAULTS.z,
    }))
    .sort((a, b) => a.z - b.z || a.index - b.index)
    .map(({ command }) => sceneSprite(command));
}

/** What takes the mouse for an actor: its `hitbox` × `scale` at its place. */
export function hitAreaOf(
  actor: Pick<SceneActor, 'sessionKey' | 'x' | 'y' | 'scale'>,
  hitbox: LocalBox,
): HitArea<SessionKey> {
  return {
    key: actor.sessionKey,
    x: actor.x + hitbox.x * actor.scale,
    y: actor.y + hitbox.y * actor.scale,
    width: hitbox.width * actor.scale,
    height: hitbox.height * actor.scale,
  };
}

const EMPTY: Scene = Object.freeze({
  actors: [],
  areas: [],
  missing: new Set<string>(),
});

/** An actor to place, with what drawing it needs. */
interface Member extends RowMember<string> {
  readonly bounds: LocalBox;
  readonly actor: StageView['actors'][number];
  readonly look: PackLook;
  readonly character: PackCharacter;
}

/** The scene for `input` (see the module comment). */
export function buildScene({
  view,
  look,
  draw,
  ready,
  place = rowLayout,
}: SceneInput): Scene {
  const { canvas } = view;
  if (canvas === null || view.actors.length === 0) {
    return EMPTY;
  }
  const installed = new Map(
    view.packs.installed.map((pack) => [pack.id, pack]),
  );
  const missing = new Set<string>();
  const members: Member[] = [];
  for (const actor of view.actors) {
    const packId = packIdOf(actor.characterKey);
    const pack = installed.get(packId);
    if (pack === undefined || !pack.compatibility.compatible) {
      // pack-host logs these: they get no sandbox.
      continue;
    }
    const values: StageCharacter | undefined =
      view.characters[actor.characterKey];
    if (values === undefined) {
      missing.add(packId);
      continue;
    }
    const packLook = look(packId);
    if (packLook === undefined || packLook.version !== pack.version) {
      continue;
    }
    const character = packLook.character(
      actor.characterKey.slice(packId.length + 1),
    );
    if (character === undefined) {
      missing.add(packId);
      continue;
    }
    members.push({
      key: actor.actorId,
      bounds: character.bounds,
      scale: values.fixed.scale,
      actor,
      look: packLook,
      character,
    });
  }
  const placed = place(canvas.bounds, members);
  const drawn: { readonly actor: SceneActor; readonly hitbox: LocalBox }[] = [];
  for (const member of members) {
    const at = placed.get(member.key);
    if (at === undefined) {
      continue;
    }
    const { actor, character } = member;
    if (mappedState(character, actor.state) === null) {
      continue;
    }
    const { packId, version } = member.look;
    const latest = draw(packId);
    const commands =
      latest?.version === version
        ? latest.actors.get(actor.actorId)
        : undefined;
    if (commands === undefined) {
      continue;
    }
    drawn.push({
      actor: {
        actorId: actor.actorId,
        sessionKey: actor.sessionKey,
        packId,
        version,
        x: at.x,
        y: at.y,
        scale: member.scale,
        bounds: member.bounds,
        sprites: sceneSprites(commands),
      },
      hitbox: character.hitbox,
    });
  }
  // By y, lower on top; Array.prototype.sort is stable.
  drawn.sort((a, b) => a.actor.y - b.actor.y);
  return {
    actors: drawn.map(({ actor }) => actor),
    areas: drawn
      .filter(({ actor }) =>
        actor.sprites.some((sprite) =>
          ready(actor.packId, actor.version, sprite.asset, sprite.frame),
        ),
      )
      .map(({ actor, hitbox }) => hitAreaOf(actor, hitbox)),
    missing,
  };
}
