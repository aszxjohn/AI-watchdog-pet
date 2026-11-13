/**
 * The contract test pack (Story 3.1): the API v1.0 sample in
 * test/packs/contract-pack/, laid out as an unpacked `.awpet` (one
 * `<packId>/` folder). Its files must pass the pack API contract, and its
 * entry must run in a realm as bare as the sandbox's Compartment: no Date,
 * console or timers, a Math.random that throws, frozen built-in prototypes
 * (docs/pack-api-v1.md). This realm is node:vm, and nothing from this
 * (the host) realm is handed into it: `stage` is built inside it and messages
 * go in as JSON. The real sandbox (SES in a Worker) is Story 3.5's.
 */
import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  checkApiCompatibility,
  type DrawMessage,
  drawMessageSchema,
  type FrameEvent,
  INT_PARAM_DEFAULT_STEP,
  isValidParamValue,
  manifestApiVersionSchema,
  manifestSchema,
  type PackCharacter,
  type PackManifest,
  packPathSchema,
  PARAM_TYPES,
  type ParamDecl,
  type ParamValues,
  STAGE_MESSAGE_TYPES,
  type StageMessage,
  type StageMessageOf,
  stageMessageSchema,
} from '../../src/shared/pack-api';
import { STATE_CODES } from '../../src/shared/states';
import { z } from '../../src/shared/zod-setup';
import { expectRoundTrip } from '../shared/schema-helpers';

/** The unpacked `.awpet`: its root holds only the `<packId>/` folder. */
const AWPET_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'contract-pack',
);

/** The pack folder itself, where manifest.json is. */
const PACK_DIR = path.join(AWPET_ROOT, 'contract-pack');

function readPackFile(file: string): Buffer {
  return readFileSync(path.join(PACK_DIR, file));
}

function readPackJson(file: string): unknown {
  return JSON.parse(readPackFile(file).toString('utf8'));
}

function readManifest(): PackManifest {
  return manifestSchema.parse(readPackJson('manifest.json'));
}

/**
 * Finder's `.DS_Store` is left out of every listing: git ignores it, so it
 * never reaches CI, but it would fail the test on a Mac that opened the
 * folder.
 */
function isFinderFile(name: string): boolean {
  return path.posix.basename(name) === '.DS_Store';
}

/**
 * Every entry under the pack folder (files, folders, links), as a pack path
 * (`/`-separated, relative to the folder), with its lstat: a link is
 * reported as a link, not followed.
 */
