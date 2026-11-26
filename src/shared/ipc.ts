import { sessionKeySchema } from './detection-events';
import {
  packEntryResultSchema,
  packManifestResultSchema,
  packRemoveResultSchema,
  packsConfirmInputSchema,
  packsExportInputSchema,
  packsGetEntryInputSchema,
  packsGetManifestInputSchema,
  packsRemoveInputSchema,
} from './packs';
import { poolSetReleasedInputSchema } from './pool';
import {
  packRuntimeFailedResultSchema,
  packsLogInputSchema,
  packsRuntimeFailedInputSchema,
} from './sandbox';
import {
  settingsPatchResultSchema,
  settingsPatchSchema,
  settingsStateSchema,
} from './settings';
import { stageViewDeltaSchema, stageViewSnapshotSchema } from './stage-view';
import { z } from './zod-setup';

/**
 * IPC channel names are `<domain>:<action>`, each part lower-case kebab-case
 * (Consistency Conventions).
 */
export const IPC_CHANNEL_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isIpcChannelName(name: string): boolean {
  return IPC_CHANNEL_PATTERN.test(name);
}

export const ipcErrorCodeSchema = z.enum([
  // main: senderFrame is null, not top-level, or its origin is not allowed
  'sender-rejected',
  // main: the arguments do not match the channel's input schema
  'invalid-input',
  // main: the handler threw or its promise rejected
  'handler-failed',
  // main: the handler's result does not match the channel's output schema
  'invalid-output',
  // preload: ipcRenderer.invoke rejected (for example, no handler registered)
  'invoke-failed',
  // preload: main's reply does not match the channel's result schema
  'invalid-response',
]);

export type IpcErrorCode = z.infer<typeof ipcErrorCodeSchema>;

/** `message` is a short fixed text; it never carries a stack trace. */
export const ipcErrorSchema = z.strictObject({
  code: ipcErrorCodeSchema,
  message: z.string(),
});

export type IpcError = z.infer<typeof ipcErrorSchema>;

/** What every invoke resolves to. Handlers' exceptions never reach a renderer. */
export type IpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: IpcError };

export function ipcResultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), data }),
    z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
  ]);
}

export function ipcFailure(code: IpcErrorCode, message: string) {
  return {
    ok: false,
    error: { code, message },
  } as const satisfies IpcResult<never>;
}

/**
 * One invoke channel. `input` validates the whole argument list as a tuple,
 * so extra arguments are rejected too; `output` validates the result data.
 */
export interface IpcContract {
  readonly channel: string;
  readonly input: z.ZodTuple;
  readonly output: z.ZodType;
}

/** Arguments a handler receives after `input` validation. */
export type IpcArgs<C extends IpcContract> =
  z.output<C['input']> extends readonly unknown[] ? z.output<C['input']> : [];

/** Data an invoke resolves with on success. */
export type IpcData<C extends IpcContract> = z.output<C['output']>;

/**
 * One push channel, main to renderer. Main only ever pushes StageView
 * (AD-20), through src/main/ipc/push.ts, which validates `payload` before
 * sending; the preload validates it again on receipt. The channel name
 * follows the same `<domain>:<action>` rule as invoke channels.
 */
export interface IpcPushContract {
  readonly channel: string;
  readonly payload: z.ZodType;
}

/** What a push carries after `payload` validation. */
export type IpcPayload<C extends IpcPushContract> = z.output<C['payload']>;

/** Validates a reply received from main against the channel's contract. */
export function parseIpcResult<C extends IpcContract>(
  contract: C,
  reply: unknown,
): IpcResult<IpcData<C>> {
  const parsed = ipcResultSchema(contract.output).safeParse(reply);
  if (parsed.success) {
    return parsed.data as IpcResult<IpcData<C>>;
  }
  return ipcFailure(
    'invalid-response',
    `reply on ${contract.channel} does not match its schema`,
  );
}

// ---------------------------------------------------------------------------
// Channels. Each contract is defined here once and used by both main
// (registerIpcHandler, pushToRenderer) and the preloads.

/** `app:get-version`: the app's version string; takes no arguments. */
export const appGetVersion = {
  channel: 'app:get-version',
  input: z.tuple([]),
  output: z.string().min(1),
} as const satisfies IpcContract;

