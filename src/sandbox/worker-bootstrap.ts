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
 *    c. calls `lockdown()` with no options (nothing hides what SES says),
 *       and only then takes SES's `harden` and `Compartment`;
 *    d. stops here, with `sandbox.failed`, when any removal failed, SES is
 *       missing, `lockdown()` threw, or anything was printed on the
 *       console from loading SES to the end of `lockdown()`;
 *    e. evaluates the entry in a Compartment with no globals of its own:
 *       the only thing from outside a pack gets is `stage`, as the
 *       argument of its factory (docs/pack-api-v1.md, sections 6 and 10);
 *    f. calls the factory with `stage` (hardened) and checks that it
 *       returned an object, neither an array nor a thenable (`handlers`,
 *       kept for Story 3.6).
 *    Then it reports `sandbox.ready` or `sandbox.failed` with every
 *    removal's result and the console line count.
 * 4. The overlay's port arrives from the iframe (`{ type: 'port' }`, once);
 *    what was sent before it waits in an outbox. The pack's `stage.*`
 *    calls go out on the port; an uncaught `error` or unhandled rejection
 *    later on is reported as `sandbox.fault`.
 *
 * The stage sends the pack nothing yet (`init`, `frame` and the rest are
 * Story 3.6), so the pack has no actor here: `stage.random` throws for
 * every actor id, and `stage.fire`, `stage.hold` and `stage.face` reach
 * the overlay, which drops them as not the pack's actors.
 *
 * Every function takes the global scope as an argument, so the pure parts
 * are unit-tested under Node and the whole boot runs in a child process
 * (test/sandbox). Keep this file ASCII-only.
 */
import { SANDBOX_OUTBOX_MAX, STAGE_LOG_MAX_LENGTH } from '../shared/constants';
import type { StageCallType } from '../shared/pack-api';
import type {
  SandboxBootFailure,
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

/** A `stage.*` call as the pack made it: checked by the overlay, not here. */
export type StageCallMessage = { readonly type: StageCallType } & Readonly<
  Record<string, unknown>
>;

/** SES's `harden`. */
export type Harden = <T>(value: T) => T;

/**
 * The `stage` a pack's factory gets (docs/pack-api-v1.md section 8.2),
 * hardened. `post` sends a call to the overlay and throws when the
 * arguments cannot be sent; each method then throws a TypeError of its
 * own, so no host error object reaches the pack. `ownActors` are the
 * pack's actors as the stage told it (none before Story 3.6): `random`
 * answers only for those. `canvas` is null until bitmap drawing comes
 * (Story 3.6).
 */
export function createStage(
  harden: Harden,
  post: (call: StageCallMessage) => void,
  ownActors: ReadonlySet<string> = new Set(),
): object {
  const randoms = new Map<string, () => number>();
  const send = (name: string, call: StageCallMessage): void => {
    try {
      post(call);
    } catch {
      throw new TypeError(`stage.${name}: these arguments cannot be sent`);
    }
  };
  return harden({
    log(...args: unknown[]): void {
      send('log', { type: 'stage.log', text: formatLogArgs(args) });
    },
    random(actorId: unknown): number {
      if (typeof actorId !== 'string' || !ownActors.has(actorId)) {
        throw new TypeError("stage.random: not one of this pack's actors");
      }
      let next = randoms.get(actorId);
      if (next === undefined) {
        next = seededRandom(actorId);
        randoms.set(actorId, next);
      }
      return next();
    },
    canvas: null,
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
}

export interface BootOutcome {
  readonly report: SandboxReport;
  /** The pack's handlers, when ready. */
  readonly handlers?: object;
}

/** Steps 3a to 3f of the module comment. Never throws. */
export function boot(
  entrySource: string,
  { scope = globalThis, counter, post }: BootOptions,
): BootOutcome {
  const apis = REMOVED_WORKER_APIS.map((name) => removeApi(scope, name));
  const intrinsics = SES_UNKNOWN_INTRINSICS.map((path) =>
    removeIntrinsic(scope, path),
  );
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
      createStage(ses.harden, post),
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
  };
}

/** The parts of a MessagePort the Worker uses. */
export interface WorkerPort {
  postMessage(message: unknown): void;
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

/**
 * The Worker's step 3 and 4: listens for the port and for uncaught
 * trouble (reported once), boots, and reports. The boot report goes
 * first: `stage.*` calls the factory makes are sent after it. Reports
 * always wait for the port; calls made before it arrives wait too, up to
 * SANDBOX_OUTBOX_MAX (later ones are dropped). Each call is copied
 * (structured clone) when made, so arguments that cannot be sent throw at
 * the call.
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

  const deliver = (message: unknown, report: boolean): void => {
    if (port !== null) {
      port.postMessage(message);
      return;
    }
    if (report) {
      outbox.push(structuredClone(message));
    } else if (queuedCalls < SANDBOX_OUTBOX_MAX) {
      queuedCalls += 1;
      outbox.push(structuredClone(message));
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
        // Already cloned once; nothing of the pack's can fail here.
      }
    }
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
    post: (call) => {
      if (!booting) {
        deliver(call, false);
        return;
      }
      const copy = structuredClone(call);
      if (duringBoot.length < SANDBOX_OUTBOX_MAX) {
        duringBoot.push(copy);
      }
    },
  });
  booting = false;
  deliver(outcome.report, true);
  for (const call of duringBoot) {
    deliver(call, false);
  }
  return outcome;
}
