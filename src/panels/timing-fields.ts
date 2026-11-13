/**
 * The 舞台設定 page's 計時 section (Story 2.9), built from StageView alone
 * (AD-20): three detection timings, each typed as a whole number of seconds
 * or minutes. No React and no DOM types, so it is unit-tested under Node.
 *
 * - 做完了過場 (`doneMs`) in 秒, 無動靜轉休息中 (`idleMs`) in 分鐘,
 *   推測要你批准 (`approvalInferMs`) in 秒. A field's range is its settings
 *   schema's minValue / maxValue (src/shared/settings, the schema main
 *   checks the patch with), in the field's unit; no number is kept here.
 * - A field shows StageView's value in its unit, as it is: a value that is
 *   not a whole number of units (`doneMs: 1500`, written by hand) shows as
 *   1.5.
 * - What the user types is a draft the page keeps until it is saved, or
 *   until the page goes away: nothing holds the panel open (Epic 2), so an
 *   unsaved draft is simply dropped. A draft that is the shown text, or the
 *   same value, is no change and is never sent. Only a whole number within
 *   the range is accepted; any other draft shows the range below its field,
 *   and nothing is sent until it is fixed. Full-width digits, as a Chinese
 *   input method types them (８, ０５), count as the ASCII ones
 *   (normalizeDraft).
 * - 儲存 sends every changed field as an op of one `settings:patch` at the
 *   StageView settings rev (timingForm). What pressing it does is
 *   createTimingSaver; the fields show the new values once StageView brings
 *   them back.
 */
import type { IpcError, IpcResult } from '../shared/ipc';
import {
  settingsFieldSchemas,
  type SettingsField,
  type SettingsOp,
  type SettingsPatch,
  type SettingsPatchResult,
  type SettingsState,
} from '../shared/settings';
import { STATE_DISPLAY_NAMES } from '../shared/states';
import { NOT_SAVED_TEXT } from './display-options';

/** The settings the 計時 section shows. */
export type TimingField = Extract<
  SettingsField,
  'doneMs' | 'idleMs' | 'approvalInferMs'
>;

export interface TimingFieldDef {
  readonly field: TimingField;
  /** What the page calls it. */
  readonly label: string;
  /** The unit the user types in. */
  readonly unit: string;
  /** Milliseconds in one unit. */
  readonly unitMs: number;
}

/** Heading of the section. */
export const TIMING_HEADING = '計時';

/** The 儲存 button. */
export const SAVE_LABEL = '儲存';

/** What the page shows once main has applied and kept a change. */
export const SAVED_TEXT = '已儲存';

/** The section's fields, in page order. */
export const TIMING_FIELDS: readonly TimingFieldDef[] = Object.freeze(
  (
    [
      {
        field: 'doneMs',
        label: `${STATE_DISPLAY_NAMES.done}過場`,
        unit: '秒',
        unitMs: 1000,
      },
      {
        field: 'idleMs',
        label: `無動靜轉${STATE_DISPLAY_NAMES.idle}`,
        unit: '分鐘',
        unitMs: 60_000,
      },
      {
        field: 'approvalInferMs',
        label: `推測${STATE_DISPLAY_NAMES.approval}`,
        unit: '秒',
        unitMs: 1000,
      },
    ] satisfies TimingFieldDef[]
  ).map((def) => Object.freeze(def)),
);

/** The whole units a field accepts, both ends included. */
export interface TimingRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The field's range in its unit, from its settings schema: the whole units
 * between the schema's minValue and maxValue.
 */
export function timingRange(def: TimingFieldDef): TimingRange {
  const { minValue, maxValue } = settingsFieldSchemas[def.field];
  return {
    min: Math.ceil((minValue ?? 0) / def.unitMs),
    max: Math.floor((maxValue ?? Number.MAX_SAFE_INTEGER) / def.unitMs),
  };
}

/** The range beside a field: `範圍 1～60`. */
export function timingRangeText(def: TimingFieldDef): string {
  const { min, max } = timingRange(def);
  return `範圍 ${min}～${max}`;
}

/** What a field shows below it when its draft cannot be saved. */
export function timingErrorText(def: TimingFieldDef): string {
  const { min, max } = timingRange(def);
  return `請輸入 ${min}～${max} 的整數`;
}

/** A value in the field's unit, as it is: 1500 ms is `1.5` 秒. */
export function timingText(def: TimingFieldDef, valueMs: number): string {
  return String(valueMs / def.unitMs);
}

export type TimingParse =
  | { readonly ok: true; readonly valueMs: number }
  | { readonly ok: false; readonly error: string };

const WHOLE_NUMBER = /^[0-9]+$/;

/**
 * A draft as it is compared and parsed: NFKC, so full-width digits are the
 * ASCII ones, with spaces around it removed.
 */
function normalizeDraft(text: string): string {
  return text.normalize('NFKC').trim();
}

/**
 * What the user typed, in milliseconds: a whole number of units (full-width
 * digits and spaces around it allowed, normalizeDraft) within the field's
 * range, which its settings schema then accepts. Anything else is
 * timingErrorText.
 */
