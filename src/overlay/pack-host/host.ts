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
 *   that does not fit, neither `sandbox.ready` nor `sandbox.failed`
 *   within SANDBOX_BOOT_TIMEOUT_MS of adding the iframe, and from Story
 *   3.9 the heartbeat or the draw timeout, below) removes that pack's
 *   iframe at once, with one error line, and the failed sandbox stays
 *   until main says to rebuild it (Story 3.9, below) or the pack's actors
 *   have left and SANDBOX_IDLE_MS has passed.
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
 * Story 3.9, a sandbox that stops working:
 * - The heartbeat and the draw timeout are counted in world ticks, never
 *   by the wall clock, and only in the ticks tick() handles the sandbox in
 *   (ready, the pack's look at its version come): none while the system
 *   sleeps, the screen is locked or the WebGL context is lost (the world
 *   does not tick), nor while the look has not come. (The boot timeout is
 *   not: SANDBOX_BOOT_TIMEOUT_MS of the clock from adding the iframe.)
 * - Heartbeat: every HEARTBEAT_TICKS of those ticks, after its stage
 *   messages, the sandbox gets a SandboxPingMessage, which the Worker
 *   bootstrap answers with `sandbox.pong` outside the pack's Compartment;
 *   HEARTBEAT_TIMEOUT_TICKS of them with no pong fail it
 *   (`heartbeat-timeout`). A Worker busy in any of the pack's handlers
 *   (not only `frame`) answers no ping meanwhile: the count runs from the
 *   last pong and a ping goes only every HEARTBEAT_TICKS, so a handler
 *   busy for HEARTBEAT_TIMEOUT_TICKS − HEARTBEAT_TICKS ticks (about 4
 *   seconds) or more may fail it.
 * - Draw timeout: each of those ticks in which the pack has an own actor
 *   (one the stage has told it about) is 1000 / TICK_HZ ms with no valid
 *   draw, until a valid draw (an empty one too) starts the count again;
 *   DRAW_TIMEOUT_TICKS of them (DRAW_TIMEOUT_MS) fail it
 *   (`draw-timeout`). A draw dropped for any reason (a limit gone over
 *   included), a `sandbox.no-draw` and a `frame` never answered are no
 *   valid draw, so only a pack that keeps giving none fails. A `stage.*`
 *   call over a limit is only dropped; but `stage.*` calls and draws
 *   share the pack's message rate, so a pack filling it all the time has
 *   its draws dropped too, and fails that way.
 * - Every failure, a boot failure included, once its line is written, is
 *   told to main (`packs:runtime-failed`: the pack, the version and why),
 *   which answers whether to rebuild. A yes builds the pack a new sandbox
 *   (start(), as for its first actor: its entry asked for again, then
 *   `init` with every actor on stage, so its actors keep their actorId),
 *   unless by then the pack has another sandbox (a new version, say):
 *   then nothing; or no actor: then the failed sandbox goes, so an actor
 *   coming back gets a sandbox as a first one does. A rebuild whose entry
 *   main does not hand over stays, failed (its line as for a first
 *   actor), until its actors have left and SANDBOX_IDLE_MS has passed. A
 *   call that throws or an answer that is not ok (on the console) leaves
 *   the failed sandbox as it is, and so its actors in the placeholder,
 *   until the same.
 * - A no stops the failed sandbox: it stays failed, its actors in the
 *   placeholder, until they have left and SANDBOX_IDLE_MS has passed.
 *   main says no from the version's 4th failure on, and marks the version
 *   failed (its StagePack's `runtimeFailed`; the actors main/pool swaps
 *   out leave in the same StageView, demo mode's stay); or for a version
 *   not installed now, never marked. Importing the pack again (any
 *   version, the same one included) or removing it clears the mark, and
 *   only that rebuilds a stopped sandbox: once a StageView has shown its
 *   pack's mark at its version (the last one, for a sandbox built since
 *   it came), a later one without it, where the pack is
 *   still installed at that version and has an actor, rebuilds it as a
 *   yes does (troubled until its first valid draw). The mark and the no
 *   come in either order: a mark come and gone before the no rebuilds at
 *   the no. A stopped sandbox whose mark never showed is never rebuilt
 *   this way; another version goes by the version rule above.
 * - troubled(): from the failure until the rebuilt sandbox's first valid
 *   draw, the pack's actors are drawn as the placeholder (scene.ts). A
 *   sandbox built for a pack's first actor, or for a new version, is not
 *   troubled while it boots: its actors are not drawn until it draws.
 *
 * Every line goes to the run log through `packs:log`.
 */
import {
  DRAW_TIMEOUT_TICKS,
  HEARTBEAT_TICKS,
  HEARTBEAT_TIMEOUT_TICKS,
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
import type { PackEntryResult, StagePack } from '../../shared/packs';
import {
  type PackLogEntry,
  type PackMessageDropReason,
  type PackRuntimeFailedResult,
  type PackRuntimeFailure,
  type SandboxBitmapCharactersMessage,
  sandboxBitmapCharactersMessage,
  SANDBOX_REPORT_PREFIX,
  type SandboxDestroyReason,
  type SandboxFailureReason,
  type SandboxLoadMessage,
  type SandboxPingMessage,
  sandboxPingMessage,
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
 * (Story 3.6), and its own to the bootstrap (Story 3.6's last part; the
 * ping, Story 3.9).
 */
export type SandboxPost =
  | StageMessage
  | SandboxBitmapCharactersMessage
  | SandboxPingMessage;

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
  /** Tells main a sandbox failed; whether to rebuild it (Story 3.9). */
  runtimeFailed(
    failure: PackRuntimeFailure,
  ): Promise<IpcResult<PackRuntimeFailedResult>>;
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
  /**
   * Whether `packId`'s actors are drawn as the placeholder (Story 3.9):
   * its sandbox failed, or rebuilt after a failure and has not given a
   * valid draw yet.
   */
  troubled(packId: string): boolean;
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
  /**
   * Whether it rebuilds a sandbox of the pack that failed and has not
   * given a valid draw yet (Story 3.9).
   */
  recovering: boolean;
  /** Whether main said not to rebuild it once it failed (Story 3.9). */
  stopped: boolean;
  /**
   * Its pack's failure mark at its version (Story 3.9), as the StageViews
   * since it was built have shown it: none yet, `seen` while they show
   * it, `gone` once one no longer does.
   */
  mark: 'none' | 'seen' | 'gone';
  /** The ticks handled since it became ready, for the ping (Story 3.9). */
  ticks: number;
  /** The ticks handled since the last `sandbox.pong`, or since ready. */
  sincePong: number;
  /**
   * The ticks handled with an own actor since the last valid draw, or
   * since ready.
   */
  sinceDraw: number;
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
  /** The last StageView's installed packs: a new sandbox's mark (Story 3.9). */
  let installed: StageView['packs']['installed'] = [];

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
    askRestart(sandbox, reason);
  }

  /** Asks main whether to rebuild `failed`, and does so on a yes. */
  function askRestart(failed: Sandbox, reason: SandboxFailureReason): void {
    const { packId, version } = failed;
    if (version === null) {
      // Never: a sandbox can fail only once main gave its version.
      return;
    }
    let reply: Promise<IpcResult<PackRuntimeFailedResult>>;
    try {
      reply = api.runtimeFailed({ packId, version, reason });
    } catch (error) {
      logError(`[overlay] packs:runtime-failed failed (${packId})`, error);
      return;
    }
    void reply.then(
      (result) => {
        if (!result.ok) {
          logError(
            `[overlay] packs:runtime-failed (${packId}): ${result.error.code}: ${result.error.message}`,
          );
          return;
        }
        if (result.data.restart) {
          restart(failed);
        } else {
          stop(failed);
        }
      },
      (error: unknown) => {
        logError(`[overlay] packs:runtime-failed failed (${packId})`, error);
      },
    );
  }

  /**
   * Builds `failed`'s pack a new sandbox, unless by now the pack has
   * another sandbox (or none); with no actor, `failed` goes instead, so
   * an actor coming back gets a sandbox as a first one does.
   */
  function restart(failed: Sandbox): void {
    if (sandboxes.get(failed.packId) !== failed) {
      return;
    }
    if (!owners.has(failed.packId)) {
      // Its iframe went at the failure: no line.
      destroy(failed, 'idle');
      return;
    }
    keep(failed);
    void start(failed.packId, true);
  }

  /**
   * main said not to rebuild `failed` (Story 3.9): it stays failed. Its
   * pack's mark come and gone already (imported again while main was
   * answering) rebuilds it now, as restart() does.
   */
  function stop(failed: Sandbox): void {
    if (sandboxes.get(failed.packId) !== failed) {
      return;
    }
    failed.stopped = true;
    if (failed.mark === 'gone') {
      restart(failed);
    }
  }

  /**
   * Follows `sandbox`'s pack's failure mark (Story 3.9) in a StageView
   * where the pack is `pack` (undefined: not installed).
   */
  function followMark(sandbox: Sandbox, pack: StagePack | undefined): void {
    if (pack?.runtimeFailed !== undefined && pack.version === sandbox.version) {
      sandbox.mark = 'seen';
    } else if (sandbox.mark === 'seen') {
      sandbox.mark = 'gone';
    }
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

  /**
   * Main did not hand the entry over: no sandbox until the actors leave.
   * A rebuild (Story 3.9) stays, failed, so its actors stay in the
   * placeholder; the idle rules remove it once they have left.
   */
  function noEntry(sandbox: Sandbox, reason: SandboxSkipReason): void {
    if (sandbox.recovering) {
      sandbox.phase = 'failed';
    } else {
      sandboxes.delete(sandbox.packId);
      keep(sandbox);
    }
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
      case 'sandbox.pong':
        if (sandbox.phase !== 'ready') {
          fail(sandbox, 'bad-report');
          return;
        }
        sandbox.sincePong = 0;
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
    sandbox.sinceDraw = 0;
    sandbox.recovering = false;
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

  /**
   * Builds `packId` a sandbox; `recovering` when it replaces one that
   * failed (Story 3.9).
   */
  async function start(packId: string, recovering = false): Promise<void> {
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
      recovering,
      stopped: false,
      mark: 'none',
      ticks: 0,
      sincePong: 0,
      sinceDraw: 0,
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
    // Built while its pack is marked (demo mode, after the wait): the mark
    // is in the last StageView already, and no later one may come.
    followMark(
      sandbox,
      installed.find(({ id }) => id === packId),
    );
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
      installed = view.packs.installed;
      owners = actorsByPack(view.actors);
      // Every sandbox's, with an actor or not: the actors main/pool swaps
      // out leave in the StageView that brings the mark (Story 3.9).
      for (const sandbox of sandboxes.values()) {
        followMark(
          sandbox,
          view.packs.installed.find(({ id }) => id === sandbox.packId),
        );
      }
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
            if (sandbox.stopped && sandbox.mark === 'gone') {
              // Imported again at this version (Story 3.9).
              restart(sandbox);
            }
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
        // A tick handled (Story 3.9): the heartbeat and the draw timeout.
        sandbox.ticks += 1;
        sandbox.sincePong += 1;
        if (sandbox.stage.actors.size > 0) {
          sandbox.sinceDraw += 1;
        }
        if (sandbox.sincePong >= HEARTBEAT_TIMEOUT_TICKS) {
          fail(sandbox, 'heartbeat-timeout');
          continue;
        }
        if (sandbox.sinceDraw >= DRAW_TIMEOUT_TICKS) {
          fail(sandbox, 'draw-timeout');
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
        if (sandbox.ticks % HEARTBEAT_TICKS === 0) {
          messages.push(sandboxPingMessage());
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

    troubled(packId) {
      const sandbox = sandboxes.get(packId);
      return (
        sandbox !== undefined &&
        (sandbox.phase === 'failed' || sandbox.recovering)
      );
    },
  };
}
