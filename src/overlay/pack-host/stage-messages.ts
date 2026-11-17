/**
 * pack-host (Story 3.6): the messages the stage sends one pack at each
 * tick, worked out from what it sent before. Pure: the state of one
 * sandbox comes in and is updated, the messages come out in the order to
 * post them; no DOM, so it is unit-tested under Node.
 *
 * - The pack's own actors are its actors in StageView whose character is
 *   in StageView's `characters` (their parameters) and in the pack's
 *   manifest (their states). Its other actors are not drawn and not sent.
 * - The first tick after the sandbox is ready and the pack's look has come
 *   sends `init`: every actor on stage now, each once, in StageView's
 *   order. An own one with `characterId`, its full effective parameters,
 *   its state (mapped through `fallback`) and its display name; any other
 *   pack's with its `actorId` and its state only. No history: events
 *   before it are not sent.
 * - Every later tick sends, in this order: `despawn` for each own actor
 *   that left; `params` for each character of the own actors already sent
 *   whose parameters changed (one per character); `spawn` for each new own
 *   actor (its parameters, state and display name); `meta` for each own
 *   actor already sent whose display name changed.
 * - Then, if the pack has an own actor (or its last one has just left and
 *   it has not had a `frame` since) and its previous `frame` is not still
 *   unanswered (no queue: that tick has no `frame` for it), one `frame`:
 *   `seq` (0 for the first after `init`, then 1, 2…), `t`, `dt` (since the
 *   pack's previous `frame`, 0 for the first), each own actor with its
 *   state as above, and every event since the pack's previous `frame`
 *   (none is lost to a skipped tick). So the `leave` of a pack's last own
 *   actor reaches it in a `frame` with no actors; then it gets no `frame`
 *   until it has an own actor again, and keeps no event meanwhile (its
 *   next `frame` comes with a `spawn`). At most FRAME_EVENTS_MAX events
 *   wait for a `frame` (the latest), however long it stays unanswered.
 * - Never sent: `motion` (API 1.1), fixed parameters, session keys,
 *   sources, confidence, another pack's `characterId`.
 */
import { FRAME_EVENTS_MAX } from '../../shared/constants';
import type {
  FrameEvent,
  PackCharacter,
  ParamValues,
  StageMessage,
  StageMessageOf,
} from '../../shared/pack-api';
import type { StageActor } from '../../shared/pool';
import type { StageCharacter, StageCharacters } from '../../shared/stage-view';
import { sentState } from '../world/states';
import { packIdOf } from './rules';

/** One own actor as last sent to the pack. */
interface SentActor {
  readonly characterId: string;
  displayName: string | null;
}

/** What has been sent to one pack's sandbox. */
export interface PackStageState {
  /** Whether `init` has been sent. */
  inited: boolean;
  /** The own actors sent, in the order sent. */
  readonly actors: Map<string, SentActor>;
  /** Each character's parameters as last sent, as JSON. */
  readonly params: Map<string, string>;
  /** The events since the last `frame`. */
  events: FrameEvent[];
  /** The next `frame`'s seq. */
  nextSeq: number;
  /** The unanswered `frame`, with the own actors it named; null when none. */
  inFlight: {
    readonly seq: number;
    readonly actors: ReadonlySet<string>;
  } | null;
  /** The previous `frame`'s `t`; null before the first. */
  lastT: number | null;
  /**
   * Whether the pack's last own actor has left since its last `frame`:
   * one more `frame`, with no actors, tells it the events.
   */
  owesFrame: boolean;
}

/** A pack's state before anything is sent. */
export function newPackStageState(): PackStageState {
  return {
    inited: false,
    actors: new Map(),
    params: new Map(),
    events: [],
    nextSeq: 0,
    inFlight: null,
    lastT: null,
    owesFrame: false,
  };
}

/** What one tick of one pack needs. */
export interface PackTickInput {
  readonly packId: string;
  /** StageView's `actors`. */
  readonly actors: readonly Pick<
    StageActor,
    'actorId' | 'characterKey' | 'state' | 'displayName'
  >[];
  /** StageView's `characters`. */
  readonly characters: StageCharacters;
  /** The pack's manifest characters, by id. */
  readonly character: (characterId: string) => PackCharacter | undefined;
  /** Stage time, ms. */
  readonly t: number;
  /** This tick's events. */
  readonly events: readonly FrameEvent[];
}

/** One own actor this tick. */
interface OwnActor {
  readonly actorId: string;
  readonly characterId: string;
  readonly params: ParamValues;
  readonly state: StageActor['state'];
  readonly displayName: string | null;
}

