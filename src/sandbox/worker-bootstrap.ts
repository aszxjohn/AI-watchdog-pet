/**
 * The Worker bootstrap (AD-7 rule 3, Story 3.5). Bundled as a classic
 * script that defines `__awpSandboxWorker` (document.ts), it is the first
 * part of every pack Worker. In this fixed order:
 *
 * 1. countConsole(), before SES loads: every console call from then on is
 *    counted.
 * 2. (SES loads: `lockdown`, `harden` and `Compartment` appear.)
 * 3. run(entry), which boots:
 *    a. deletes each of REMOVED_WORKER_APIS along the global object's
 *       prototype chain, and shadows with undefined any that is still
 *       there;
 *    b. deletes each of SES_UNKNOWN_INTRINSICS, one by one;
 *    b2. (Story 3.6's last part; not a removal of the lists, and it fails
 *       nothing) takes the `canvas` getter off an OffscreenCanvas 2d
 *       context's prototype chain, so a context the pack gets leads to no
 *       canvas (whose constructor could open webgl), and keeps how to make
 *       canvases itself (canvasMakerOf); without OffscreenCanvas, or with
 *       `canvas` still there, `stage.canvas` always throws; and keeps the
 *       `width` getter of ImageBitmap's prototype, which tells a real
 *       ImageBitmap from anything else (bitmapBrandOf);
 *    c. calls `lockdown()` with no options (nothing hides what SES says),
 *       and only then takes SES's `harden` and `Compartment`;
 *    d. stops here, with `sandbox.failed`, when any removal failed, SES is
 *       missing, `lockdown()` threw, or anything was printed on the
 *       console from loading SES to the end of `lockdown()`;
 *    e. evaluates the entry in a Compartment with no globals of its own:
 *       the only thing from outside a pack gets is `stage`, as the
 *       argument of its factory (docs/pack-api-v1.md, sections 6 and 10);
 *    f. calls the factory with `stage` (hardened) and checks that it
 *       returned an object, neither an array nor a thenable (`handlers`).
 *    Then it reports `sandbox.ready` or `sandbox.failed` with every
 *    removal's result and the console line count.
 * 4. The overlay's port arrives from the iframe (`{ type: 'port' }`, once);
 *    what was sent before it waits in an outbox. The pack's `stage.*`
 *    calls go out on the port, each copied into plain data at the call
 *    (copyPlain, no ImageBitmap, then measured in UTF-8 bytes: one that
 *    cannot be copied or is over PACK_MESSAGE_MAX_BYTES throws a
 *    TypeError and nothing is sent, nor kept to send); an uncaught
 *    `error` or unhandled rejection later on is reported as
 *    `sandbox.fault`.
 * 5. Once ready (Story 3.6), the stage's messages come in on that port.
 *    A message whose `type` starts with `sandbox.` is pack-host's own and
 *    never reaches the pack: exactly SandboxBitmapCharactersMessage sets
 *    the characters `stage.canvas` answers for, exactly SandboxPingMessage
 *    (Story 3.9) is answered at once with `sandbox.pong` on the port
 *    (here, outside the Compartment: a Worker busy in the pack's code
 *    answers none, which is how the overlay finds it stuck), any other is
 *    ignored.
 *    Each other one that passes the pack API's stageMessageSchema goes to
 *    the pack's `handlers[type]`, when that is a function (reading it and
 *    calling it are each caught: a throwing handler stops nothing here);
 *    anything else is ignored. `init`, `spawn` and `despawn` keep the
 *    pack's own actors and their characters, which `stage.random` and
 *    `stage.canvas` answer for (`init` and `spawn` before the handler
 *    runs, `despawn` after; an actor gone takes its canvas with it). A
 *    `frame`, before its handler runs, lets `stage.snapshot` give each own
 *    actor one bitmap again. What `frame` returns is read (each place in
 *    it once) into a copy of plain data and ImageBitmaps (copyPlain; an
 *    ImageBitmap told by the brand check, whatever its prototype), and the
 *    copy goes back as `{ type: 'draw', seq, actors: <the copy> }`, the
 *    copy's ImageBitmaps transferred (each once), which the overlay checks
 *    again; a `frame` the pack gives nothing to send for (no handler, it
 *    threw, its value cannot be copied, e.g. an undefined, a Map or lists
 *    nested over COPY_MAX_DEPTH deep, or transferred, e.g. a bitmap sent
 *    before, or the copy would be over DRAW_MAX_BYTES or
 *    DRAW_MAX_COMMANDS, or hold more different ImageBitmaps than the pack
 *    has own actors, measured on the copy before it is posted, an
 *    ImageBitmap counting 2 bytes) is answered
 *    with `sandbox.no-draw` instead, and so is a `frame` that does not fit
 *    the schema but whose `seq` can be read: the overlay never waits on a
 *    frame.
 *
 * Every function takes the global scope as an argument, so the pure parts
 * are unit-tested under Node and the whole boot runs in a child process
 * (test/sandbox). Keep this file ASCII-only.
 */
import {
  BITMAP_MAX_SIDE,
  DRAW_MAX_BYTES,
  DRAW_MAX_COMMANDS,
  PACK_MESSAGE_MAX_BYTES,
  SANDBOX_OUTBOX_MAX,
  STAGE_LOG_MAX_LENGTH,
} from '../shared/constants';
import { countDrawCommands, jsonBytes } from '../shared/draw-size';
import { stageMessageSchema, type StageCallType } from '../shared/pack-api';
import type {
  SandboxBitmapCharactersMessage,
  SandboxBootFailure,
  SandboxNoDrawReason,
  SandboxPingMessage,
  SandboxRemoval,
  SandboxReport,
} from '../shared/sandbox';
import { cutText } from '../shared/text';
import { REMOVED_WORKER_APIS, SES_UNKNOWN_INTRINSICS } from './lists';

