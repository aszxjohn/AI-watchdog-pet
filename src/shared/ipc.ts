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
 * `stage-view:subscribe`: registers the calling renderer for
 * `stage-view:delta` pushes (once per webContents) and answers a snapshot.
 */
export const stageViewSubscribe = {
  channel: 'stage-view:subscribe',
  input: z.tuple([]),
  output: stageViewSnapshotSchema,
} as const satisfies IpcContract;

// Push channels (main to renderer).

/** `stage-view:delta`: the sections that changed since the previous rev. */
export const stageViewDelta = {
  channel: 'stage-view:delta',
  payload: stageViewDeltaSchema,
} as const satisfies IpcPushContract;