export function parseTiming(def: TimingFieldDef, text: string): TimingParse {
  const invalid = { ok: false, error: timingErrorText(def) } as const;
  const trimmed = normalizeDraft(text);
  if (!WHOLE_NUMBER.test(trimmed)) {
    return invalid;
  }
  const amount = Number(trimmed);
  const { min, max } = timingRange(def);
  if (!Number.isSafeInteger(amount) || amount < min || amount > max) {
    return invalid;
  }
  const valueMs = amount * def.unitMs;
  if (!settingsFieldSchemas[def.field].safeParse(valueMs).success) {
    return invalid;
  }
  return { ok: true, valueMs };
}

/** What the user typed in each field; a field not typed in has none. */
export type TimingDrafts = Readonly<Partial<Record<TimingField, string>>>;

/** One field as the page shows it. */
export interface TimingFieldView extends TimingFieldDef {
  /** timingRangeText. */
  readonly range: string;
  /** What the input shows: the draft, or StageView's value. */
  readonly text: string;
  /** Why the draft cannot be saved, or null. */
  readonly error: string | null;
}

export interface TimingForm {
  readonly fields: readonly TimingFieldView[];
  /**
   * The patch 儲存 sends: one op per changed field, at the StageView
   * settings rev. Null when nothing changed or a draft is invalid, and
   * then 儲存 is disabled.
   */
  readonly patch: SettingsPatch | null;
}

/** The section as StageView's settings and the drafts make it. */
export function timingForm(
  settings: SettingsState,
  drafts: TimingDrafts,
): TimingForm {
  const ops: SettingsOp[] = [];
  let invalid = false;
  const fields = TIMING_FIELDS.map((def): TimingFieldView => {
    const current = settings.values[def.field];
    const shown = timingText(def, current);
    const draft = drafts[def.field];
    const view = { ...def, range: timingRangeText(def) };
    if (draft === undefined || normalizeDraft(draft) === shown) {
      return { ...view, text: draft ?? shown, error: null };
    }
    const parsed = parseTiming(def, draft);
    if (!parsed.ok) {
      invalid = true;
      return { ...view, text: draft, error: parsed.error };
    }
    if (parsed.valueMs !== current) {
      ops.push({ op: 'set', field: def.field, value: parsed.valueMs });
    }
    return { ...view, text: draft, error: null };
  });
  return {
    fields,
    patch: invalid || ops.length === 0 ? null : { baseRev: settings.rev, ops },
  };
}

/** What the page shows when saving fails; the drafts stay for another try. */
export function saveErrorText(error: IpcError | undefined): string {
  return error === undefined
    ? '無法儲存計時設定'
    : `無法儲存計時設定（${error.code}：${error.message}）`;
}

/**
 * How the last save ended: `saved` (SAVED_TEXT), `not-saved` (applied, but
 * settings.json is not kept: NOT_SAVED_TEXT) or `error` (nothing applied).
 */
export interface TimingOutcome {
  readonly kind: 'saved' | 'not-saved' | 'error';
  readonly text: string;
}

/** What the page shows around the fields while a save is sent. */
export interface TimingSaveState {
  /** A patch is on its way: the fields and 儲存 are disabled. */
  readonly saving: boolean;
  /** How the last save ended, or null. */
  readonly outcome: TimingOutcome | null;
}

export const IDLE_TIMING_SAVE: TimingSaveState = Object.freeze({
  saving: false,
  outcome: null,
});

export interface TimingSaver {
  /**
   * Saves the drafts, unless a save is still on its way or timingForm has
   * no patch for them (nothing changed, or a draft is invalid): reports
   * `saving`, sends the patch, then reports the outcome. Resolves true when
   * main applied it, so the page drops its drafts and the fields show
   * StageView's values again; false otherwise, the drafts kept. The values
   * shown are never changed here; they come back through StageView
   * (AD-20). Never rejects.
   */
  save(settings: SettingsState, drafts: TimingDrafts): Promise<boolean>;
}

/**
 * The 計時 section's 儲存 logic. `patch` is `window.awp.settings.patch`;
 * `onState` hears every saving / outcome change.
 */
export function createTimingSaver(
  patch: (patch: SettingsPatch) => Promise<IpcResult<SettingsPatchResult>>,
  onState: (state: TimingSaveState) => void,
  logError: (message: string, ...details: unknown[]) => void = console.error,
): TimingSaver {
  let saving = false;
  return {
    async save(settings, drafts) {
      if (saving) {
        return false;
      }
      const next = timingForm(settings, drafts).patch;
      if (next === null) {
        return false;
      }
      saving = true;
      let applied = false;
      let outcome: TimingOutcome = {
        kind: 'error',
        text: saveErrorText(undefined),
      };
      try {
        onState({ saving: true, outcome: null });
        const result = await patch(next);
        if (result.ok) {
          applied = true;
          outcome = result.data.saved
            ? { kind: 'saved', text: SAVED_TEXT }
            : { kind: 'not-saved', text: NOT_SAVED_TEXT };
        } else {
          outcome = { kind: 'error', text: saveErrorText(result.error) };
          logError(
            `[panels] settings:patch: ${result.error.code}: ${result.error.message}`,
          );
        }
      } catch (thrown) {
        // patch rejected, or onState or logError threw.
        try {
          logError('[panels] settings:patch failed', thrown);
        } catch {
          // Nowhere left to report it; the outcome still goes to onState.
        }
      } finally {
        // Whatever threw above, the next save must not be ignored.
        saving = false;
        try {
          onState({ saving: false, outcome });
        } catch {
          // The page could not take the outcome; save still resolves.
        }
      }
      return applied;
    },
  };
}