/** `settings:get`: the current settings values and their rev. */
export const settingsGet = {
  channel: 'settings:get',
  input: z.tuple([]),
  output: settingsStateSchema,
} as const satisfies IpcContract;

/**
 * `settings:patch`: applies field operations to the current values (AD-23)
 * and answers the new rev and whether the patch was merged.
 */
export const settingsPatch = {
  channel: 'settings:patch',
  input: z.tuple([settingsPatchSchema]),
  output: settingsPatchResultSchema,
} as const satisfies IpcContract;

/**
 * `pool:set-released`: releases the session at a key (true) or shows it
 * again (false) (Story 2.8). main/pool changes nothing when it already is
 * so. Answers null; the change comes back through StageView's `pool`
 * section.
 */
export const poolSetReleased = {
  channel: 'pool:set-released',
  input: poolSetReleasedInputSchema,
  output: z.null(),
} as const satisfies IpcContract;

/**
 * `packs:choose`: main opens a file dialog (only `.awpet` files) on the
 * panel and imports the file picked (Story 3.2). Answers null at once,
 * before the dialog closes; the import goes on in main and comes back
 * through StageView's `packImport` section. Nothing happens while an
 * import is being read or waits for confirmation.
 */
export const packsChoose = {
  channel: 'packs:choose',
  input: z.tuple([]),
  output: z.null(),
} as const satisfies IpcContract;

/**
 * `packs:confirm`: replaces the installed version with the pack waiting
 * for confirmation (true) or leaves it (false). Answers null at once;
 * nothing happens unless a pack waits for confirmation. The outcome comes
 * back through StageView's `packImport` (and `packs`) sections.
 */
export const packsConfirm = {
  channel: 'packs:confirm',
  input: packsConfirmInputSchema,
  output: z.null(),
} as const satisfies IpcContract;

/**
 * `packs:export`: main opens a save dialog (only `.awpet` files, named
 * `<packId>-<version>.awpet` to start with) on the panel and writes the
 * installed pack there (Story 3.3). Answers null at once, before the
 * dialog closes; the export goes on in main and comes back through
 * StageView's `packExport` section. Nothing happens while an export is
 * saving.
 */
export const packsExport = {
  channel: 'packs:export',
  input: packsExportInputSchema,
  output: z.null(),
} as const satisfies IpcContract;

/**
 * `packs:remove`: removes the installed pack (Story 3.3), after the panel
 * has had the user confirm it: first from index.json, then its folder.
 * Answers once done: removed, or the code of why nothing changed. The
 * list comes back through StageView's `packs` section; settings.json
 * keeps the pack's 上場 and 加入池子 values.
 */
export const packsRemove = {
  channel: 'packs:remove',
  input: packsRemoveInputSchema,
  output: packRemoveResultSchema,
} as const satisfies IpcContract;

/**
 * `packs:get-entry` (overlay only, Story 3.5): the entry source of the
 * installed pack, for its sandbox. main checks again that the pack is
 * installed and that its `apiVersion` fits this stage before reading the
 * file; otherwise, or when the file cannot be read, it answers why.
 */
export const packsGetEntry = {
  channel: 'packs:get-entry',
  input: packsGetEntryInputSchema,
  output: packEntryResultSchema,
} as const satisfies IpcContract;

/**
 * `packs:get-manifest` (overlay only, Story 3.6): what the overlay draws an
 * installed pack with, at the version it asks for: the version's own
 * manifest and its spritesheets' JSON, each checked. Its images come from
 * `pack://` itself. main checks again that the pack is installed at that
 * version and fits this stage; otherwise, or when a file cannot be read or
 * does not fit its schema, it answers why.
 */
export const packsGetManifest = {
  channel: 'packs:get-manifest',
  input: packsGetManifestInputSchema,
  output: packManifestResultSchema,
} as const satisfies IpcContract;

/**
 * `packs:log` (overlay only, Story 3.5): one run log line about a pack's
 * sandbox, or one `stage.log` call of the pack (the overlay has already
 * rate-limited and cut it). Answers null.
 */
export const packsLog = {
  channel: 'packs:log',
  input: packsLogInputSchema,
  output: z.null(),
} as const satisfies IpcContract;

/**
 * `packs:runtime-failed` (overlay only, Story 3.9): a pack's sandbox
 * failed (its version, and why). main/packs counts it for that pack at
 * that version and answers whether the overlay builds the pack a new
 * sandbox: yes for the first PACK_RESTART_LIMIT failures of a version
 * installed now, no after that, or for a version not installed (not
 * counted).
 */