function packEntries(): { path: string; stats: Stats }[] {
  return readdirSync(PACK_DIR, { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/'))
    .filter((entry) => !isFinderFile(entry))
    .map((entry) => ({
      path: entry,
      stats: lstatSync(path.join(PACK_DIR, entry)),
    }));
}

/** Every regular file in the pack folder, as a pack path, sorted. */
function packFiles(): string[] {
  return packEntries()
    .filter((entry) => entry.stats.isFile())
    .map((entry) => entry.path)
    .sort();
}

/** The part of a PixiJS spritesheet JSON the stage relies on. */
const spritesheetSchema = z.object({
  frames: z.record(
    z.string().min(1),
    z.object({
      frame: z.object({
        x: z.int().nonnegative(),
        y: z.int().nonnegative(),
        w: z.int().positive(),
        h: z.int().positive(),
      }),
    }),
  ),
  meta: z.object({
    image: z.string(),
    size: z.object({ w: z.int().positive(), h: z.int().positive() }),
    scale: z.union([z.number().positive(), z.string()]),
  }),
});

type Spritesheet = z.infer<typeof spritesheetSchema>;

/** Each spritesheet asset: its key, its JSON's pack path, and the JSON. */
function spritesheets(
  manifest: PackManifest,
): { key: string; path: string; sheet: Spritesheet }[] {
  return Object.entries(manifest.assets)
    .filter(([, asset]) => asset.kind === 'spritesheet')
    .map(([key, asset]) => ({
      key,
      path: asset.path,
      sheet: spritesheetSchema.parse(readPackJson(asset.path)),
    }));
}

/** A sheet's image as a pack path: PixiJS reads `meta.image` relative to it. */
function sheetImagePath(sheetPath: string, sheet: Spritesheet): string {
  return path.posix.join(path.posix.dirname(sheetPath), sheet.meta.image);
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** A PNG's width and height from its IHDR chunk, or null if not a PNG. */
function pngSize(file: Buffer): { w: number; h: number } | null {
  if (
    file.length < 24 ||
    !file.subarray(0, 8).equals(PNG_SIGNATURE) ||
    file.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    return null;
  }
  return { w: file.readUInt32BE(16), h: file.readUInt32BE(20) };
}

/**
 * The globals a pack's Compartment does not have (docs/pack-api-v1.md).
 * bareRealm deletes them all; names a vm context never had are listed too,
 * so the check after deleting covers the whole list.
 */
const MISSING_GLOBALS = [
  'Date',
  'console',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
  'queueMicrotask',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'crypto',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'WebTransport',
  'importScripts',
  'Worker',
  'SharedWorker',
  'indexedDB',
  'caches',
  'Intl',
  'performance',
  'self',
  'postMessage',
  'navigator',
  'location',
] as const;

/**
 * The built-in prototypes bareRealm freezes, as SES lockdown() freezes
 * every intrinsic: a pack that patches one fails here too.
 */
const FROZEN_PROTOTYPES = [
  'Object',
  'Array',
  'Function',
  'String',
  'Number',
  'Boolean',
  'Map',
  'Set',
] as const;

/** The Math.random stand-in's error message. */
const NO_MATH_RANDOM = 'Math.random is not available to a pack';

/**
 * A vm context with nothing from Node in it (no `stage` global either: the
 * factory gets it as its argument): MISSING_GLOBALS and the removed
 * Iterator methods deleted, a Math.random that throws, FROZEN_PROTOTYPES
 * frozen.
 */
function bareRealm(): vm.Context {
  const realm = vm.createContext({});
  vm.runInContext(
    `'use strict';
    for (const name of ${JSON.stringify(MISSING_GLOBALS)}) {
      delete globalThis[name];
    }
    if (typeof Iterator === 'function') {
      delete Iterator.prototype.join;
      delete Iterator.prototype.includes;
    }
    Math.random = function random() {
      throw new TypeError(${JSON.stringify(NO_MATH_RANDOM)});
    };
    for (const name of ${JSON.stringify(FROZEN_PROTOTYPES)}) {
      Object.freeze(globalThis[name].prototype);
    }`,
    realm,
  );
  return realm;
}

function entrySource(manifest: PackManifest): string {
  return readPackFile(manifest.entry).toString('utf8');
}

/**
 * Evaluates the entry as a strict classic script, as a Compartment does,
 * and returns its value. The prefix keeps the line numbers.
 */
function evaluateEntry(realm: vm.Context, manifest: PackManifest): unknown {
  return new vm.Script(`'use strict'; ${entrySource(manifest)}`, {
    filename: manifest.entry,
  }).runInContext(realm);
}

/**
 * Builds, inside the realm, a stand-in for `stage` and a function that
 * hands a message (as JSON) to a handler. Both are the realm's own
 * functions, so nothing the pack reaches from them (`.constructor` and the
 * like) leads to the host. The host only learns what `record` is called
 * with: two strings, nothing it returns, nothing that throws.
 */
const REALM_TOOLS = `({
  makeStage(record) {
    'use strict';
    const drawn = new Map();
    return Object.freeze({
      // Reproducible per actor: the nth call gives frac(n × 0.618…).
      random: Object.freeze(function random(actorId) {
        const id = String(actorId);
        record('random', id);
        const n = (drawn.get(id) ?? 0) + 1;
        drawn.set(id, n);
        return (n * 0.618033988749895) % 1;
      }),
      log: Object.freeze(function log(...values) {
        record('log', values.map(String).join(' '));
      }),
    });
  },
  deliver(handlers, json) {
    'use strict';
    const message = JSON.parse(json);
    const handler = handlers[message.type];
    return typeof handler === 'function'
      ? handler.call(handlers, message)
      : undefined;
  },
})`;

interface RealmTools {
  makeStage(record: (kind: string, value: string) => void): object;
  deliver(handlers: unknown, json: string): unknown;
}

/** A fresh realm, the entry evaluated in it, and its handlers. */
function loadPack(manifest: PackManifest) {
  const realm = bareRealm();
  const tools = vm.runInContext(REALM_TOOLS, realm) as RealmTools;
  const randomCalls: string[] = [];
  const logs: string[] = [];
  const stage = tools.makeStage((kind, value) => {
    (kind === 'random' ? randomCalls : logs).push(String(value));
  });
  const factory = evaluateEntry(realm, manifest);
  expect(typeof factory).toBe('function');
  const handlers: unknown = (factory as (stage: unknown) => unknown)(stage);
  expect(typeof handlers).toBe('object');
  expect(handlers).not.toBeNull();
  return { realm, tools, stage, handlers, randomCalls, logs };
}

type LoadedPack = ReturnType<typeof loadPack>;

/**
 * Hands `message` to its handler, as the Worker would: checked against the
 * contract first, then sent into the realm as JSON. Returns what the
 * handler returns (an object of the realm).
 */
function deliver(pack: LoadedPack, message: StageMessage): unknown {
  const checked = stageMessageSchema.parse(message);
  return pack.tools.deliver(pack.handlers, JSON.stringify(checked));
}

/** A character's parameter values when nobody changed them. */
function defaultParams(character: PackCharacter): ParamValues {
  return Object.fromEntries(
    character.params.map((param) => [param.key, param.default]),
  );
}

/** For each parameter, a valid value other than its default. */
function changedParams(character: PackCharacter): ParamValues {
  const other = (param: ParamDecl) => {
    switch (param.type) {
      case 'bool':
        return !param.default;
      case 'int':
      case 'number': {
        // min is always valid, and so is one step above it when in range.
        const step =
          param.step ??
          (param.type === 'int'
            ? INT_PARAM_DEFAULT_STEP
            : param.max - param.min);
        const next = param.min + step;
        if (param.default !== param.min) {
          return param.min;
        }
        return next <= param.max ? next : undefined;
      }
      case 'choice':
        return param.options.find((option) => option.value !== param.default)
          ?.value;
      case 'asset':
        return param.options.find((key) => key !== param.default);
    }
  };
  return Object.fromEntries(
    character.params.map((param) => {
      const value = other(param);
      expect(value, param.key).not.toBe(param.default);
      if (!isValidParamValue(param, value)) {
        throw new Error(`no other valid value for ${param.key}`);
      }
      return [param.key, value];
    }),
  );
}

/** Another pack's actor, on stage before this pack's sandbox starts. */
const OTHER_ACTOR = 'actor-other';

/** One of this pack's actors in the tests. */
interface OwnActor {
  readonly actorId: string;
  readonly character: PackCharacter;
}

/** One actor per character of the pack: actor-1, actor-2, … */
function ownActors(manifest: PackManifest): OwnActor[] {
  return manifest.characters.map((character, i) => ({
    actorId: `actor-${i + 1}`,
    character,
  }));
}

/** The `spawn` of `actor`, with its character's default parameters. */
function spawnMessage({ actorId, character }: OwnActor): StageMessage {
  return {
    type: 'spawn',
    actorId,
    characterId: character.id,
    params: defaultParams(character),
    state: character.states[0],
    displayName: actorId === 'actor-1' ? '工作區甲' : null,
  };
}

/** A frame where each listed actor shows its character's `states[seq]`. */
function frameMessage(
  seq: number,
  actors: readonly OwnActor[],
  events: FrameEvent[] = [],
): StageMessageOf<'frame'> {
  return {
    type: 'frame',
    seq,
    t: seq * 33.5,
    dt: seq === 0 ? 0 : 33.5,
    actors: actors.map(({ actorId, character }) => ({
      actorId,
      state: character.states[seq % character.states.length],
    })),
    events,
  };
}

/**
 * Checks what `frame` returned and returns it as parsed. Wrapped with
 * `type` and `seq` and structured-cloned, as the Worker bootstrap sends it,
 * it passes drawMessageSchema. Its keys are exactly the ids of `drawn`, each
 * with at least one command. Each sprite names a manifest asset, with a
 * `frame` from that sheet exactly when the asset is a spritesheet; a bitmap
 * is only for a character with `advancedBitmap`.
 */
function checkDraw(
  manifest: PackManifest,
  frame: StageMessageOf<'frame'>,
  returned: unknown,
  drawn: readonly OwnActor[],
): DrawMessage['actors'] {
  const draw = structuredClone({
    type: 'draw',
    seq: frame.seq,
    actors: returned,
  });
  expectRoundTrip(drawMessageSchema, draw);
  const { actors } = drawMessageSchema.parse(draw);
  expect(Object.keys(actors).sort()).toStrictEqual(
    drawn.map(({ actorId }) => actorId).sort(),
  );
  const frameNames = new Map(
    spritesheets(manifest).map(({ key, sheet }) => [
      key,
      Object.keys(sheet.frames),
    ]),
  );
  for (const { actorId, character } of drawn) {
    const commands = actors[actorId] ?? [];
    expect(commands.length, actorId).toBeGreaterThan(0);
    for (const command of commands) {
      if (command.type === 'bitmap') {
        expect(character.advancedBitmap, actorId).toBe(true);
      }
      if (command.type !== 'sprite') {
        continue;
      }
      expect(Object.keys(manifest.assets)).toContain(command.asset);
      const names = frameNames.get(command.asset);
      if (names === undefined) {
        expect(command.frame).toBeUndefined();
      } else {
        expect(names).toContain(command.frame);
      }
    }
  }
  return actors;
}

/**
 * The I/O matrix's 演出: `init` (another pack's actor only), a `spawn` for
 * one actor of each character, then two frames. Returns the pack as loaded
 * and each frame's draw, as checkDraw parsed it.
 */
function perform(manifest: PackManifest) {
  const pack = loadPack(manifest);
  const actors = ownActors(manifest);
  const ownIds = new Set(actors.map((actor) => actor.actorId));
  deliver(pack, {
    type: 'init',
    actors: [{ own: false, actorId: OTHER_ACTOR, state: 'idle' }],
  });
  for (const actor of actors) {
    deliver(pack, spawnMessage(actor));
  }
  const draws = [
    frameMessage(0, actors),
    frameMessage(1, actors, [{ type: 'leave', actorId: OTHER_ACTOR }]),
  ].map((frame) => checkDraw(manifest, frame, deliver(pack, frame), actors));
  return { ...pack, actors, ownIds, draws };
}

describe('I/O matrix', () => {
  it('manifest: manifest.json passes manifestSchema and its apiVersion is compatible with the stage', () => {
    const raw = readPackJson('manifest.json');
    expectRoundTrip(manifestSchema, raw);
    const { apiVersion } = manifestApiVersionSchema.parse(raw);
    expect(checkApiCompatibility(apiVersion)).toStrictEqual({
      compatible: true,
    });
    expect(readManifest().characters.length).toBeGreaterThanOrEqual(2);
  });

  it('檔案對得上: every file the manifest names exists, every file in the pack is named (a sheet image by its meta.image), and none is a link', () => {
    const manifest = readManifest();
    expect(
      readdirSync(AWPET_ROOT).filter((name) => !isFinderFile(name)),
    ).toStrictEqual([manifest.id]);
    expect(
      packEntries()
        .filter((entry) => entry.stats.isSymbolicLink())
        .map((entry) => entry.path),
    ).toStrictEqual([]);
    const named = new Set([
      'manifest.json',
      manifest.entry,
      ...Object.values(manifest.assets).map((asset) => asset.path),
      ...spritesheets(manifest).map(({ path: sheetPath, sheet }) =>
        sheetImagePath(sheetPath, sheet),
      ),
    ]);
    expect(packFiles()).toStrictEqual([...named].sort());
    const images = Object.values(manifest.assets).filter(
      (asset) => asset.kind === 'image',
    );
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(pngSize(readPackFile(image.path)), image.path).not.toBeNull();
    }
  });

  it('spritesheet: each spritesheet JSON has frames, and its meta.image is a PNG in the pack the frames fit in', () => {
    const sheets = spritesheets(readManifest());
    expect(sheets.length).toBeGreaterThan(0);
    for (const { path: sheetPath, sheet } of sheets) {
      expect(Object.keys(sheet.frames).length).toBeGreaterThan(0);
      expect(packPathSchema.safeParse(sheet.meta.image).success).toBe(true);
      const imagePath = sheetImagePath(sheetPath, sheet);
      expect(packPathSchema.safeParse(imagePath).success).toBe(true);
      expect(packFiles()).toContain(imagePath);
      const size = pngSize(readPackFile(imagePath));
      expect(size).toStrictEqual(sheet.meta.size);
      for (const { frame } of Object.values(sheet.frames)) {
        expect(frame.x + frame.w).toBeLessThanOrEqual(sheet.meta.size.w);
        expect(frame.y + frame.h).toBeLessThanOrEqual(sheet.meta.size.h);
      }
    }
  });

  it('部分狀態: each character draws only some states, declares fallback, and leaves a state to the placeholder', () => {
    for (const character of readManifest().characters) {
      const fallback = character.fallback ?? {};
      expect(character.states.length).toBeLessThan(STATE_CODES.length);
      expect(Object.keys(fallback).length).toBeGreaterThan(0);
      const placeholder = STATE_CODES.filter(
        (state) =>
          !character.states.includes(state) && !Object.hasOwn(fallback, state),
      );
      expect(placeholder.length, character.id).toBeGreaterThan(0);
    }
  });

  it('參數型別: the pack declares at least one bool, int, number, choice and asset parameter', () => {
    const types = new Set(
      readManifest().characters.flatMap((character) =>
        character.params.map((param) => param.type),
      ),
    );
    expect([...types].sort()).toStrictEqual([...PARAM_TYPES].sort());
  });

  it('入口求值: entry.js, evaluated in a vm context without Date, console or timers, gives a factory that returns handlers', () => {
    const manifest = readManifest();
    expect(entrySource(manifest)).not.toMatch(/\bimport\b|\brequire\b/);

    const { realm, handlers } = loadPack(manifest);
    // Each check comes back as a string: an array from the other realm is
    // never strictly equal to one from this realm.
    expect(
      vm.runInContext(
        `${JSON.stringify(MISSING_GLOBALS)}
          .filter((name) => typeof globalThis[name] !== 'undefined')
          .join(',')`,
        realm,
      ),
    ).toBe('');
    expect(
      vm.runInContext(
        `${JSON.stringify(FROZEN_PROTOTYPES)}
          .filter((name) => !Object.isFrozen(globalThis[name].prototype))
          .join(',')`,
        realm,
      ),
    ).toBe('');
    expect(() => vm.runInContext('Math.random()', realm)).toThrow(
      NO_MATH_RANDOM,
    );

    const names = Object.keys(handlers as object);
    const handler = (name: string) =>
      (handlers as Record<string, unknown>)[name];
    expect(
      names.filter((name) => typeof handler(name) !== 'function'),
    ).toStrictEqual([]);
    expect(
      names.filter(
        (name) => !(STAGE_MESSAGE_TYPES as readonly string[]).includes(name),
      ),
    ).toStrictEqual([]);
    expect(names).toContain('frame');
  });

  it("入口求值: stage and the messages are the realm's own, so their constructors do not reach the host's Date", () => {
    const pack = loadPack(readManifest());
    const stage = pack.stage as Record<'random' | 'log', Function>;
    for (const fn of [stage.random, stage.log]) {
      const makeFunction = fn.constructor as FunctionConstructor;
      expect(makeFunction('return typeof Date')()).toBe('undefined');
      expect(() => makeFunction('return Date')()).toThrow(
        'Date is not defined',
      );
    }
    const probe: unknown = vm.runInContext(
      `({
        meta(message) {
          return message.constructor.constructor('return typeof Date')();
        },
      })`,
      pack.realm,
    );
    expect(
      pack.tools.deliver(
        probe,
        JSON.stringify({ type: 'meta', actorId: 'actor-1', displayName: null }),
      ),
    ).toBe('undefined');
  });

  it("演出: after init, a spawn per character and two frames, each frame's return wrapped as a draw passes drawMessageSchema, draws exactly the frame's own actors and names manifest assets", () => {
    const { draws } = perform(readManifest());
    expect(draws).toHaveLength(2);
  });

  it('亂數: the entry draws random numbers only through stage.random, for its own actors', () => {
    const manifest = readManifest();
    expect(entrySource(manifest)).not.toContain('Math.random');
    const { randomCalls, ownIds } = perform(manifest);
    expect(randomCalls.length).toBeGreaterThan(0);
    expect(randomCalls.filter((id) => !ownIds.has(id))).toStrictEqual([]);
  });
});

describe('contract pack entry', () => {
  it('handles params and meta: the new values change what is drawn', () => {
    const manifest = readManifest();
    const pack = perform(manifest);
    for (const { character } of pack.actors) {
      deliver(pack, {
        type: 'params',
        characterId: character.id,
        params: changedParams(character),
      });
    }
    deliver(pack, {
      type: 'meta',
      actorId: 'actor-1',
      displayName: '工作區乙',
    });
    const frame = frameMessage(2, pack.actors);
    const actors = checkDraw(
      manifest,
      frame,
      deliver(pack, frame),
      pack.actors,
    );
    const sprite = (actorId: string) =>
      actors[actorId]?.find((command) => command.type === 'sprite');
    expect(sprite('actor-1')).toMatchObject({ asset: 'probe-one-dots' });
    expect(sprite('actor-2')).toHaveProperty('rotation');
  });

  it('handles despawn: a frame that still lists the despawned actor does not draw it', () => {
    const manifest = readManifest();
    const pack = perform(manifest);
    deliver(pack, { type: 'despawn', actorId: 'actor-1' });
    const frame = frameMessage(2, pack.actors);
    checkDraw(
      manifest,
      frame,
      deliver(pack, frame),
      pack.actors.filter(({ actorId }) => actorId !== 'actor-1'),
    );
  });

  it('handles an init listing own actors: after the spawns, it rebuilds them, and the next frame draws exactly them', () => {
    const manifest = readManifest();
    const pack = loadPack(manifest);
    const actors = ownActors(manifest);
    for (const actor of actors) {
      deliver(pack, spawnMessage(actor));
    }
    const before = pack.randomCalls.length;
    deliver(pack, {
      type: 'init',
      actors: [
        ...actors.map(({ actorId, character }) => ({
          own: true as const,
          actorId,
          characterId: character.id,
          params: defaultParams(character),
          state: character.states[0],
          displayName: null,
        })),
        { own: false as const, actorId: OTHER_ACTOR, state: 'idle' as const },
      ],
    });
    expect(new Set(pack.randomCalls.slice(before))).toStrictEqual(
      new Set(actors.map(({ actorId }) => actorId)),
    );
    const frame = frameMessage(0, actors);
    checkDraw(manifest, frame, deliver(pack, frame), actors);
  });
});