/** The pack's own actors this tick, in StageView's order. */
function ownActors(input: PackTickInput): OwnActor[] {
  const own: OwnActor[] = [];
  for (const actor of input.actors) {
    if (packIdOf(actor.characterKey) !== input.packId) {
      continue;
    }
    const values: StageCharacter | undefined =
      input.characters[actor.characterKey];
    const characterId = actor.characterKey.slice(input.packId.length + 1);
    const character = input.character(characterId);
    if (values === undefined || character === undefined) {
      continue;
    }
    own.push({
      actorId: actor.actorId,
      characterId,
      params: values.params,
      state: sentState(character, actor.state),
      displayName: actor.displayName,
    });
  }
  return own;
}

/**
 * The messages for one tick of one pack (see the module comment), in the
 * order to post them; `state` is updated as if they were all sent.
 */
export function composeTick(
  state: PackStageState,
  input: PackTickInput,
): StageMessage[] {
  const own = ownActors(input);
  const messages: StageMessage[] = [];
  if (!state.inited) {
    const mine = new Map(own.map((actor) => [actor.actorId, actor]));
    messages.push({
      type: 'init',
      actors: input.actors.flatMap(
        (actor): StageMessageOf<'init'>['actors'] => {
          const ownActor = mine.get(actor.actorId);
          if (ownActor !== undefined) {
            return [
              {
                own: true as const,
                actorId: ownActor.actorId,
                characterId: ownActor.characterId,
                params: ownActor.params,
                state: ownActor.state,
                displayName: ownActor.displayName,
              },
            ];
          }
          if (packIdOf(actor.characterKey) === input.packId) {
            // The pack's own actor it cannot play: not sent at all.
            return [];
          }
          return [
            { own: false as const, actorId: actor.actorId, state: actor.state },
          ];
        },
      ),
    });
    state.inited = true;
    for (const actor of own) {
      state.actors.set(actor.actorId, {
        characterId: actor.characterId,
        displayName: actor.displayName,
      });
      state.params.set(actor.characterId, JSON.stringify(actor.params));
    }
    // No history: what happened before the init is in it already.
    state.events = [];
  } else {
    const current = new Map(own.map((actor) => [actor.actorId, actor]));
    for (const actorId of state.actors.keys()) {
      if (!current.has(actorId)) {
        state.actors.delete(actorId);
        messages.push({ type: 'despawn', actorId });
        state.owesFrame = state.actors.size === 0;
      }
    }
    const changed = new Set<string>();
    for (const [actorId, sent] of state.actors) {
      const actor = current.get(actorId);
      if (actor === undefined || changed.has(sent.characterId)) {
        continue;
      }
      const params = JSON.stringify(actor.params);
      if (state.params.get(sent.characterId) !== params) {
        changed.add(sent.characterId);
        state.params.set(sent.characterId, params);
        messages.push({
          type: 'params',
          characterId: sent.characterId,
          params: actor.params,
        });
      }
    }
    const metas: StageMessage[] = [];
    for (const actor of own) {
      const sent = state.actors.get(actor.actorId);
      if (sent === undefined) {
        state.actors.set(actor.actorId, {
          characterId: actor.characterId,
          displayName: actor.displayName,
        });
        state.params.set(actor.characterId, JSON.stringify(actor.params));
        messages.push({
          type: 'spawn',
          actorId: actor.actorId,
          characterId: actor.characterId,
          params: actor.params,
          state: actor.state,
          displayName: actor.displayName,
        });
      } else if (sent.displayName !== actor.displayName) {
        sent.displayName = actor.displayName;
        metas.push({
          type: 'meta',
          actorId: actor.actorId,
          displayName: actor.displayName,
        });
      }
    }
    messages.push(...metas);
    if (state.actors.size > 0 || state.owesFrame) {
      state.events.push(...input.events);
      if (state.events.length > FRAME_EVENTS_MAX) {
        state.events = state.events.slice(-FRAME_EVENTS_MAX);
      }
    }
  }
  const actors = own.filter((actor) => state.actors.has(actor.actorId));
  if (state.inFlight === null && (actors.length > 0 || state.owesFrame)) {
    state.owesFrame = false;
    const seq = state.nextSeq;
    messages.push({
      type: 'frame',
      seq,
      t: input.t,
      dt: state.lastT === null ? 0 : Math.max(0, input.t - state.lastT),
      actors: actors.map(({ actorId, state: shown }) => ({
        actorId,
        state: shown,
      })),
      events: state.events,
    });
    state.inFlight = {
      seq,
      actors: new Set(actors.map((actor) => actor.actorId)),
    };
    state.nextSeq = seq + 1;
    state.lastT = input.t;
    state.events = [];
  }
  return messages;
}