/** The console methods countConsole wraps. */
const CONSOLE_METHODS = [
  'debug',
  'log',
  'info',
  'warn',
  'error',
  'trace',
  'dir',
  'dirxml',
  'table',
  'group',
  'groupCollapsed',
  'groupEnd',
  'assert',
  'count',
  'countReset',
  'time',
  'timeLog',
  'timeEnd',
] as const;

/** Counts console calls since countConsole. */
export interface ConsoleCounter {
  lines(): number;
}

/** The counter the last countConsole started; run() reads it. */
let activeCounter: ConsoleCounter | undefined;

/**
 * Wraps each console method of `scope` so that every call is counted, and
 * returns the counter. Call it before SES loads.
 */
export function countConsole(scope: object = globalThis): ConsoleCounter {
  let lines = 0;
  const target = (scope as { console?: unknown }).console;
  if (typeof target === 'object' && target !== null) {
    const methods = target as Record<string, unknown>;
    for (const name of CONSOLE_METHODS) {
      const original = methods[name];
      if (typeof original !== 'function') {
        continue;
      }
      methods[name] = function counted(...args: unknown[]): unknown {
        lines += 1;
        return Reflect.apply(original, target, args);
      };
    }
  }
  const counter: ConsoleCounter = { lines: () => lines };
  activeCounter = counter;
  return counter;
}

/**
 * Removes the global `name` from `scope`: deletes it from every object on
 * the prototype chain that owns it, then shadows it with an undefined,
 * read-only own property if it is still reachable. `removed` when it was
 * there and now reads undefined, `absent` when it was never there,
 * `failed` otherwise. Never throws.
 */
