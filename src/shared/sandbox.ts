import {
  PACK_SCHEME,
  PACK_STAGE_HOST,
  SANDBOX_DOCUMENT_FILE,
  SANDBOX_REMOVALS_MAX,
  STAGE_LOG_MAX_LENGTH,
} from './constants';
import { idSchema, packIdSchema, packVersionSchema } from './pack-api';
import { PACK_ENTRY_FAILURE_CODES } from './packs';
import {
  SANDBOX_BOOT_FAILURES,
  SANDBOX_FAILURE_REASONS,
} from './sandbox-failures';
import { z } from './zod-setup';

export {
  SANDBOX_BOOT_FAILURES,
  SANDBOX_FAILURE_REASONS,
  type SandboxBootFailure,
  type SandboxFailureReason,
} from './sandbox-failures';

/**
 * The sandbox load chain's messages (Story 3.5, AD-7) and what the overlay
 * logs about it. Each pack with an actor on stage gets one sandbox: an
 * `<iframe sandbox="allow-scripts">` showing SANDBOX_DOCUMENT_URL, which
 * starts a classic Worker that runs the pack in an SES Compartment.
 *
 * 1. The overlay (pack-host) gets the pack's entry source from main
 *    (`packs:get-entry`), adds the iframe, and once it has loaded posts it
 *    one SandboxLoadMessage with one MessagePort.
 * 2. The iframe builds the Worker from the bootstrap and that source and
 *    hands it the port (SandboxPortMessage); it relays nothing after that.
 *    It tells the overlay only that its Worker failed (SandboxFrameNotice).
 * 3. The Worker bootstrap reports on the port how it went (SandboxReport);
 *    the pack's `stage.*` calls come on the same port.
 * 4. From then on (Story 3.6) the overlay sends the pack its stage messages
 *    on that port (before `init`, the bootstrap alone may get one
 *    SandboxBitmapCharactersMessage), and the bootstrap answers each
 *    `frame` with the pack's `draw`, its ImageBitmaps transferred, or with
 *    `sandbox.no-draw` when the pack gave none it could send. Every
 *    HEARTBEAT_TICKS world ticks the overlay also posts a SandboxPingMessage
 *    (Story 3.9), which the bootstrap answers with `sandbox.pong`.
 * 5. The overlay writes what happened to the run log (`packs:log`,
 *    PackLogEntry).
 *
 * The src/sandbox code uses only the TypeScript types of this file; the
 * overlay checks what comes back with the schemas here. (The Worker
 * bootstrap does bundle zod since Story 3.6: it checks the stage's
 * messages with the pack API's stageMessageSchema.)
 */

/** The sandbox document every pack's iframe shows. */
export const SANDBOX_DOCUMENT_URL = `${PACK_SCHEME}://${PACK_STAGE_HOST}/${SANDBOX_DOCUMENT_FILE}`;

/**
 * What the overlay posts the sandbox iframe, once, with one MessagePort:
 * the pack's entry source and nothing else (no pack id, session or actor).
 */
export interface SandboxLoadMessage {
  readonly type: 'load';
  readonly source: string;
}

/** The SandboxLoadMessage for `source`. */
export function sandboxLoadMessage(source: string): SandboxLoadMessage {
  return { type: 'load', source };
}

/** What the iframe posts its Worker, once, with the overlay's port. */
export interface SandboxPortMessage {
  readonly type: 'port';
}

/**
 * What pack-host posts the Worker on the port before the pack's `init`
 * (Story 3.6's last part), when the pack has characters with
 * `advancedBitmap`: their ids, which `stage.canvas` then answers for. Its
 * `type` starts with SANDBOX_REPORT_PREFIX, so the bootstrap takes it
 * before routing the stage's messages and the pack never sees it; one
 * with any other key is ignored.
 */
export interface SandboxBitmapCharactersMessage {
  readonly type: 'sandbox.bitmap-characters';
  readonly characterIds: readonly string[];
}

/** The SandboxBitmapCharactersMessage for `characterIds`. */
export function sandboxBitmapCharactersMessage(
  characterIds: readonly string[],
): SandboxBitmapCharactersMessage {
  return { type: 'sandbox.bitmap-characters', characterIds: [...characterIds] };
}

