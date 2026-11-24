/**
 * overlay/world (Story 3.6): which state a pack gets for an actor
 * (docs/pack-api-v1.md section 3.2). Pure.
 */
import type { PackCharacter } from '../../shared/pack-api';
import type { StateCode } from '../../shared/states';

/**
 * The state the pack draws for `state`: `state` itself when the character
 * lists it in `states`, else what its `fallback` gives for it, else null:
 * the stage draws its placeholder (Story 3.7, renderer/scene.ts) and the
 * actor's `draw` is not used until the state maps again. The pack still
 * gets `state` itself then (sentState), so it knows the real state.
 */
export function mappedState(
  character: Pick<PackCharacter, 'states' | 'fallback'>,
  state: StateCode,
): StateCode | null {
  if (character.states.includes(state)) {
    return state;
  }
  const shown = character.fallback?.[state];
  return shown !== undefined && character.states.includes(shown) ? shown : null;
}

/** The state sent to the pack: mapped, or `state` itself when unmapped. */
export function sentState(
  character: Pick<PackCharacter, 'states' | 'fallback'>,
  state: StateCode,
): StateCode {
  return mappedState(character, state) ?? state;
}