export function removeApi(scope: object, name: string): SandboxRemoval {
  try {
    const owners: object[] = [];
    for (
      let object: object | null = scope;
      object !== null;
      object = Object.getPrototypeOf(object) as object | null
    ) {
      if (Object.prototype.hasOwnProperty.call(object, name)) {
        owners.push(object);
      }
    }
    for (const owner of owners) {
      Reflect.deleteProperty(owner, name);
    }
    let shadowed = false;
    if (name in scope) {
      Object.defineProperty(scope, name, {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      shadowed = true;
    }
    if ((scope as Record<string, unknown>)[name] !== undefined) {
      return { name, status: 'failed' };
    }
    return {
      name,
      status: owners.length === 0 && !shadowed ? 'absent' : 'removed',
    };
  } catch {
    return { name, status: 'failed' };
  }
}

/**
 * Removes the intrinsic at `path` (`Iterator.prototype.join`), walking from
 * `root`: `absent` when an owner on the way or the property itself is
 * missing, `removed` when deleted, `failed` when it cannot be. Never
 * throws.
 */
export function removeIntrinsic(root: object, path: string): SandboxRemoval {
  try {
    const segments = path.split('.');
    const property = segments.pop() as string;
    let owner: unknown = root;
    for (const segment of segments) {
      owner =
        owner === null || owner === undefined
          ? undefined
          : (owner as Record<string, unknown>)[segment];
    }
    if (
      (typeof owner !== 'object' && typeof owner !== 'function') ||
      owner === null ||
      !Object.prototype.hasOwnProperty.call(owner, property)
    ) {
      return { name: path, status: 'absent' };
    }
    return {
      name: path,
      status: Reflect.deleteProperty(owner, property) ? 'removed' : 'failed',
    };
  } catch {
    return { name: path, status: 'failed' };
  }
}

/** One `stage.log` argument as text. Never throws. */
function logPiece(value: unknown): string {
  try {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'function') {
      return '[function]';
    }
    if (typeof value !== 'object' || value === null) {
      return String(value);
    }
    if (value instanceof Error) {
      return `${String(value.name)}: ${String(value.message)}`;
    }
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return '[unprintable]';
  }
}

/**
 * The text of `stage.log(...args)`: each argument as text (a string as it
 * is, an error as `name: message`, other objects as JSON), joined by
 * spaces and cut to `max` (cutText). Never throws.
 */
export function formatLogArgs(
  args: readonly unknown[],
  max: number = STAGE_LOG_MAX_LENGTH,
): string {
  return cutText(args.map(logPiece).join(' '), max);
}

/**
 * Random numbers in [0, 1) seeded by `seed` (an actor id): FNV-1a of the
 * seed, then mulberry32. The same seed gives the same numbers.
 */
export function seededRandom(seed: string): () => number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  let state = hash | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A `stage.*` call: createStage copies and measures it first (plain data,
 * no ImageBitmap, PACK_MESSAGE_MAX_BYTES), and the overlay checks it
 * again.
 */
export type StageCallMessage = { readonly type: StageCallType } & Readonly<
  Record<string, unknown>
>;

/** SES's `harden`. */
export type Harden = <T>(value: T) => T;

/** An OffscreenCanvas, as far as the bootstrap uses one. */
export interface BitmapCanvas {
  width: number;
  height: number;
  transferToImageBitmap(): unknown;
}

/** One canvas with its 2d context (which the pack gets). */
export interface ActorCanvas {
  readonly canvas: BitmapCanvas;
  readonly context: object;
}

/**
 * Makes a canvas of `width` x `height` pixels with its 2d context, which
 * leads to no canvas; throws when it cannot.
 */
export type CanvasMaker = (width: number, height: number) => ActorCanvas;

/**
 * One of the pack's own actors, as the stage told it: its character, and
 * its canvas once `stage.canvas` made one.
 */
export interface OwnActor {
  readonly characterId: string;
  canvas?: ActorCanvas;
  /**
   * Whether `stage.snapshot` gave a bitmap of it since the latest `frame`
   * came (once a frame each; routeStageMessage clears it).
   */
  snapped?: boolean;
}

/**
 * The pack's own actors by id (`init`, `spawn`, `despawn`; read at each
 * call), which `stage.random` and `stage.canvas` answer for.
 */
export type OwnActors = Map<string, OwnActor>;

/** What `stage.canvas` and `stage.snapshot` need (Story 3.6's last part). */
export interface StageBitmaps {
  /**
   * The characters with `advancedBitmap`, as pack-host said (read at each
   * call).
   */
  readonly characters: ReadonlySet<string>;
  /** Makes the canvases; none when the Worker has none to give. */
  readonly makeCanvas?: CanvasMaker;
  /**
   * Tells the ImageBitmaps a `stage.*` call may not carry (bitmapBrandOf,
   * kept before `lockdown()`); none is told when left out.
   */
  readonly isBitmap?: BitmapBrand;
}

const NO_BITMAPS: StageBitmaps = { characters: new Set() };

/**
 * Whether a value is a real ImageBitmap, by the brand check of the
 * `width` getter bitmapBrandOf kept. Never throws, and runs none of the
 * pack's code.
 */
export type BitmapBrand = (value: unknown) => boolean;

/** Where there is no ImageBitmap: nothing is one. */
export const NO_BITMAP_BRAND: BitmapBrand = () => false;

/**
 * Keeps the `width` getter of `scope.ImageBitmap.prototype` (call it
 * before `lockdown()`, before any of the pack's code runs) and tells an
 * ImageBitmap by it: the getter throws for anything that is not one (a
 * look-alike, a Proxy of one) and answers for one whatever its prototype
 * is now, so a pack that changes a bitmap's prototype, the getter on the
 * prototype, or `Symbol.hasInstance` fools nothing (no `instanceof`
 * here). NO_BITMAP_BRAND where `scope` has no ImageBitmap with that
 * getter. Never throws.
 */
export function bitmapBrandOf(scope: object): BitmapBrand {
  try {
    const { ImageBitmap: type } = scope as { ImageBitmap?: unknown };
    if (typeof type !== 'function') {
      return NO_BITMAP_BRAND;
    }
    const { prototype } = type as { prototype?: unknown };
    if (typeof prototype !== 'object' || prototype === null) {
      return NO_BITMAP_BRAND;
    }
    const width = Object.getOwnPropertyDescriptor(prototype, 'width')?.get;
    if (typeof width !== 'function') {
      return NO_BITMAP_BRAND;
    }
    const apply = Reflect.apply;
    return (value) => {
      if (typeof value !== 'object' || value === null) {
        return false;
      }
      try {
        apply(width, value, []);
        return true;
      } catch {
        return false;
      }
    };
  } catch {
    return NO_BITMAP_BRAND;
  }
}

/**
 * How many lists and objects deep copyPlain copies, the value itself the
 * first: far more than any draw needs, and few enough that structured
 * clone, which recurses, always takes the copy.
 */
export const COPY_MAX_DEPTH = 64;

/** What copyPlain made of a value. */
export type PlainCopy =
  | {
      readonly kind: 'copied';
      /** The copy: fresh plain data, with the ImageBitmaps themselves. */
      readonly value: unknown;
      /** The ImageBitmaps in the copy, each once. */
      readonly bitmaps: readonly object[];
    }
  /** It grew over the limit while being copied: copying stopped there. */
  | { readonly kind: 'too-large' }
  /** Some part of it cannot be copied, or reading it threw. */
  | { readonly kind: 'not-plain' };

/** Whether `key` names an index of an array `length` long. */
function isIndexBelow(key: string | symbol, length: number): boolean {
  if (typeof key !== 'string') {
    return false;
  }
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

/**
 * Copies `value` (what the pack gave) into fresh plain data, reading each
 * place in it once (a getter, or a Proxy's trap, met there runs once; an
 * object it refers to from two places is read once for each), so what is
 * sent is exactly what was copied, and measured. Copied: null, booleans,
 * finite numbers, strings; arrays, their index elements only (an array
 * with any other own property, or a hole, cannot be copied); objects
 * whose prototype is Object.prototype or null, their own enumerable
 * string-keyed values (as plain objects); and, when `keepBitmaps`, each
 * ImageBitmap (`isBitmap`) itself, into the copy and into `bitmaps`.
 * Anything else (undefined, a function, a symbol, a bigint, NaN or an
 * infinity, a Map, a Set, a typed array, a Date, any other object, an
 * ImageBitmap when not `keepBitmaps`) or a read that throws makes it
 * `not-plain`; so does an object nested more than COPY_MAX_DEPTH lists
 * and objects deep, once the rest is copied. While it copies it adds up
 * about how many bytes the copy takes as JSON (never more than jsonBytes
 * counts for the copy: a string counts its length) and stops as
 * `too-large` once that is over `limit`, before reading further (a cycle,
 * nested too deep as well, or a list too long, ends there). Never throws.
 */
export function copyPlain(
  value: unknown,
  limit: number,
  isBitmap: BitmapBrand,
  keepBitmaps: boolean,
): PlainCopy {
  const tooLarge: PlainCopy = { kind: 'too-large' };
  const notPlain: PlainCopy = { kind: 'not-plain' };
  const bitmaps = new Set<object>();
  const top: { value?: unknown } = {};
  // Each part read and not copied yet, with where its copy goes and how
  // deep it is.
  const stack: [unknown, object, string, number][] = [[value, top, 'value', 1]];
  let total = 0;
  // Copied on, so a cycle still ends as too-large; never sent.
  let tooDeep = false;
  try {
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      const [item, into, key, depth] = next;
      let copy: unknown = item;
      if (typeof item === 'object' && item !== null && depth > COPY_MAX_DEPTH) {
        tooDeep = true;
      }
      if (item === null) {
        total += 4;
      } else if (typeof item === 'boolean') {
        total += item ? 4 : 5;
      } else if (typeof item === 'number') {
        if (!Number.isFinite(item)) {
          return notPlain;
        }
        total += String(item).length;
      } else if (typeof item === 'string') {
        total += item.length + 2;
      } else if (typeof item !== 'object') {
        return notPlain;
      } else if (Array.isArray(item)) {
        const { length } = item as { length: unknown };
        if (!Number.isSafeInteger(length) || (length as number) < 0) {
          return notPlain;
        }
        const size = length as number;
        total += 1 + Math.max(1, size);
        if (total > limit) {
          return tooLarge;
        }
        const keys = Reflect.ownKeys(item);
        if (
          keys.length !== size + 1 ||
          !keys.every((name) => name === 'length' || isIndexBelow(name, size))
        ) {
          return notPlain;
        }
        const values: unknown[] = [];
        for (let i = 0; i < size; i += 1) {
          values.push((item as unknown[])[i]);
        }
        const list: unknown[] = [];
        copy = list;
        for (let i = size - 1; i >= 0; i -= 1) {
          stack.push([values[i], list, String(i), depth + 1]);
        }
      } else if (isBitmap(item)) {
        // After lists: no ImageBitmap (nor a Proxy of one) is a list, and
        // each brand check of something else throws inside.
        if (!keepBitmaps) {
          return notPlain;
        }
        total += 2;
        bitmaps.add(item);
      } else {
        const prototype: unknown = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) {
          return notPlain;
        }
        const keys = Object.keys(item);
        total += 1 + Math.max(1, keys.length);
        const entries: [string, unknown][] = [];
        for (const name of keys) {
          total += name.length + 3;
          if (total > limit) {
            return tooLarge;
          }
          entries.push([name, (item as Record<string, unknown>)[name]]);
        }
        const object = {};
        copy = object;
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const [name, inner] = entries[i] as [string, unknown];
          stack.push([inner, object, name, depth + 1]);
        }
      }
      if (total > limit) {
        return tooLarge;
      }
      // Defined, not set: a key `__proto__` stays a key.
      Object.defineProperty(into, key, {
        value: copy,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  } catch {
    return notPlain;
  }
  if (tooDeep) {
    return notPlain;
  }
  return { kind: 'copied', value: top.value, bitmaps: [...bitmaps] };
}

/** Whether `value` is a whole number of pixels a canvas side may have. */
function isCanvasSide(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= BITMAP_MAX_SIDE
  );
}

/**
 * Takes `actor`'s canvas from it and shrinks that to nothing, so its
 * pixels go even while the pack keeps the context. Never throws.
 */
function releaseCanvas(actor: OwnActor | undefined): void {
  const made = actor?.canvas;
  if (actor === undefined || made === undefined) {
    return;
  }
  actor.canvas = undefined;
  try {
    made.canvas.width = 0;
    made.canvas.height = 0;
  } catch {
    // Nothing more to free.
  }
}

/**
 * The `stage` a pack's factory gets (docs/pack-api-v1.md section 8.2),
 * hardened. Each call is copied first (copyPlain, no ImageBitmap allowed:
 * `bitmaps.isBitmap` tells them) and the copy measured in UTF-8 bytes
 * (jsonBytes, up to PACK_MESSAGE_MAX_BYTES), and only the copy goes to
 * `post`, which sends it to the overlay and may throw; a call that cannot
 * be copied (an argument that is undefined, a function, a Map, an
 * ImageBitmap, nested too deep, too large...) or sent throws a TypeError
 * of the stage's own, so no host error object reaches the pack, and
 * nothing is sent. `ownActors` are the pack's actors as the stage told it
 * (`init`, `spawn`, `despawn`; read at each call): `random` answers only
 * for those.
 *
 * `canvas(actorId, width, height)` (Story 3.6's last part) gives the 2d
 * context of that actor's canvas, made at the first call, resized (and so
 * cleared) when the size differs; only for an own actor whose character
 * has `advancedBitmap`, with whole sizes of 1 to BITMAP_MAX_SIDE pixels,
 * and only where `bitmaps` can make canvases. `snapshot(actorId)` gives
 * the ImageBitmap of what that canvas holds and clears it (so each frame
 * paints it whole); only once `canvas` made it, and once a frame for each
 * actor (until routeStageMessage takes the next `frame`). Anything else
 * throws a TypeError.
 */
export function createStage(
  harden: Harden,
  post: (call: StageCallMessage) => void,
  ownActors: ReadonlyMap<string, OwnActor> = new Map(),
  bitmaps: StageBitmaps = NO_BITMAPS,
): object {
  const randoms = new Map<string, () => number>();
  const send = (name: string, call: StageCallMessage): void => {
    const refused = `stage.${name}: these arguments cannot be sent`;
    const copied = copyPlain(
      call,
      PACK_MESSAGE_MAX_BYTES,
      bitmaps.isBitmap ?? NO_BITMAP_BRAND,
      false,
    );
    if (copied.kind !== 'copied') {
      throw new TypeError(refused);
    }
    // copyPlain counts a string by its length; the limit is in UTF-8
    // bytes. The copy holds no ImageBitmap, so none is asked about.
    const bytes = jsonBytes(
      copied.value,
      PACK_MESSAGE_MAX_BYTES,
      undefined,
      NO_BITMAP_BRAND,
    );
    if (bytes === null || bytes > PACK_MESSAGE_MAX_BYTES) {
      throw new TypeError(refused);
    }
    try {
      post(copied.value as StageCallMessage);
    } catch {
      throw new TypeError(refused);
    }
  };
  const own = (name: string, actorId: unknown): OwnActor => {
    const actor =
      typeof actorId === 'string' ? ownActors.get(actorId) : undefined;
    if (actor === undefined) {
      throw new TypeError(`stage.${name}: not one of this pack's actors`);
    }
    return actor;
  };
  return harden({
    log(...args: unknown[]): void {
      send('log', { type: 'stage.log', text: formatLogArgs(args) });
    },
    random(actorId: unknown): number {
      own('random', actorId);
      let next = randoms.get(actorId as string);
      if (next === undefined) {
        next = seededRandom(actorId as string);
        randoms.set(actorId as string, next);
      }
      return next();
    },
    canvas(actorId: unknown, width: unknown, height: unknown): object {
      const actor = own('canvas', actorId);
      if (!bitmaps.characters.has(actor.characterId)) {
        throw new TypeError(
          "stage.canvas: this actor's character has no advancedBitmap",
        );
      }
      if (!isCanvasSide(width) || !isCanvasSide(height)) {
        throw new TypeError(
          `stage.canvas: width and height are whole numbers from 1 to ${BITMAP_MAX_SIDE}`,
        );
      }
      const { makeCanvas } = bitmaps;
      if (makeCanvas === undefined) {
        throw new TypeError('stage.canvas: this sandbox has no canvas');
      }
      try {
        const made = actor.canvas;
        if (made === undefined) {
          const fresh = makeCanvas(width, height);
          actor.canvas = fresh;
          return fresh.context;
        }
        if (made.canvas.width !== width || made.canvas.height !== height) {
          made.canvas.width = width;
          made.canvas.height = height;
        }
        return made.context;
      } catch {
        throw new TypeError('stage.canvas: the canvas could not be made');
      }
    },
    snapshot(actorId: unknown): unknown {
      const actor = own('snapshot', actorId);
      const made = actor.canvas;
      if (made === undefined) {
        throw new TypeError(
          'stage.snapshot: no canvas for this actor (call stage.canvas first)',
        );
      }
      if (actor.snapped === true) {
        throw new TypeError(
          'stage.snapshot: once a frame for each actor (called already since this frame came)',
        );
      }
      let image: unknown;
      try {
        image = made.canvas.transferToImageBitmap();
      } catch {
        throw new TypeError('stage.snapshot: the canvas could not be read');
      }
      actor.snapped = true;
      return image;
    },
    fire(actorId: unknown, shot: unknown): void {
      const { target, object } =
        typeof shot === 'object' && shot !== null
          ? (shot as { target?: unknown; object?: unknown })
          : { target: undefined, object: undefined };
      send('fire', { type: 'stage.fire', actorId, target, object });
    },
    hold(actorId: unknown, on: unknown): void {
      send('hold', { type: 'stage.hold', actorId, on });
    },
    face(actorId: unknown, direction: unknown): void {
      send('face', { type: 'stage.face', actorId, direction });
    },
  });
}

/**
 * Step 3b2 of the module comment: takes the `canvas` getter off the 2d
 * context of an OffscreenCanvas of `scope` (from every object on a probe
 * context's prototype chain that owns one) and gives how to make canvases
 * with that constructor, kept now; undefined when `scope` has no
 * OffscreenCanvas, its 2d context is not there, or `canvas` is still there
 * after. Each canvas made is checked the same way. Never throws.
 */
export function canvasMakerOf(scope: object): CanvasMaker | undefined {
  try {
    const { OffscreenCanvas: Canvas } = scope as { OffscreenCanvas?: unknown };
    if (typeof Canvas !== 'function') {
      return undefined;
    }
    const make = (width: number, height: number): ActorCanvas | undefined => {
      const canvas = Reflect.construct(Canvas, [width, height]) as {
        getContext(contextId: '2d'): unknown;
      };
      const context = canvas.getContext('2d');
      return typeof context === 'object' && context !== null
        ? { canvas: canvas as unknown as BitmapCanvas, context }
        : undefined;
    };
    const probe = make(1, 1);
    if (probe === undefined) {
      return undefined;
    }
    for (
      let owner: object | null = probe.context;
      owner !== null;
      owner = Object.getPrototypeOf(owner) as object | null
    ) {
      if (Object.prototype.hasOwnProperty.call(owner, 'canvas')) {
        Reflect.deleteProperty(owner, 'canvas');
      }
    }
    if ('canvas' in probe.context) {
      return undefined;
    }
    return (width, height) => {
      const made = make(width, height);
      if (made === undefined || 'canvas' in made.context) {
        throw new TypeError('no 2d context without its canvas');
      }
      return made;
    };
  } catch {
    return undefined;
  }
}

/**
 * SES's globals after `lockdown()`: `harden` appears only then, and the
 * `Compartment` to use is the one `lockdown()` leaves (one taken before it
 * would evaluate with the untamed intrinsics, `Date.now` and
 * `Math.random` included).
 */
interface LockedDown {
  readonly harden: Harden;
  readonly Compartment: new (options: { __options__: true }) => {
    evaluate(source: string): unknown;
  };
}

/** SES's `lockdown` on `scope`, or undefined. */
function lockdownOf(scope: object): (() => void) | undefined {
  const { lockdown } = scope as { lockdown?: unknown };
  return typeof lockdown === 'function' ? (lockdown as () => void) : undefined;
}

/** SES's `harden` and `Compartment` on `scope`, or undefined. */
function lockedDownOf(scope: object): LockedDown | undefined {
  const { harden, Compartment } = scope as Partial<
    Record<keyof LockedDown, unknown>
  >;
  return typeof harden === 'function' && typeof Compartment === 'function'
    ? ({ harden, Compartment } as LockedDown)
    : undefined;
}

/**
 * Whether the factory's answer is a handlers object: an object, not null,
 * not an array, and not a thenable (an async factory's promise). Reading
 * `then` runs the pack's getter; one that throws is not handlers.
 */
function isHandlersObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    return typeof (value as { then?: unknown }).then !== 'function';
  } catch {
    return false;
  }
}

