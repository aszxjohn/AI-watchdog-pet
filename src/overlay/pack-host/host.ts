/**
 * pack-host (Story 3.5, AD-7): the overlay's owner of the packs' sandboxes.
 * It follows StageView's `actors` and `packs` and keeps one sandbox per
 * pack that has an actor on stage. The iframes, timers and main come in as
 * arguments (dom.ts makes the real iframes), so it is unit-tested under
 * Node with fakes.
 *
 * - A pack's first actor: unless the pack is not installed or does not fit
 *   this stage's API (one line each, until that changes or its actors
 *   leave), pack-host asks main for its entry (`packs:get-entry`), then
 *   adds the iframe; once the iframe has loaded it hands over, in one
 *   message with one port, the entry source and nothing else. The
 *   bootstrap's `sandbox.ready` gives the "sandbox ready" line; main
 *   refusing the entry gives one line and no sandbox until the pack's
 *   actors have left.
 * - More actors of the same pack share its sandbox; each pack has its own.
 * - A pack's last actor leaving starts SANDBOX_IDLE_MS; an actor of it
 *   coming back in that time keeps the sandbox, otherwise its iframe is
 *   removed (a "sandbox destroyed" line). Removing the iframe ends its
 *   Worker; nothing calls `worker.terminate()`.
 * - A pack removed, no longer fitting the stage API, or installed at
 *   another version while its actors stay: its sandbox goes at once (a
 *   "sandbox destroyed" line with why), then the rules above apply (a
 *   skip line, or a sandbox for the new version).
 * - A failure (the bootstrap's `sandbox.failed`, an uncaught error or
 *   rejection in the Worker, the iframe saying its Worker failed, a report
 *   that does not fit, or neither `sandbox.ready` nor `sandbox.failed`
 *   within SANDBOX_BOOT_TIMEOUT_MS of adding the iframe) removes that
 *   pack's iframe at once, with one error line. The pack gets no new sandbox until its actors have left and
 *   SANDBOX_IDLE_MS has passed (rebuilding, with its limit, is Story 3.9).
 * - Every other message from a sandbox is a pack's `stage.*` call, checked
 *   in this order: the pack's message rate (PACK_MESSAGE_RATE_LIMIT), its
 *   size and the shared schema, and an `actorId` of the pack's own actors
 *   in StageView (with none on stage, none is the pack's). A message that
 *   fails is dropped whole; drops are logged at most once per pack and
 *   reason in PACK_DROP_LOG_INTERVAL_MS, the next line counting those in
 *   between. `stage.log` has its own rate (STAGE_LOG_RATE_LIMIT) and goes
 *   to the run log, cut to STAGE_LOG_MAX_LENGTH, with the pack id; `fire`,
 *   `hold` and `face` go to `onCall` (their world behaviour is Epic 4),
 *   and only once the sandbox has reported ready (before it: `not-ready`).
 *
 * Story 3.6, the stage's side of a ready sandbox:
 * - Each world tick (tick()) sends every ready pack whose look has come
 *   (looks.ts: its manifest at the sandbox's version) its messages, worked
 *   out by stage-messages.ts from what it sent before: `init` first, then
 *   `despawn`, `params`, `spawn`, `meta` as things change, and a `frame`
 *   unless the previous one is still unanswered (no queue: a slow pack
 *   only skips ticks, and no other pack waits for it). Before the `init`,
 *   a pack with characters with `advancedBitmap` gets their ids, for its
 *   bootstrap alone (SandboxBitmapCharactersMessage, Story 3.6's last
 *   part).
 * - A message of `type: 'draw'` answers the unanswered `frame` when its
 *   `seq` is that frame's (any other is `stale-draw`), and is then checked
 *   (draw-rules.ts, with each of that frame's actors' character as the
 *   stage had told the pack, and each actor's window of
 *   BITMAP_MAX_PER_SECOND, which counts the bitmaps of every draw that
 *   passes); one that passes is the pack's latest valid draw, which the
 *   renderer draws every display frame (drawOf()) until the next one
 *   passes. The bootstrap's `sandbox.no-draw` answers the frame too, and
 *   counts as a drop of its reason. Drops go through the same per-reason
 *   log limit as above.
 * - Every ImageBitmap of a message that is not kept (a `draw` dropped for
 *   any reason, a `stage.*` call dropped, or anything that comes once its
 *   sandbox is gone) is closed at once. The bitmaps of a draw kept are the
 *   renderer's to close once shown; one replaced before it was shown goes
 *   to the garbage collector.
 * - A sandbox destroyed or failed takes its latest draw and its unanswered
 *   frame with it.
 *
 * Every line goes to the run log through `packs:log`.
 */
