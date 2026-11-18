/**
 * The stage's particle presets (API 1.0, Story 3.6): the only names a
 * `particles` command's `preset` takes. A `draw` naming any other is not
 * valid and is dropped whole. Roughly for thinking, error, done and
 * resting, but a pack may use any of them for anything. What each looks
 * like is defined once, in the overlay's renderer. Adding a preset is a
 * minor version of the API.
 */
export const PARTICLE_PRESETS = [
  'sparkle',
  'smoke',
  'confetti',
  'bubbles',
] as const;

export type ParticlePreset = (typeof PARTICLE_PRESETS)[number];