export interface BootOptions {
  /** The Worker's global scope. */
  readonly scope?: object;
  /** Started before SES loaded. */
  readonly counter: ConsoleCounter;
  /** Sends one `stage.*` call to the overlay. */
  readonly post: (call: StageCallMessage) => void;
  /**
   * The pack's own actors, as the stage's messages say (run() keeps it);
   * `stage.random` and `stage.canvas` answer for these. None when left out.
   */
  readonly ownActors?: ReadonlyMap<string, OwnActor>;
  /**
   * The characters with `advancedBitmap`, as pack-host says (run() keeps
   * it); `stage.canvas` answers for their actors. None when left out.
   */
  readonly bitmapCharacters?: ReadonlySet<string>;
}

export interface BootOutcome {
  readonly report: SandboxReport;
  /** The pack's handlers, when ready. */
  readonly handlers?: object;
  /**
   * The ImageBitmap brand check kept before `lockdown()` (bitmapBrandOf),
   * when ready: routeStageMessage tells a draw's ImageBitmaps by it.
   */
  readonly isBitmap?: BitmapBrand;
}

/** Steps 3a to 3f of the module comment. Never throws. */
export function boot(
  entrySource: string,
  {
    scope = globalThis,
    counter,
    post,
    ownActors = new Map(),
    bitmapCharacters = new Set(),
  }: BootOptions,
): BootOutcome {
  const apis = REMOVED_WORKER_APIS.map((name) => removeApi(scope, name));
  const intrinsics = SES_UNKNOWN_INTRINSICS.map((path) =>
    removeIntrinsic(scope, path),
  );
  // Step 3b2: before lockdown(), and not one of the removals.
  const makeCanvas = canvasMakerOf(scope);
  const isBitmap = bitmapBrandOf(scope);
  const removals = [...apis, ...intrinsics];
  const failed = (reason: SandboxBootFailure): BootOutcome => ({
    report: {
      type: 'sandbox.failed',
      reason,
      removals,
      consoleLines: counter.lines(),
    },
  });

  if (apis.some((removal) => removal.status === 'failed')) {
    return failed('api-removal-failed');
  }
  if (intrinsics.some((removal) => removal.status === 'failed')) {
    return failed('intrinsic-removal-failed');
  }
  const lockdown = lockdownOf(scope);
  if (lockdown === undefined) {
    return failed('ses-missing');
  }
  try {
    lockdown();
  } catch {
    return failed('lockdown-threw');
  }
  if (counter.lines() > 0) {
    return failed('lockdown-output');
  }
  const ses = lockedDownOf(scope);
  if (ses === undefined) {
    return failed('ses-missing');
  }

  // From here on the pack's own code runs.
  let factory: unknown;
  try {
    factory = new ses.Compartment({ __options__: true }).evaluate(entrySource);
  } catch {
    return failed('entry-threw');
  }
  if (typeof factory !== 'function') {
    return failed('entry-not-factory');
  }
  let handlers: unknown;
  try {
    handlers = Reflect.apply(factory, undefined, [
      createStage(ses.harden, post, ownActors, {
        characters: bitmapCharacters,
        makeCanvas,
        isBitmap,
      }),
    ]);
  } catch {
    return failed('factory-threw');
  }
  if (!isHandlersObject(handlers)) {
    return failed('handlers-not-object');
  }
  return {
    report: { type: 'sandbox.ready', removals, consoleLines: 0 },
    handlers,
    isBitmap,
  };
}