import {
  PACK_DROP_LOG_INTERVAL_MS,
  SANDBOX_BOOT_TIMEOUT_MS,
  PACK_MESSAGE_RATE_LIMIT,
  PACK_MESSAGE_RATE_WINDOW_MS,
  SANDBOX_IDLE_MS,
  STAGE_LOG_MAX_LENGTH,
  STAGE_LOG_RATE_LIMIT,
  STAGE_LOG_RATE_WINDOW_MS,
} from '../../shared/constants';
import type { IpcResult } from '../../shared/ipc';
import type { StageCall, StageMessage } from '../../shared/pack-api';
import type { PackEntryResult } from '../../shared/packs';
import {
  type PackLogEntry,
  type PackMessageDropReason,
  type SandboxBitmapCharactersMessage,
  sandboxBitmapCharactersMessage,
  SANDBOX_REPORT_PREFIX,
  type SandboxDestroyReason,
  type SandboxFailureReason,
  type SandboxLoadMessage,
  type SandboxRemoval,
  sandboxLoadMessage,
  sandboxReportSchema,
  type SandboxSkipReason,
} from '../../shared/sandbox';
import type { StageView } from '../../shared/stage-view';
import { cutText } from '../../shared/text';
import type { Looks } from '../looks';
import type { WorldTick } from '../world/world';
import {
  type BitmapWindow,
  checkDraw,
  closeBitmaps,
  createBitmapWindow,
  type DrawnActors,
} from './draw-rules';
import { createPackLog } from './log';
import {
  actorsByPack,
  checkPackMessage,
  createRateLimiter,
  type RateLimiter,
} from './rules';
import {
  composeTick,
  newPackStageState,
  type PackStageState,
} from './stage-messages';

/** What one sandbox iframe tells pack-host. */
export interface SandboxFrameHandlers {
  /** The iframe's document has loaded. */
  onLoad(): void;
  /** A message came on pack-host's end of the port. */
  onMessage(data: unknown): void;
  /** The iframe says its Worker could not be made or failed. */
  onWorkerError(): void;
}

/**
 * What pack-host posts on its end of a sandbox's port: the stage messages
 * (Story 3.6), and its own to the bootstrap (Story 3.6's last part).
 */
export type SandboxPost = StageMessage | SandboxBitmapCharactersMessage;

/** One sandbox iframe. */
export interface SandboxFrame {
  /**
   * Posts `message` to the iframe with one end of a new MessageChannel;
   * what comes on the other end goes to onMessage.
   */
  hand(message: SandboxLoadMessage): void;
  /**
   * Posts one message on pack-host's end of the port (Story 3.6); nothing
   * before hand(). Throws when it cannot be sent.
   */
  post(message: SandboxPost): void;
  /** Removes the iframe (its Worker goes with it) and closes the port. */
  remove(): void;
}

/** Makes the sandbox iframes (dom.ts). */
export interface SandboxFrames {
  /**
   * Adds a hidden `<iframe sandbox="allow-scripts">` showing the sandbox
   * document.
   */
  create(handlers: SandboxFrameHandlers): SandboxFrame;
}

/** `window.awp.packs`. */
export interface PackHostApi {
  getEntry(packId: string): Promise<IpcResult<PackEntryResult>>;
  log(entry: PackLogEntry): Promise<IpcResult<null>>;
}

