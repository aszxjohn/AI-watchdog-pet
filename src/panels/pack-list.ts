/**
 * The 角色包 page's installed list (Story 3.3), built from StageView alone
 * (AD-20): the `packs` section (what is installed) and the `settings`
 * section (上場 and 加入池子). No React and no DOM types, so it is
 * unit-tested under Node.
 *
 * - Each installed pack, by id: its name, version and a 上場 checkbox;
 *   under it each of its characters, in the manifest's order, with a
 *   加入池子 checkbox and, when its declared height is off the
 *   recommended one by more than CHARACTER_HEIGHT_HINT_TOLERANCE, a hint
 *   beside it (a hint only: nothing is blocked or rescaled).
 * - Both values are isPackEnabled / isInPool (src/shared/settings), the
 *   one place they are worked out. Settings of packs or characters that
 *   are not installed stay in settings.json and are not listed.
 * - 加入池子 can be changed whether or not the pack is 上場.
 *
 * Also here: the one op each checkbox sends (an op changes one key only,
 * never a whole setting), when the checkboxes are disabled, and what
 * clicking one does (createPackListActions). A checkbox changes only once
 * StageView brings the new value back.
 */
import type { IpcError, IpcResult } from '../shared/ipc';
import {
  CHARACTER_HEIGHT_HINT_TOLERANCE,
  RECOMMENDED_CHARACTER_HEIGHT,
} from '../shared/pack-api';
import {
  characterKey,
  type CharacterKey,
  type StagePacks,
} from '../shared/packs';
import {
  isInPool,
  isPackEnabled,
  type SettingsOp,
  type SettingsPatch,
  type SettingsPatchResult,
  type SettingsValues,
} from '../shared/settings';
import { NOT_SAVED_TEXT, patchErrorText } from './display-options';

export const PACK_LIST_HEADING = '已安裝';
export const NO_PACKS_TEXT = '還沒有安裝角色包';
export const ENABLED_LABEL = '上場';
export const IN_POOL_LABEL = '加入池子';

/** What a failed change says before its code and message. */
export const PACK_LIST_PATCH_FAILED = '無法變更角色包設定';

/**
 * The heights that get no hint, both ends included: the recommended height
 * ± CHARACTER_HEIGHT_HINT_TOLERANCE (82.5 to 137.5).
 */
export const RECOMMENDED_HEIGHT_RANGE = Object.freeze({
  min: RECOMMENDED_CHARACTER_HEIGHT * (1 - CHARACTER_HEIGHT_HINT_TOLERANCE),
  max: RECOMMENDED_CHARACTER_HEIGHT * (1 + CHARACTER_HEIGHT_HINT_TOLERANCE),
});

/**
 * The hint beside a character whose declared `height` is outside
 * RECOMMENDED_HEIGHT_RANGE, with that height and the range; null inside it.
 */
export function heightHintText(height: number): string | null {
  const { min, max } = RECOMMENDED_HEIGHT_RANGE;
  if (height >= min && height <= max) {
    return null;
  }
  const look = height < min ? '偏小' : '偏大';
  return `身高 ${height}，建議 ${min}～${max}，和其他角色放在一起可能${look}`;
}

/** The version as the list shows it. */
export function versionText(version: string): string {
  return `版本 ${version}`;
}

/** An op one of the list's checkboxes sends: one key of one keyed setting. */
export type PackListOp = Extract<
  SettingsOp,
  { op: 'setPackEnabled' } | { op: 'setFixed' }
>;

/** 上場 of pack `packId` set to `enabled`. */
export function packEnabledOp(packId: string, enabled: boolean): PackListOp {
  return { op: 'setPackEnabled', packId, value: enabled };
}

/** 加入池子 of that one character set to `inPool`. */
export function inPoolOp(
  packId: string,
  characterId: string,
  inPool: boolean,
): PackListOp {
  return {
    op: 'setFixed',
    characterKey: characterKey(packId, characterId),
    param: 'inPool',
    value: inPool,
  };
}

/**
 * The `settings:patch` that sends `op`, alone, at `settingsRev` (the
 * settings rev in StageView, the rev the page last saw). An older rev is
 * merged key by key in main, so it never undoes another key.
 */
export function packListPatch(
  settingsRev: number,
  op: PackListOp,
): SettingsPatch {
  return { baseRev: settingsRev, ops: [op] };
}

/** One checkbox: what it shows and what clicking it sends. */
export interface PackListCheckbox {
  /** Unique on the page: the checkbox input's id (a hint's id builds on it). */
  readonly id: string;
  /** The value StageView has. */
  readonly checked: boolean;
  /** What a screen reader names it by, the pack or character included. */
  readonly ariaLabel: string;
  /** The op clicking it sends: the value it does not have now. */
  readonly toggle: PackListOp;
}