/** The parts of a MessagePort the Worker uses. */
export interface WorkerPort {
  /** With `transfer`, the objects to transfer, not copy. */
  postMessage(message: unknown, transfer?: unknown[]): void;
  /** Hears the stage's messages (a real port always has it). */
  addEventListener?(
    type: 'message',
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  /** Starts the port's message queue (a real port always has it). */
  start?(): void;
}

/** What the bootstrap answers a `frame` with: the pack's `draw`. */
export interface DrawReply {
  readonly type: 'draw';
  readonly seq: number;
  /**
   * The copy of what the pack's `frame` returned (copyPlain), otherwise
   * unchecked: the overlay checks it.
   */
  readonly actors: unknown;
}

/** What the bootstrap answers a `frame` with when the pack gave no `draw`. */
export interface NoDrawReport {
  readonly type: 'sandbox.no-draw';
  readonly seq: number;
  readonly reason: SandboxNoDrawReason;
}

/**
 * Step 5 of the module comment for one message from the stage: checks it,
 * keeps `ownActors` and calls the pack's handler; a `frame` is answered
 * through `reply`, with the objects to transfer (the ImageBitmaps in the
 * copy of the `draw`, each once, told by `isBitmap`: run() gives the brand
 * check boot() kept; none is told when left out), which throws when what
 * it is given cannot be sent (then `sandbox.no-draw` follows). Never
 * throws.
 */
export function routeStageMessage(
  data: unknown,
  handlers: object,
  ownActors: OwnActors,
  reply: (message: DrawReply | NoDrawReport, transfer: unknown[]) => void,
  isBitmap: BitmapBrand = NO_BITMAP_BRAND,
): void {
  const noDraw = (seq: number, reason: SandboxNoDrawReason): void => {
    try {
      reply({ type: 'sandbox.no-draw', seq, reason }, []);
    } catch {
      // A plain report always clones; nothing is left to tell if not.
    }
  };
  const parsed = stageMessageSchema.safeParse(data);
  if (!parsed.success) {
    // The overlay waits for an answer to a frame it sent: tell it.
    const seq = frameSeqOf(data);
    if (seq !== undefined) {
      noDraw(seq, 'invalid-frame');
    }
    return;
  }
  const message = parsed.data;
  switch (message.type) {
    case 'init':
      for (const actor of ownActors.values()) {
        releaseCanvas(actor);
      }
      ownActors.clear();
      for (const actor of message.actors) {
        if (actor.own) {
          ownActors.set(actor.actorId, { characterId: actor.characterId });
        }
      }
      break;
    case 'spawn':
      releaseCanvas(ownActors.get(message.actorId));
      ownActors.set(message.actorId, { characterId: message.characterId });
      break;
    case 'frame':
      // A new frame: each own actor may be snapshot once again.
      for (const actor of ownActors.values()) {
        actor.snapped = false;
      }
      break;
    default:
      break;
  }
  let handler: unknown;
  let readThrew = false;
  try {
    handler = Reflect.get(handlers, message.type);
  } catch {
    readThrew = true;
  }
  if (message.type !== 'frame') {
    if (typeof handler === 'function') {
      try {
        Reflect.apply(handler, handlers, [message]);
      } catch {
        // The pack's own trouble; the next message goes on.
      }
    }
    if (message.type === 'despawn') {
      releaseCanvas(ownActors.get(message.actorId));
      ownActors.delete(message.actorId);
    }
    return;
  }
  const { seq } = message;
  if (readThrew) {
    noDraw(seq, 'frame-threw');
    return;
  }
  if (typeof handler !== 'function') {
    noDraw(seq, 'no-frame-handler');
    return;
  }
  let actors: unknown;
  try {
    actors = Reflect.apply(handler, handlers, [message]);
  } catch {
    noDraw(seq, 'frame-threw');
    return;
  }
  // Read once, into plain data the pack can no longer reach: what is
  // measured below is what is sent, and its ImageBitmaps are all there is
  // to transfer (none hidden where the copy does not look).
  const copied = copyPlain(actors, DRAW_MAX_BYTES, isBitmap, true);
  if (copied.kind === 'too-large') {
    noDraw(seq, 'draw-too-large');
    return;
  }
  if (copied.kind === 'not-plain') {
    noDraw(seq, 'draw-not-cloneable');
    return;
  }
  const draw: DrawReply = { type: 'draw', seq, actors: copied.value };
  // The copy's only objects not plain are the ImageBitmaps copyPlain
  // found: no need to ask the brand check again.
  const found = new Set<unknown>(copied.bitmaps);
  const bytes = jsonBytes(draw, DRAW_MAX_BYTES, undefined, (value) =>
    found.has(value),
  );
  if (bytes === null) {
    // Not met: the copy is plain data and the ImageBitmaps found.
    noDraw(seq, 'draw-not-cloneable');
    return;
  }
  if (bytes > DRAW_MAX_BYTES) {
    noDraw(seq, 'draw-too-large');
    return;
  }
  if (countDrawCommands(draw, DRAW_MAX_COMMANDS) > DRAW_MAX_COMMANDS) {
    noDraw(seq, 'draw-too-many-commands');
    return;
  }
  // Each once (copyPlain's): a list naming one twice cannot be transferred.
  const transfer = [...copied.bitmaps];
  if (transfer.length > ownActors.size) {
    // More images than the one an own actor may show (hidden in other
    // fields, say): not sent, so the stage never takes them in.
    noDraw(seq, 'draw-too-many-commands');
    return;
  }
  try {
    reply(draw, transfer);
  } catch {
    // The copy is plain data at most COPY_MAX_DEPTH deep, which clones;
    // what throws is a bitmap in it that cannot be transferred (one sent
    // before, closed): nothing of it was sent.
    noDraw(seq, 'draw-not-cloneable');
  }
}

/**
 * The `seq` of a message that says it is a `frame` (a non-negative safe
 * integer), whether or not the rest of it fits; undefined otherwise.
 */
function frameSeqOf(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const { type, seq } = data as { type?: unknown; seq?: unknown };
  return type === 'frame' && Number.isSafeInteger(seq) && (seq as number) >= 0
    ? (seq as number)
    : undefined;
}

/** A `message` event in the Worker. */
export interface WorkerMessageEvent {
  readonly data: unknown;
  readonly ports: readonly WorkerPort[];
}

/** The parts of the Worker's global scope run() uses. */
export interface WorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: WorkerMessageEvent) => void,
  ): void;
  addEventListener(
    type: 'error' | 'unhandledrejection',
    listener: () => void,
  ): void;
}