export const packsRuntimeFailed = {
  channel: 'packs:runtime-failed',
  input: packsRuntimeFailedInputSchema,
  output: packRuntimeFailedResultSchema,
} as const satisfies IpcContract;

/**
 * `stage-view:subscribe`: registers the calling renderer for
 * `stage-view:delta` pushes (once per webContents) and answers a snapshot.
 */
export const stageViewSubscribe = {
  channel: 'stage-view:subscribe',
  input: z.tuple([]),
  output: stageViewSnapshotSchema,
} as const satisfies IpcContract;

/** Longest failure reason `canvas:ready` carries, in UTF-16 code units. */
export const CANVAS_READY_REASON_MAX_LENGTH = 200;

/** The renderers PixiJS can pick; English codes for the run log. */
export const canvasRendererSchema = z.enum(['webgl', 'webgpu', 'canvas']);

/**
 * What the overlay reports once its canvas has initialised: the renderer it
 * got and the world size it sees (DIP), or a short reason it failed.
 */
export const canvasReadyReportSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    renderer: canvasRendererSchema,
    width: z.int().nonnegative(),
    height: z.int().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.string().min(1).max(CANVAS_READY_REASON_MAX_LENGTH),
  }),
]);

export type CanvasReadyReport = z.infer<typeof canvasReadyReportSchema>;

/**
 * `canvas:ready`: the overlay says once per page load whether its canvas
 * initialised; main writes it to the run log. Answers null.
 */
export const canvasReady = {
  channel: 'canvas:ready',
  input: z.tuple([canvasReadyReportSchema]),
  output: z.null(),
} as const satisfies IpcContract;

/**
 * Whether the cursor is over something on the canvas that takes the mouse
 * (AD-14). The overlay owns this: it sends one only when that changes, each
 * with a `seq` one more than the last it sent from this page load, starting
 * at 1.
 */
export const canvasHoverSchema = z.strictObject({
  seq: z.int().positive(),
  over: z.boolean(),
});

export type CanvasHover = z.infer<typeof canvasHoverSchema>;

/**
 * `canvas:set-hover`: the overlay says the cursor moved onto or off what
 * takes the mouse; main turns click-through off or back on. Main drops a
 * request whose `seq` is not greater than the last one it took from that
 * page. Answers null.
 */
export const canvasSetHover = {
  channel: 'canvas:set-hover',
  input: z.tuple([canvasHoverSchema]),
  output: z.null(),
} as const satisfies IpcContract;

/** What was right-clicked on the canvas: a session's key. */
export const canvasContextMenuRequestSchema = z.strictObject({
  sessionKey: sessionKeySchema,
});

export type CanvasContextMenuRequest = z.infer<
  typeof canvasContextMenuRequestSchema
>;

/**
 * `canvas:context-menu`: the overlay says the session at `sessionKey` was
 * right-clicked; main pops up that session's menu on the canvas window (the
 * menus are defined in main/windows only). Answers null.
 */
export const canvasContextMenu = {
  channel: 'canvas:context-menu',
  input: z.tuple([canvasContextMenuRequestSchema]),
  output: z.null(),
} as const satisfies IpcContract;

/**
 * What became of the canvas's WebGL context (Story 3.6): it was lost, or
 * it is back. The overlay says so only when that changes.
 */
export const canvasGpuStateSchema = z.enum([
  'context-lost',
  'context-restored',
]);

export type CanvasGpuState = z.infer<typeof canvasGpuStateSchema>;

/**
 * `canvas:gpu` (overlay only, Story 3.6): the canvas's WebGL context was
 * lost or is back. main logs it once per change of that page and reloads
 * the page when the context is not back within CANVAS_CONTEXT_RESTORE_MS.
 * Answers null.
 */
export const canvasGpu = {
  channel: 'canvas:gpu',
  input: z.tuple([canvasGpuStateSchema]),
  output: z.null(),
} as const satisfies IpcContract;

// Push channels (main to renderer).

/** `stage-view:delta`: the sections that changed since the previous rev. */
export const stageViewDelta = {
  channel: 'stage-view:delta',
  payload: stageViewDeltaSchema,
} as const satisfies IpcPushContract;