/** A monotonic clock in milliseconds, with timers. */
export interface PackHostClock {
  now(): number;
  setTimer(run: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface PackHostOptions {
  readonly api: PackHostApi;
  readonly frames: SandboxFrames;
  readonly clock: PackHostClock;
  /**
   * Each pack's look at the version installed (looks.ts); without it no
   * pack gets any stage message.
   */
  readonly looks?: Pick<Looks, 'get'>;
  /** Hears each accepted `fire`, `hold` and `face` (Epic 4 acts on them). */
  readonly onCall?: (packId: string, call: StageCall) => void;
  /** Where a `packs:log` that failed is reported (the console). */
  readonly logError?: (message: string, ...details: unknown[]) => void;
}

/** Where one pack's sandbox is. */
export type SandboxPhase = 'requesting' | 'loading' | 'ready' | 'failed';

/** A pack's latest valid draw (Story 3.6). */
export interface PackDraw {
  /** The version of the pack that drew it. */
  readonly version: string;
  /**
   * Each actor's sprite, particles and bitmap commands; an actor left out
   * is not drawn.
   */
  readonly actors: DrawnActors;
}

export interface PackHost {
  /** Follows a StageView state: its `actors`, `packs` and `characters`. */
  onView(view: Pick<StageView, 'actors' | 'packs' | 'characters'>): void;
  /** One world tick: each ready pack gets its messages (Story 3.6). */
  tick(tick: WorldTick): void;
  /** The latest valid draw of `packId`'s ready sandbox, if any. */
  drawOf(packId: string): PackDraw | undefined;
  /** Each pack with a sandbox (or one on its way, or failed), by id. */
  phases(): ReadonlyMap<string, SandboxPhase>;
}

interface Sandbox {
  readonly packId: string;
  phase: SandboxPhase;
  version: string | null;
  /** The entry, until it is handed over. */
  source: string | null;
  frame: SandboxFrame | null;
  /** The idle timer, while the pack has no actor. */
  idle: unknown;
  /** The boot timer, from adding the iframe to its ready or failed report. */
  boot: unknown;
  readonly messages: RateLimiter;
  readonly logs: RateLimiter;
  readonly drops: Map<
    PackMessageDropReason,
    { loggedAt: number; suppressed: number }
  >;
  /** What the stage has sent the pack (Story 3.6). */
  readonly stage: PackStageState;
  /** The pack's latest valid draw. */
  draw: PackDraw | null;
  /**
   * The character of each actor of the unanswered `frame`, as the stage
   * had told the pack when it sent it.
   */
  frameCharacters: ReadonlyMap<string, string>;
  /** Each actor's bitmaps of the draws that passed, over a sliding window. */
  readonly bitmaps: BitmapWindow;
}

/** Why a pack with an actor has no sandbox; `sticky` until its actors leave. */
interface Skip {
  readonly reason: SandboxSkipReason;
  readonly sticky: boolean;
}

const NO_ACTORS: ReadonlySet<string> = new Set();

/** No look: no pack gets a stage message. */
const NO_LOOKS: Pick<Looks, 'get'> = { get: () => undefined };

/** Whether `data` is a pack's `draw` (by its `type`). */
function isDraw(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'draw'
  );
}

/** Whether `data` is one of the bootstrap's reports (by its `type`). */
function isReport(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type } = data as { type?: unknown };
  return typeof type === 'string' && type.startsWith(SANDBOX_REPORT_PREFIX);
}