/** Whether `data` is exactly the iframe's `{ type: 'port' }`. */
function isPortMessage(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    Object.keys(data).length === 1 &&
    (data as { type?: unknown }).type === 'port'
  );
}

/** Whether `data` is pack-host's own: its `type` starts with `sandbox.`. */
function isHostMessage(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type } = data as { type?: unknown };
  return typeof type === 'string' && type.startsWith('sandbox.');
}

/**
 * The character ids of `data` when it is exactly a
 * SandboxBitmapCharactersMessage (`type` and a list of strings
 * `characterIds`, no other key), else undefined.
 */
export function bitmapCharactersOf(
  data: unknown,
): readonly string[] | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const { type, characterIds } = data as Partial<
    Record<keyof SandboxBitmapCharactersMessage, unknown>
  >;
  const expected: SandboxBitmapCharactersMessage['type'] =
    'sandbox.bitmap-characters';
  return Object.keys(data).length === 2 &&
    type === expected &&
    Array.isArray(characterIds) &&
    characterIds.every((id) => typeof id === 'string')
    ? (characterIds as string[])
    : undefined;
}

/**
 * Whether `data` is exactly a SandboxPingMessage (`type` and no other key)
 * (Story 3.9).
 */
export function isPingMessage(data: unknown): boolean {
  const expected: SandboxPingMessage['type'] = 'sandbox.ping';
  return (
    typeof data === 'object' &&
    data !== null &&
    Object.keys(data).length === 1 &&
    (data as { type?: unknown }).type === expected
  );
}