export interface PackListCharacter {
  readonly key: CharacterKey;
  /** The name the pack gives it. */
  readonly name: string;
  readonly inPool: PackListCheckbox;
  /** heightHintText of its declared height, or null. */
  readonly heightHint: string | null;
  /**
   * The hint element's id, `<inPool.id>:hint`, which the 加入池子 checkbox
   * names in `aria-describedby`; null when there is no hint.
   */
  readonly heightHintId: string | null;
}

export interface PackListPack {
  readonly id: string;
  readonly name: string;
  /** versionText. */
  readonly version: string;
  readonly enabled: PackListCheckbox;
  /** In the manifest's order. */
  readonly characters: readonly PackListCharacter[];
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The list for StageView's `packs` and settings values, packs by id. */
export function packListView(
  packs: StagePacks,
  settings: Pick<SettingsValues, 'packEnabled' | 'fixedOverrides'>,
): readonly PackListPack[] {
  return [...packs.installed]
    .sort((a, b) => compareIds(a.id, b.id))
    .map((pack) => {
      const enabled = isPackEnabled(settings, pack.id);
      return {
        id: pack.id,
        name: pack.name,
        version: versionText(pack.version),
        enabled: {
          id: `enabled:${pack.id}`,
          checked: enabled,
          ariaLabel: `${ENABLED_LABEL}：${pack.name}`,
          toggle: packEnabledOp(pack.id, !enabled),
        },
        characters: pack.characters.map((character) => {
          const key = characterKey(pack.id, character.id);
          const inPool = isInPool(settings, pack.id, character.id);
          const id = `in-pool:${key}`;
          const heightHint = heightHintText(character.height);
          return {
            key,
            name: character.name,
            inPool: {
              id,
              checked: inPool,
              ariaLabel: `${IN_POOL_LABEL}：${pack.name}／${character.name}`,
              toggle: inPoolOp(pack.id, character.id, !inPool),
            },
            heightHint,
            heightHintId: heightHint === null ? null : `${id}:hint`,
          };
        }),
      };
    });
}

/**
 * Whether every checkbox of the list is disabled: while a change is on its
 * way, and when the preload API is missing.
 */
export function packListDisabled(saving: boolean, hasApi: boolean): boolean {
  return saving || !hasApi;
}

/** What the page shows around the list while a change is sent. */
export interface PackListActionState {
  /** A patch is on its way: every checkbox is disabled. */
  readonly saving: boolean;
  /** Why the last change failed, or null. */
  readonly error: string | null;
  /**
   * NOT_SAVED_TEXT when the last change applied but settings.json is not
   * kept, or null.
   */
  readonly notice: string | null;
}

export const IDLE_PACK_LIST_ACTIONS: PackListActionState = Object.freeze({
  saving: false,
  error: null,
  notice: null,
});

/** `window.awp.settings`, as far as the list needs it. */
export interface PackListApi {
  patch(patch: SettingsPatch): Promise<IpcResult<SettingsPatchResult>>;
}

export interface PackListActions {
  /**
   * Sends `op` at `settingsRev`, unless a change is still on its way:
   * reports `saving`, sends the patch, then reports the outcome (an
   * error, or NOT_SAVED_TEXT when main applied it without keeping
   * settings.json). The checkbox itself is never changed here; it comes
   * back through StageView (AD-20). Never rejects.
   */
  toggle(op: PackListOp, settingsRev: number): Promise<void>;
}

/** The failure text for a change of the list. */
function failedText(error: IpcError | undefined): string {
  return patchErrorText(error, PACK_LIST_PATCH_FAILED);
}

/**
 * The list's click logic. `api` is `window.awp.settings`; `onState` hears
 * every saving / error / notice change.
 */
export function createPackListActions(
  api: PackListApi,
  onState: (state: PackListActionState) => void,
  logError: (message: string, ...details: unknown[]) => void = console.error,
): PackListActions {
  let saving = false;
  return {
    async toggle(op, settingsRev) {
      if (saving) {
        return;
      }
      saving = true;
      let error: string | null = null;
      let notice: string | null = null;
      try {
        onState({ saving: true, error: null, notice: null });
        const result = await api.patch(packListPatch(settingsRev, op));
        if (!result.ok) {
          error = failedText(result.error);
          logError(
            `[panels] settings:patch: ${result.error.code}: ${result.error.message}`,
          );
        } else if (!result.data.saved) {
          notice = NOT_SAVED_TEXT;
        }
      } catch (thrown) {
        // patch rejected, or onState or logError threw.
        error ??= failedText(undefined);
        try {
          logError('[panels] settings:patch failed', thrown);
        } catch {
          // Nowhere left to report it; the outcome still goes to onState.
        }
      } finally {
        // Whatever threw above, the next click must not be ignored.
        saving = false;
        try {
          onState({ saving: false, error, notice });
        } catch {
          // The page could not take the outcome; toggle still resolves.
        }
      }
    },
  };
}