/**
 * What pack-host posts a ready sandbox on the port every HEARTBEAT_TICKS
 * world ticks (Story 3.9). Like SandboxBitmapCharactersMessage, its `type`
 * starts with SANDBOX_REPORT_PREFIX: the Worker bootstrap answers it at
 * once with `sandbox.pong`, outside the Compartment, and the pack never
 * sees it. A Worker busy in the pack's code (a `frame` that never
 * returns) answers none.
 */
export interface SandboxPingMessage {
  readonly type: 'sandbox.ping';
}

/** The SandboxPingMessage. */
export function sandboxPingMessage(): SandboxPingMessage {
  return { type: 'sandbox.ping' };
}

/**
 * What the iframe may post the overlay: its Worker could not be made, or
 * fired an `error` event. Nothing from the pack is in it.
 */
export interface SandboxFrameNotice {
  readonly type: 'worker-error';
}

/** Whether `data` is exactly a SandboxFrameNotice. */
export function isSandboxFrameNotice(
  data: unknown,
): data is SandboxFrameNotice {
  return (
    typeof data === 'object' &&
    data !== null &&
    Object.keys(data).length === 1 &&
    (data as { type?: unknown }).type === 'worker-error'
  );
}

// ---------------------------------------------------------------------------
// The Worker bootstrap's reports.

/**
 * What became of one API or intrinsic the bootstrap removes before
 * `lockdown()`: `removed` (it was there and is gone), `absent` (it was not
 * there) or `failed` (it is still there).
 */
export const SANDBOX_REMOVAL_STATUSES = [
  'removed',
  'absent',
  'failed',
] as const;

export type SandboxRemovalStatus = (typeof SANDBOX_REMOVAL_STATUSES)[number];

/**
 * One removal: the global's name (`fetch`) or the intrinsic's path from
 * `globalThis` (`Iterator.prototype.join`), and its status.
 */
export const sandboxRemovalSchema = z.strictObject({
  name: z
    .string()
    .max(64)
    .regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/),
  status: z.enum(SANDBOX_REMOVAL_STATUSES),
});

export type SandboxRemoval = z.infer<typeof sandboxRemovalSchema>;

const removalsSchema = z
  .array(sandboxRemovalSchema)
  .max(SANDBOX_REMOVALS_MAX)
  .readonly();

/** Removals of a sandbox that came up: at least one, none failed. */
const readyRemovalsSchema = z
  .array(sandboxRemovalSchema)
  .min(1)
  .max(SANDBOX_REMOVALS_MAX)
  .refine((removals) => removals.every((r) => r.status !== 'failed'), {
    message: 'a ready sandbox has removed everything',
  })
  .readonly();

/** Uncaught trouble in a running Worker: an `error` or an unhandled rejection. */
export const SANDBOX_FAULTS = ['error', 'unhandled-rejection'] as const;

/**
 * Why the bootstrap answered a `frame` with no `draw` (Story 3.6): the
 * pack's handlers have no `frame` function (`no-frame-handler`), reading
 * or calling it threw (`frame-threw`), it returned nothing or what it
 * returned cannot be copied or sent (`draw-not-cloneable`: an undefined,
 * a function, a Map, a promise, lists nested too deep, a bitmap sent
 * before…), the `draw` would be over DRAW_MAX_BYTES (`draw-too-large`)
 * or DRAW_MAX_COMMANDS, or hold more different ImageBitmaps than the
 * pack has own actors
 * (`draw-too-many-commands`; the bitmaps since Story 3.6's last part),
 * measured before it is posted; or the `frame` itself does not fit the
 * pack API's schema, its `seq` readable (`invalid-frame`: the pack never
 * sees it).
 */
export const SANDBOX_NO_DRAW_REASONS = [
  'no-frame-handler',
  'frame-threw',
  'draw-not-cloneable',
  'draw-too-large',
  'draw-too-many-commands',
  'invalid-frame',
] as const;

export type SandboxNoDrawReason = (typeof SANDBOX_NO_DRAW_REASONS)[number];

/**
 * The start of every SandboxReport's `type` (a `stage.*` call never has
 * it), and of pack-host's own messages to the bootstrap (a stage message
 * never has it).
 */
export const SANDBOX_REPORT_PREFIX = 'sandbox.';

/**
 * What the Worker bootstrap reports on the port, told apart by `type`:
 * - `sandbox.ready`: the pack's factory returned its `handlers`; every
 *   removal, and no console output up to the end of `lockdown()`;
 * - `sandbox.failed`: why not (the removals and console lines so far);
 * - `sandbox.fault`: uncaught trouble later on;
 * - `sandbox.no-draw` (Story 3.6): the `frame` of `seq` gets no `draw`, and
 *   why;
 * - `sandbox.pong` (Story 3.9): the answer to a SandboxPingMessage.
 */