/** The bootstrap's answer to a SandboxPingMessage (Story 3.9). */
const PONG: SandboxReport = { type: 'sandbox.pong' };

/**
 * The Worker's steps 3 to 5: listens for the port and for uncaught
 * trouble (reported once), boots, and reports. The boot report goes
 * first: `stage.*` calls the factory makes are sent after it. Reports
 * always wait for the port; calls made before it arrives wait too, up to
 * SANDBOX_OUTBOX_MAX (later ones are dropped). Each call is copied into
 * plain data when made (createStage), so arguments that cannot be sent
 * throw at the call, and the copy is what waits and goes. Once the port
 * is there, pack-host's own messages on it are taken here
 * (bitmapCharactersOf; a ping is answered with a pong at once, Story
 * 3.9); once the boot gave `handlers`, the stage's
 * messages on it go to routeStageMessage, with the ImageBitmap brand
 * check the boot kept, and its answers go back with their transfer lists.
 */
export function run(
  entrySource: string,
  scope: object = globalThis,
): BootOutcome {
  const events = scope as unknown as WorkerScope;
  const counter = activeCounter ?? countConsole(scope);
  const outbox: unknown[] = [];
  /** How many `stage.*` calls (not reports) the outbox holds. */
  let queuedCalls = 0;
  let port: WorkerPort | null = null;
  /** The pack's handlers, once booted; none when the boot failed. */
  let handlers: object | undefined;
  /** The ImageBitmap brand check boot() kept before lockdown(). */
  let isBitmap: BitmapBrand = NO_BITMAP_BRAND;
  /** The pack's own actors, as the stage's messages say. */
  const ownActors: OwnActors = new Map();
  /** The characters with `advancedBitmap`, as pack-host says. */
  const bitmapCharacters = new Set<string>();

  // A call is the stage's copy already (createStage), a report the
  // bootstrap's own: neither is the pack's to change, so each waits as it
  // is.
  const deliver = (message: unknown, report: boolean): void => {
    if (port !== null) {
      port.postMessage(message);
      return;
    }
    if (report) {
      outbox.push(message);
    } else if (queuedCalls < SANDBOX_OUTBOX_MAX) {
      queuedCalls += 1;
      outbox.push(message);
    }
  };
  events.addEventListener('message', (event) => {
    const [first] = event.ports;
    if (
      port !== null ||
      !isPortMessage(event.data) ||
      event.ports.length !== 1 ||
      first === undefined
    ) {
      return;
    }
    port = first;
    for (const message of outbox.splice(0)) {
      try {
        first.postMessage(message);
      } catch {
        // Copies and reports only; nothing of the pack's can fail here.
      }
    }
    first.addEventListener?.('message', (message) => {
      const { data } = message;
      if (isHostMessage(data)) {
        if (isPingMessage(data)) {
          try {
            first.postMessage(PONG);
          } catch {
            // A plain report: it cannot fail; if it did, no pong is the
            // overlay's sign of trouble.
          }
          return;
        }
        const characterIds = bitmapCharactersOf(data);
        if (characterIds !== undefined) {
          bitmapCharacters.clear();
          for (const characterId of characterIds) {
            bitmapCharacters.add(characterId);
          }
        }
        return;
      }
      if (handlers !== undefined) {
        routeStageMessage(
          data,
          handlers,
          ownActors,
          (reply, transfer) => {
            first.postMessage(reply, transfer);
          },
          isBitmap,
        );
      }
    });
    first.start?.();
  });
  // The overlay takes the sandbox down at the first fault: one is enough.
  let faulted = false;
  const fault = (kind: 'error' | 'unhandled-rejection'): void => {
    if (!faulted) {
      faulted = true;
      deliver({ type: 'sandbox.fault', fault: kind }, true);
    }
  };
  events.addEventListener('error', () => {
    fault('error');
  });
  events.addEventListener('unhandledrejection', () => {
    fault('unhandled-rejection');
  });

  // Calls the factory makes wait until the boot report has gone first.
  let booting = true;
  const duringBoot: StageCallMessage[] = [];
  const outcome = boot(entrySource, {
    scope,
    counter,
    ownActors,
    bitmapCharacters,
    post: (call) => {
      if (!booting) {
        deliver(call, false);
        return;
      }
      if (duringBoot.length < SANDBOX_OUTBOX_MAX) {
        duringBoot.push(call);
      }
    },
  });
  booting = false;
  handlers = outcome.handlers;
  isBitmap = outcome.isBitmap ?? NO_BITMAP_BRAND;
  deliver(outcome.report, true);
  for (const call of duringBoot) {
    deliver(call, false);
  }
  return outcome;
}