export function createPackHost({
  api,
  frames,
  clock,
  looks = NO_LOOKS,
  onCall = () => {},
  logError = console.error,
}: PackHostOptions): PackHost {
  const sandboxes = new Map<string, Sandbox>();
  const skips = new Map<string, Skip>();
  /** The last StageView's actors by pack. */
  let owners = new Map<string, Set<string>>();
  /** The last StageView's actors and characters. */
  let latest: Pick<StageView, 'actors' | 'characters'> = {
    actors: [],
    characters: {},
  };

  /** Asks main to write `entry` to the run log; failures go to the console. */
  const log = createPackLog(api, logError);

  function skip(packId: string, reason: SandboxSkipReason, sticky: boolean) {
    if (skips.get(packId)?.reason === reason) {
      return;
    }
    skips.set(packId, { reason, sticky });
    log({ kind: 'sandbox-skipped', packId, reason });
  }

  function removeFrame(sandbox: Sandbox): void {
    const { frame } = sandbox;
    sandbox.frame = null;
    sandbox.source = null;
    if (frame === null) {
      return;
    }
    try {
      frame.remove();
    } catch (error) {
      logError(`[overlay] could not remove a sandbox iframe`, error);
    }
  }

  function flushDrops(sandbox: Sandbox): void {
    for (const [reason, entry] of sandbox.drops) {
      if (entry.suppressed > 0) {
        log({
          kind: 'messages-dropped',
          packId: sandbox.packId,
          reason,
          count: entry.suppressed,
        });
        entry.suppressed = 0;
      }
    }
  }

  function drop(sandbox: Sandbox, reason: PackMessageDropReason): void {
    const now = clock.now();
    const entry = sandbox.drops.get(reason);
    if (
      entry !== undefined &&
      now - entry.loggedAt < PACK_DROP_LOG_INTERVAL_MS
    ) {
      entry.suppressed += 1;
      return;
    }
    sandbox.drops.set(reason, { loggedAt: now, suppressed: 0 });
    log({
      kind: 'messages-dropped',
      packId: sandbox.packId,
      reason,
      count: (entry?.suppressed ?? 0) + 1,
    });
  }

  function fail(
    sandbox: Sandbox,
    reason: SandboxFailureReason,
    details: {
      readonly removals?: readonly SandboxRemoval[];
      readonly consoleLines?: number;
    } = {},
  ): void {
    if (
      sandbox.phase === 'failed' ||
      sandboxes.get(sandbox.packId) !== sandbox
    ) {
      return;
    }
    sandbox.phase = 'failed';
    sandbox.draw = null;
    sandbox.stage.inFlight = null;
    stopBootTimer(sandbox);
    removeFrame(sandbox);
    flushDrops(sandbox);
    log({ kind: 'sandbox-failed', packId: sandbox.packId, reason, ...details });
  }

  function stopBootTimer(sandbox: Sandbox): void {
    if (sandbox.boot !== undefined) {
      clock.clearTimer(sandbox.boot);
      sandbox.boot = undefined;
    }
  }

  function destroy(sandbox: Sandbox, reason: SandboxDestroyReason): void {
    if (sandboxes.get(sandbox.packId) !== sandbox) {
      return;
    }
    sandboxes.delete(sandbox.packId);
    keep(sandbox);
    stopBootTimer(sandbox);
    const hadFrame = sandbox.frame !== null;
    removeFrame(sandbox);
    flushDrops(sandbox);
    if (hadFrame) {
      log({ kind: 'sandbox-destroyed', packId: sandbox.packId, reason });
    }
  }

  function startIdle(sandbox: Sandbox): void {
    if (sandbox.idle === undefined) {
      sandbox.idle = clock.setTimer(() => {
        sandbox.idle = undefined;
        destroy(sandbox, 'idle');
      }, SANDBOX_IDLE_MS);
    }
  }

  function keep(sandbox: Sandbox): void {
    if (sandbox.idle !== undefined) {
      clock.clearTimer(sandbox.idle);
      sandbox.idle = undefined;
    }
  }

  /** Main did not hand the entry over: no sandbox until the actors leave. */
  function noEntry(sandbox: Sandbox, reason: SandboxSkipReason): void {
    sandboxes.delete(sandbox.packId);
    keep(sandbox);
    if (owners.has(sandbox.packId)) {
      skip(sandbox.packId, reason, true);
    }
  }

  function handOver(sandbox: Sandbox): void {
    const { frame, source } = sandbox;
    if (sandbox.phase !== 'loading' || frame === null || source === null) {
      return;
    }
    sandbox.source = null;
    try {
      frame.hand(sandboxLoadMessage(source));
    } catch {
      fail(sandbox, 'worker-error');
    }
  }

  function report(sandbox: Sandbox, data: unknown): void {
    const parsed = sandboxReportSchema.safeParse(data);
    if (!parsed.success) {
      fail(sandbox, 'bad-report');
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'sandbox.ready':
        if (sandbox.phase !== 'loading' || sandbox.version === null) {
          fail(sandbox, 'bad-report');
          return;
        }
        sandbox.phase = 'ready';
        stopBootTimer(sandbox);
        log({
          kind: 'sandbox-ready',
          packId: sandbox.packId,
          version: sandbox.version,
          removals: message.removals,
          consoleLines: message.consoleLines,
        });
        return;
      case 'sandbox.failed':
        fail(sandbox, message.reason, {
          removals: message.removals,
          consoleLines: message.consoleLines,
        });
        return;
      case 'sandbox.fault':
        fail(
          sandbox,
          message.fault === 'error' ? 'worker-error' : 'unhandled-rejection',
        );
        return;
      case 'sandbox.no-draw':
        if (sandbox.phase !== 'ready') {
          fail(sandbox, 'bad-report');
          return;
        }
        if (sandbox.stage.inFlight?.seq !== message.seq) {
          drop(sandbox, 'stale-draw');
          return;
        }
        sandbox.stage.inFlight = null;
        drop(sandbox, message.reason);
        return;
    }
  }

  /** A `draw` from the pack (see the module comment). */
  function receiveDraw(sandbox: Sandbox, data: unknown): void {
    const { inFlight } = sandbox.stage;
    const answering =
      inFlight !== null && (data as { seq?: unknown }).seq === inFlight.seq;
    if (answering) {
      sandbox.stage.inFlight = null;
    }
    if (!sandbox.messages.take()) {
      closeBitmaps(data);
      drop(sandbox, 'rate-limited');
      return;
    }
    const look = looks.get(sandbox.packId);
    if (
      !answering ||
      sandbox.phase !== 'ready' ||
      sandbox.version === null ||
      look === undefined ||
      look.version !== sandbox.version
    ) {
      closeBitmaps(data);
      drop(sandbox, 'stale-draw');
      return;
    }
    const characters = sandbox.frameCharacters;
    const check = checkDraw(data, inFlight.actors, look, {
      characterOf: (actorId) => characters.get(actorId),
      bitmapAllowance: (actorId) => sandbox.bitmaps.allowance(actorId),
    });
    if (!check.ok) {
      closeBitmaps(data);
      drop(sandbox, check.reason);
      return;
    }
    sandbox.bitmaps.take(
      [...check.actors]
        .filter(([, commands]) =>
          commands.some((command) => command.type === 'bitmap'),
        )
        .map(([actorId]) => actorId),
    );
    sandbox.draw = { version: sandbox.version, actors: check.actors };
  }

  function receive(sandbox: Sandbox, data: unknown): void {
    if (sandboxes.get(sandbox.packId) !== sandbox || sandbox.frame === null) {
      closeBitmaps(data);
      return;
    }
    if (isReport(data)) {
      report(sandbox, data);
      return;
    }
    if (isDraw(data)) {
      receiveDraw(sandbox, data);
      return;
    }
    if (!sandbox.messages.take()) {
      closeBitmaps(data);
      drop(sandbox, 'rate-limited');
      return;
    }
    const check = checkPackMessage(
      data,
      owners.get(sandbox.packId) ?? NO_ACTORS,
    );
    if (!check.ok) {
      // A snapshot passed to stage.fire, hold or face: never a valid call.
      closeBitmaps(data);
      drop(sandbox, check.reason);
      return;
    }
    const { call } = check;
    if (call.type !== 'stage.log') {
      if (sandbox.phase === 'ready') {
        onCall(sandbox.packId, call);
      } else {
        drop(sandbox, 'not-ready');
      }
      return;
    }
    if (!sandbox.logs.take()) {
      drop(sandbox, 'log-rate-limited');
      return;
    }
    log({
      kind: 'stage-log',
      packId: sandbox.packId,
      text: cutText(call.text, STAGE_LOG_MAX_LENGTH),
    });
  }

  async function start(packId: string): Promise<void> {
    const sandbox: Sandbox = {
      packId,
      phase: 'requesting',
      version: null,
      source: null,
      frame: null,
      idle: undefined,
      boot: undefined,
      messages: createRateLimiter(
        PACK_MESSAGE_RATE_LIMIT,
        PACK_MESSAGE_RATE_WINDOW_MS,
        () => clock.now(),
      ),
      logs: createRateLimiter(
        STAGE_LOG_RATE_LIMIT,
        STAGE_LOG_RATE_WINDOW_MS,
        () => clock.now(),
      ),
      drops: new Map(),
      stage: newPackStageState(),
      draw: null,
      frameCharacters: new Map(),
      bitmaps: createBitmapWindow(() => clock.now()),
    };
    sandboxes.set(packId, sandbox);
    let result: IpcResult<PackEntryResult> | undefined;
    try {
      result = await api.getEntry(packId);
    } catch (error) {
      logError(`[overlay] packs:get-entry failed`, error);
    }
    if (sandboxes.get(packId) !== sandbox) {
      // Destroyed while main was answering.
      return;
    }
    if (result === undefined || !result.ok) {
      noEntry(sandbox, 'request-failed');
      return;
    }
    const entry = result.data;
    if (!entry.ok) {
      noEntry(sandbox, entry.code);
      return;
    }
    if (entry.packId !== packId) {
      noEntry(sandbox, 'request-failed');
      return;
    }
    sandbox.phase = 'loading';
    sandbox.version = entry.version;
    sandbox.source = entry.source;
    try {
      sandbox.frame = frames.create({
        onLoad: () => {
          handOver(sandbox);
        },
        onMessage: (data) => {
          receive(sandbox, data);
        },
        onWorkerError: () => {
          fail(sandbox, 'worker-error');
        },
      });
      sandbox.boot = clock.setTimer(() => {
        sandbox.boot = undefined;
        fail(sandbox, 'boot-timeout');
      }, SANDBOX_BOOT_TIMEOUT_MS);
    } catch (error) {
      logError(`[overlay] could not add a sandbox iframe`, error);
      fail(sandbox, 'worker-error');
    }
  }

  /** Posts `messages` to `sandbox` in order; a failure fails the sandbox. */
  function post(sandbox: Sandbox, messages: readonly SandboxPost[]): void {
    for (const message of messages) {
      const { frame } = sandbox;
      if (frame === null || sandbox.phase !== 'ready') {
        return;
      }
      try {
        frame.post(message);
      } catch (error) {
        logError(`[overlay] could not post to a sandbox`, error);
        fail(sandbox, 'worker-error');
        return;
      }
    }
  }

  return {
    onView(view) {
      latest = { actors: view.actors, characters: view.characters };
      owners = actorsByPack(view.actors);
      for (const packId of owners.keys()) {
        const pack = view.packs.installed.find(({ id }) => id === packId);
        const sandbox = sandboxes.get(packId);
        if (sandbox !== undefined) {
          const gone =
            pack === undefined
              ? 'not-installed'
              : !pack.compatibility.compatible
                ? 'api-incompatible'
                : sandbox.version !== null && sandbox.version !== pack.version
                  ? 'version-changed'
                  : null;
          if (gone === null) {
            keep(sandbox);
            continue;
          }
          // Its pack's code must not keep running: the usual rules below
          // then skip the pack or build a sandbox for the new version.
          destroy(sandbox, gone);
        }
        const skipped = skips.get(packId);
        if (skipped?.sticky === true) {
          continue;
        }
        if (pack === undefined) {
          skip(packId, 'not-installed', false);
          continue;
        }
        if (!pack.compatibility.compatible) {
          skip(packId, 'api-incompatible', false);
          continue;
        }
        skips.delete(packId);
        void start(packId);
      }
      for (const sandbox of sandboxes.values()) {
        if (!owners.has(sandbox.packId)) {
          startIdle(sandbox);
        }
      }
      for (const packId of skips.keys()) {
        if (!owners.has(packId)) {
          skips.delete(packId);
        }
      }
    },

    tick({ t, events }) {
      for (const sandbox of sandboxes.values()) {
        if (sandbox.phase !== 'ready' || sandbox.frame === null) {
          continue;
        }
        const look = looks.get(sandbox.packId);
        if (look === undefined || look.version !== sandbox.version) {
          continue;
        }
        const messages: SandboxPost[] = [];
        if (!sandbox.stage.inited) {
          const bitmapCharacters = look.manifest.characters
            .filter((character) => character.advancedBitmap === true)
            .map((character) => character.id);
          if (bitmapCharacters.length > 0) {
            messages.push(sandboxBitmapCharactersMessage(bitmapCharacters));
          }
        }
        const before = sandbox.stage.inFlight;
        messages.push(
          ...composeTick(sandbox.stage, {
            packId: sandbox.packId,
            actors: latest.actors,
            characters: latest.characters,
            character: (characterId) => look.character(characterId),
            t,
            events,
          }),
        );
        const sent = sandbox.stage.inFlight;
        if (sent !== null && sent !== before) {
          // A new frame: its actors' characters as the pack knows them.
          sandbox.frameCharacters = new Map(
            [...sent.actors].flatMap((actorId) => {
              const characterId =
                sandbox.stage.actors.get(actorId)?.characterId;
              return characterId === undefined ? [] : [[actorId, characterId]];
            }),
          );
        }
        post(sandbox, messages);
      }
    },

    drawOf(packId) {
      const sandbox = sandboxes.get(packId);
      return sandbox?.phase === 'ready' && sandbox.draw !== null
        ? sandbox.draw
        : undefined;
    },

    phases() {
      return new Map(
        [...sandboxes.values()].map(({ packId, phase }) => [packId, phase]),
      );
    },
  };
}