export const sandboxReportSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('sandbox.ready'),
    removals: readyRemovalsSchema,
    consoleLines: z.literal(0),
  }),
  z.strictObject({
    type: z.literal('sandbox.failed'),
    reason: z.enum(SANDBOX_BOOT_FAILURES),
    removals: removalsSchema,
    consoleLines: z.int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('sandbox.fault'),
    fault: z.enum(SANDBOX_FAULTS),
  }),
  z.strictObject({
    type: z.literal('sandbox.no-draw'),
    seq: z.int().nonnegative(),
    reason: z.enum(SANDBOX_NO_DRAW_REASONS),
  }),
  z.strictObject({
    type: z.literal('sandbox.pong'),
  }),
]);

export type SandboxReport = z.infer<typeof sandboxReportSchema>;

// ---------------------------------------------------------------------------
// What the overlay writes to the run log (`packs:log`).
// Why a sandbox was taken down (SANDBOX_FAILURE_REASONS) is in
// sandbox-failures.ts, exported from here too.

/**
 * Why a pack with an actor on stage gets no sandbox: main's
 * `packs:get-entry` failure codes (the overlay also sees `not-installed`
 * and `api-incompatible` in StageView itself), or the request failing.
 */
export const SANDBOX_SKIP_REASONS = [
  ...PACK_ENTRY_FAILURE_CODES,
  'request-failed',
] as const;

export type SandboxSkipReason = (typeof SANDBOX_SKIP_REASONS)[number];

/**
 * Why a pack's sandbox was removed while nothing failed: SANDBOX_IDLE_MS
 * after its last actor left (`idle`), or, with its actors still there, its
 * pack is no longer installed (`not-installed`), no longer fits the stage
 * API (`api-incompatible`), or is installed at another version
 * (`version-changed`; a sandbox for that version follows).
 */
export const SANDBOX_DESTROY_REASONS = [
  'idle',
  'not-installed',
  'api-incompatible',
  'version-changed',
] as const;

export type SandboxDestroyReason = (typeof SANDBOX_DESTROY_REASONS)[number];

/**
 * Why the overlay dropped a message from a pack's sandbox: over the pack's
 * message rate, larger than PACK_MESSAGE_MAX_BYTES (a `draw`:
 * DRAW_MAX_BYTES), not a valid `stage.*` call or `draw`, an `actorId` that
 * is not the pack's (a `draw`: not one of its `frame`'s actors), a
 * `stage.log` over its own rate, or a call other than `stage.log` before
 * the sandbox reported ready (`not-ready`). And for a `draw` (Story 3.6):
 * more than DRAW_MAX_COMMANDS commands (`too-many-commands`), a sprite's
 * `asset` that is not a key of the pack's manifest (`unknown-asset`), a
 * `frame` on an image, or missing from or not in its spritesheet
 * (`unknown-frame`), a `seq` that is not the `frame` the pack is answering
 * (`stale-draw`), more than PARTICLE_EMITTERS_MAX `particles` commands
 * (`too-many-emitters`, Story 3.6's second last part); a `bitmap` for an
 * actor whose character has no `advancedBitmap` (`bitmap-not-allowed`),
 * whose `image` is not an ImageBitmap (`bitmap-not-image`), wider or
 * higher than BITMAP_MAX_SIDE (`bitmap-too-large`), or one too many: a
 * second for one actor, one image in two commands, or over
 * BITMAP_MAX_PER_SECOND for its actor (`too-many-bitmaps`; these four
 * since Story 3.6's last part); and the bootstrap's SandboxNoDrawReason
 * for a `frame` that got no `draw`.
 */
export const PACK_MESSAGE_DROP_REASONS = [
  'rate-limited',
  'too-large',
  'invalid',
  'not-own-actor',
  'log-rate-limited',
  'not-ready',
  'too-many-commands',
  'unknown-asset',
  'unknown-frame',
  'stale-draw',
  'too-many-emitters',
  'bitmap-not-allowed',
  'bitmap-not-image',
  'bitmap-too-large',
  'too-many-bitmaps',
  ...SANDBOX_NO_DRAW_REASONS,
] as const;

