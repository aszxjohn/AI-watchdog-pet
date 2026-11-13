/**
 * Sample pack data for the pack API schema tests. The pack and its
 * characters are made up for the tests and named after test probes.
 */

/** The Design Notes character's one parameter. */
export const BOOL_PARAM = {
  key: 'glow',
  label: '發光',
  type: 'bool',
  default: true,
};

export const INT_PARAM = {
  key: 'blink-every',
  label: '眨眼間隔',
  type: 'int',
  min: 2,
  max: 20,
  step: 2,
  default: 6,
};

export const NUMBER_PARAM = {
  key: 'sway',
  label: '擺動幅度',
  type: 'number',
  min: 0,
  max: 1,
  step: 0.1,
  default: 0.3,
};

export const CHOICE_PARAM = {
  key: 'mood',
  label: '心情',
  type: 'choice',
  options: [
    { value: 'calm', label: '平靜' },
    { value: 'busy', label: '忙碌' },
  ],
  default: 'calm',
};

/** Its options are keys in SAMPLE_MANIFEST's assets. */
export const ASSET_PARAM = {
  key: 'skin',
  label: '外觀',
  type: 'asset',
  options: ['body-plain', 'body-dots'],
  default: 'body-dots',
};

/** The Design Notes character, unchanged. */
export const PROBE_A = {
  id: 'probe-a',
  name: '探針甲',
  height: 110,
  params: [BOOL_PARAM],
  states: ['thinking', 'working', 'waiting'],
  fallback: { done: 'waiting', idle: 'waiting' },
  hitbox: { x: -30, y: -110, width: 60, height: 110 },
  bounds: { x: -60, y: -140, width: 120, height: 140 },
  anchor: { x: 0, y: -120 },
};

/** A second character with every other parameter type and every option. */
export const PROBE_B = {
  id: 'probe-b',
  name: '探針乙',
  height: 96.5,
  params: [INT_PARAM, NUMBER_PARAM, CHOICE_PARAM, ASSET_PARAM],
  states: [
    'waiting',
    'thinking',
    'working',
    'approval',
    'decision',
    'done',
    'idle',
    'error',
  ],
  hitbox: { x: -25.5, y: -96.5, width: 51, height: 96.5 },
  bounds: { x: -50, y: -120, width: 100, height: 120 },
  anchor: { x: 0, y: -104 },
  defaults: {
    scale: 0.8,
    wander: { areas: [3, 4, 5], speed: 'slow' },
  },
  advancedBitmap: true,
};

/** Two characters, all five parameter types, every optional field. */
export const SAMPLE_MANIFEST = {
  id: 'sample-pack',
  name: '樣本包',
  version: '1.4.0',
  apiVersion: '1.0',
  entry: 'dist/entry.js',
  assets: {
    'body-plain': { kind: 'image', path: 'img/body-plain.png' },
    'body-dots': { kind: 'image', path: 'img/body-dots.png' },
    sheet: { kind: 'spritesheet', path: 'img/sheet.json' },
    spark: { kind: 'image', path: 'img/spark.png' },
  },
  characters: [PROBE_A, PROBE_B],
  projectiles: { zap: 'spark' },
};

/** Where a value sits in a sample: keys and list indexes, outermost first. */
export type SamplePath = readonly (string | number)[];

type Container = Record<string | number, unknown>;

function parentOf(
  root: unknown,
  path: SamplePath,
): [Container, string | number] {
  if (path.length === 0) {
    throw new Error('a sample path names at least one key');
  }
  let parent = root as Container;
  for (const key of path.slice(0, -1)) {
    parent = parent[key] as Container;
  }
  return [parent, path[path.length - 1] as string | number];
}

/** A copy of `sample` with the value at `path` set (or added) to `value`. */
export function changed(
  sample: unknown,
  path: SamplePath,
  value: unknown,
): unknown {
  const copy = structuredClone(sample);
  const [parent, key] = parentOf(copy, path);
  parent[key] = value;
  return copy;
}

/** A copy of `sample` without the field at `path`. */
export function removed(sample: unknown, path: SamplePath): unknown {
  const copy = structuredClone(sample);
  const [parent, key] = parentOf(copy, path);
  delete parent[key];
  return copy;
}

/**
 * A copy of `record` with an own `__proto__` key, as JSON.parse or a
 * structured clone makes it (assigning `__proto__` would set the prototype
 * instead).
 */
export function withProtoKey(record: object, value: unknown): object {
  const copy = { ...record };
  Object.defineProperty(copy, '__proto__', {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return copy;
}

/** The smallest valid manifest: one character, no params, no assets. */
export const MINIMAL_MANIFEST = {
  id: 'ab',
  name: 'x',
  version: '0.0.1',
  apiVersion: '1.0',
  entry: 'a.js',
  assets: {},
  characters: [
    {
      id: 'c1',
      name: 'y',
      height: 1,
      params: [],
      states: ['idle'],
      hitbox: { x: 0, y: 0, width: 1, height: 1 },
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      anchor: { x: 0, y: 0 },
    },
  ],
};