export type PackMessageDropReason = (typeof PACK_MESSAGE_DROP_REASONS)[number];

/**
 * Why the overlay draws none of a pack's actors, or not all of their
 * sprites (Story 3.6): an actor's character is not in StageView's
 * `characters` (`character-missing`), `packs:get-manifest` gave nothing
 * for the version installed (`manifest-unavailable`), or one of its assets
 * could not be loaded or does not fit its image (`asset-failed`, with the
 * asset's key).
 */
export const PACK_NOT_DRAWN_REASONS = [
  'character-missing',
  'manifest-unavailable',
  'asset-failed',
] as const;

export type PackNotDrawnReason = (typeof PACK_NOT_DRAWN_REASONS)[number];

/**
 * One run log line the overlay asks main for, about one pack, told apart
 * by `kind`:
 * - `stage-log`: the pack called `stage.log` (text already cut to
 *   STAGE_LOG_MAX_LENGTH; main escapes it);
 * - `sandbox-ready`: its sandbox came up, with the version and the
 *   removals;
 * - `sandbox-destroyed`: its iframe was removed for `reason` (nothing
 *   failed; SandboxDestroyReason);
 * - `sandbox-failed`: its iframe was removed because of `reason`;
 * - `sandbox-skipped`: it has an actor but gets no sandbox;
 * - `messages-dropped`: `count` messages dropped for `reason` since the
 *   last such line;
 * - `not-drawn` (Story 3.6): its actors, or some of their sprites, are not
 *   drawn, and why (once per pack and reason, until that changes).
 */
export const packLogEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('stage-log'),
    packId: packIdSchema,
    text: z.string().max(STAGE_LOG_MAX_LENGTH),
  }),
  z.strictObject({
    kind: z.literal('sandbox-ready'),
    packId: packIdSchema,
    version: packVersionSchema,
    removals: readyRemovalsSchema,
    consoleLines: z.literal(0),
  }),
  z.strictObject({
    kind: z.literal('sandbox-destroyed'),
    packId: packIdSchema,
    reason: z.enum(SANDBOX_DESTROY_REASONS),
  }),
  z.strictObject({
    kind: z.literal('sandbox-failed'),
    packId: packIdSchema,
    reason: z.enum(SANDBOX_FAILURE_REASONS),
    removals: removalsSchema.exactOptional(),
    consoleLines: z.int().nonnegative().exactOptional(),
  }),
  z.strictObject({
    kind: z.literal('sandbox-skipped'),
    packId: packIdSchema,
    reason: z.enum(SANDBOX_SKIP_REASONS),
  }),
  z.strictObject({
    kind: z.literal('messages-dropped'),
    packId: packIdSchema,
    reason: z.enum(PACK_MESSAGE_DROP_REASONS),
    count: z.int().positive(),
  }),
  z.strictObject({
    kind: z.literal('not-drawn'),
    packId: packIdSchema,
    reason: z.enum(PACK_NOT_DRAWN_REASONS),
    asset: idSchema.exactOptional(),
  }),
]);

export type PackLogEntry = z.infer<typeof packLogEntrySchema>;

/** `packs:log`'s arguments: one entry. */
export const packsLogInputSchema = z.tuple([packLogEntrySchema]);

// ---------------------------------------------------------------------------
// What the overlay asks main once a sandbox failed (Story 3.9).

/**
 * One failure of a pack's sandbox, as the overlay tells main
 * (`packs:runtime-failed`): the pack, the version its sandbox ran, and
 * why it failed (any SandboxFailureReason: a boot failure counts too).
 */
export const packRuntimeFailureSchema = z.strictObject({
  packId: packIdSchema,
  version: packVersionSchema,
  reason: z.enum(SANDBOX_FAILURE_REASONS),
});

export type PackRuntimeFailure = z.infer<typeof packRuntimeFailureSchema>;

/** `packs:runtime-failed`'s arguments: one failure. */
export const packsRuntimeFailedInputSchema = z.tuple([
  packRuntimeFailureSchema,
]);

/**
 * `packs:runtime-failed`'s answer: whether the overlay builds the pack a
 * new sandbox (`restart`), or leaves the failed one as it is.
 */
export const packRuntimeFailedResultSchema = z.strictObject({
  restart: z.boolean(),
});

export type PackRuntimeFailedResult = z.infer<
  typeof packRuntimeFailedResultSchema
>;
