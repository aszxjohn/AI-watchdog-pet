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
 * - A pack whose `apiVersion` does not fit this stage (installed before
 *   the app changed its API version) says why, in the words an
 *   `api-incompatible` refusal uses (Story 3.5); it is not in the pool
 *   whatever its checkboxes say, and its program never runs.
 * - A pack whose version main marked failed this run (Story 3.9, its
 *   StagePack's `runtimeFailed`: its sandbox failed past
 *   PACK_RESTART_LIMIT restarts) says so and why, the reason code worded
 *   here (RUNTIME_FAILURE_TEXTS), and that importing it again or
 *   restarting the app brings it back. It is out of the pool whatever its
 *   checkboxes say (they stay as they are); demo mode still shows it.
 *
 * Also here: the one op each checkbox sends (an op changes one key only,
 * never a whole setting), when the checkboxes are disabled, and what
 * clicking one does (createPackListActions). A checkbox changes only once
 * StageView brings the new value back.
 *
 * Each pack also has 匯出… and 移除… (Story 3.3's second half):
 * - 匯出… asks main to open the save dialog (`packs:export`, answered at
 *   once); how it goes is StageView's `packExport` section, shown in one
 *   status line under the list. Every 匯出… is disabled while an export is
 *   saving.
 * - 移除… asks first, on the pack's own row (its name, version, 移除 and
 *   取消); nothing is sent until 移除. Which row asks is the page's own
 *   state, not data. 移除 sends `packs:remove`, whose answer says whether it
 *   went; the row goes once StageView's `packs` section drops it.
 * - Every English code main answers (an export's, a removal's) is worded
 *   here; what each button shows, when it is disabled and what pressing it
 *   does are packRowControls and createPackRowActions.
 */
import { DRAW_TIMEOUT_MS, SANDBOX_BOOT_TIMEOUT_MS } from '../shared/constants';
import type { IpcError, IpcResult } from '../shared/ipc';
import {
  CHARACTER_HEIGHT_HINT_TOLERANCE,
  RECOMMENDED_CHARACTER_HEIGHT,
} from '../shared/pack-api';
import {
  characterKey,
  type CharacterKey,
  type PackExportFailureCode,
  type PackRemoveFailureCode,
  type PackRemoveResult,
  type StagePack,
  type StagePackExport,
  type StagePacks,
} from '../shared/packs';
import type { SandboxFailureReason } from '../shared/sandbox';
import {
  isInPool,
  isPackEnabled,
  type SettingsOp,
  type SettingsPatch,
  type SettingsPatchResult,
  type SettingsValues,
} from '../shared/settings';
import { NOT_SAVED_TEXT, patchErrorText } from './display-options';
import { apiIncompatibleText, isolatedName } from './pack-import';

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

/**
 * What the list says of a pack that does not fit this stage's API: why
 * (apiIncompatibleText), and that it stays off stage. Null for a pack
 * that fits.
 */
export function incompatibleText(
  compatibility: StagePack['compatibility'],
): string | null {
  return compatibility.compatible
    ? null
    : `無法上場：${apiIncompatibleText(compatibility.reason, compatibility.required)}`;
}

/**
 * Why a pack's sandbox failed, as the list words each reason code main
 * marks a pack with (Story 3.9).
 */
export const RUNTIME_FAILURE_TEXTS: Readonly<
  Record<SandboxFailureReason, string>
> = Object.freeze({
  'api-removal-failed': '沙盒無法移除不允許使用的瀏覽器 API',
  'intrinsic-removal-failed': '沙盒無法移除不允許使用的內建物件',
  'ses-missing': '沙盒的安全環境（SES）沒有載入',
  'lockdown-threw': '沙盒鎖定安全環境（SES lockdown）時出錯',
  'lockdown-output': '沙盒鎖定安全環境（SES lockdown）時有非預期的主控台輸出',
  'entry-threw': '入口程式求值時丟錯（包括語法錯誤）',
  'entry-not-factory': '入口程式的值不是工廠函式',
  'factory-threw': '工廠函式丟錯',
  'handlers-not-object': '工廠沒有回傳 handlers 物件',
  'worker-error': '包的 Worker 發生未捕捉的錯誤，或無法建立',
  'unhandled-rejection': '包有沒處理的 Promise rejection',
  'bad-report': '沙盒送來不符合規格的訊息',
  'boot-timeout': `沙盒 ${SANDBOX_BOOT_TIMEOUT_MS / 1000} 秒內沒有開機完成`,
  'heartbeat-timeout': '沙盒太久沒有回應心跳（包的程式可能卡住，例如無窮迴圈）',
  'draw-timeout': `連續 ${DRAW_TIMEOUT_MS / 1000} 秒沒有有效的 draw`,
});

/**
 * What the list says of a pack whose version main marked failed this run
 * (Story 3.9): why (RUNTIME_FAILURE_TEXTS), and what brings it back. Null
 * for a pack not marked.
 */
export function runtimeFailedText(
  runtimeFailed: StagePack['runtimeFailed'],
): string | null {
  return runtimeFailed === undefined
    ? null
    : `執行失敗，這次執行已停用：${RUNTIME_FAILURE_TEXTS[runtimeFailed]}。重新匯入或重新啟動 app 後恢復。`;
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
  /** incompatibleText: why it cannot go on stage, or null. */
  readonly incompatible: string | null;
  /** runtimeFailedText: why it is off stage this run (Story 3.9), or null. */
  readonly runtimeFailed: string | null;
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
        incompatible: incompatibleText(pack.compatibility),
        runtimeFailed: runtimeFailedText(pack.runtimeFailed),
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

// ---------------------------------------------------------------------------
// 匯出… and 移除… (Story 3.3's second half).

export const EXPORT_BUTTON_LABEL = '匯出…';
export const REMOVE_BUTTON_LABEL = '移除…';
export const REMOVE_CONFIRM_LABEL = '移除';
export const REMOVE_CANCEL_LABEL = '取消';
export const EXPORTING_TEXT = '匯出中…';

/** What the page says for each export failure code. */
export const EXPORT_FAILURE_TEXTS: Readonly<
  Record<PackExportFailureCode, string>
> = Object.freeze({
  'not-installed': '這個角色包已不在（可能剛被移除）',
  'read-failed':
    '讀不到已安裝的檔案（安裝資料夾可能不見了、被改動過，或沒有讀取權限）',
  'write-failed':
    '無法寫入選擇的位置（可能沒有寫入權限、磁碟空間不足，或位置已不存在）',
});

/** What the page says for each removal failure code. */
export const REMOVE_FAILURE_TEXTS: Readonly<
  Record<PackRemoveFailureCode, string>
> = Object.freeze({
  'not-installed': '這個角色包已不在（可能已經移除了）',
  'index-unwritable':
    '這次啟動時讀不到角色包清單（index.json），所以不能移除；請查看 run log 後重新啟動 app',
  'index-write-failed': '無法寫入角色包清單（index.json），角色包沒有移除',
});

/**
 * The question on a row whose removal is being confirmed: the pack's name
 * and version (versionText), and what happens to its files and settings.
 */
export function removeConfirmText(name: string, version: string): string {
  return `要移除「${isolatedName(name)}」${version} 嗎？它的檔案會刪除；上場與加入池子的選擇會保留，之後重新匯入同一包時會回來。`;
}

/** The export status line's look. */
export type PackExportTone = 'progress' | 'success' | 'error';

export interface PackExportStatus {
  readonly tone: PackExportTone;
  readonly text: string;
}

/** The status line for StageView's `packExport` section; null before any export. */
export function packExportStatus(
  state: StagePackExport,
): PackExportStatus | null {
  switch (state.phase) {
    case 'idle':
      return null;
    case 'saving':
      return { tone: 'progress', text: EXPORTING_TEXT };
    case 'result':
      break;
  }
  switch (state.outcome) {
    case 'exported':
      return {
        tone: 'success',
        text: `已匯出：${isolatedName(state.name)} ${state.version}`,
      };
    case 'failed':
      return {
        tone: 'error',
        text: `無法匯出：${EXPORT_FAILURE_TEXTS[state.code]}。沒有寫出任何檔案。`,
      };
  }
}

/** What pressing one of a row's buttons does. */
export type PackRowPress =
  /** 匯出…: asks main to export the pack. */
  | { readonly kind: 'export'; readonly packId: string; readonly name: string }
  /** 移除…: asks on this row; sends nothing. */
  | { readonly kind: 'ask-remove'; readonly packId: string }
  /** 移除 (on the question): sends the removal. */
  | { readonly kind: 'remove'; readonly packId: string; readonly name: string }
  /** 取消 (on the question): stops asking; sends nothing. */
  | { readonly kind: 'keep' };

/** One button of a row, and what pressing it does. */
export interface PackRowButton {
  readonly key: PackRowPress['kind'];
  readonly label: string;
  /** What a screen reader names it by, the pack included. */
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly press: PackRowPress;
}

/** The removal question on a row. */
export interface PackRowConfirm {
  /** Unique on the page: the question's id (the group is labelled by it). */
  readonly id: string;
  readonly text: string;
  /** 移除, then 取消. */
  readonly buttons: readonly PackRowButton[];
}

/** A row's 匯出… and 移除…, and its removal question while it asks. */
export interface PackRowControls {
  /** 匯出…, then 移除…. */
  readonly buttons: readonly PackRowButton[];
  /** The question, or null when this row is not asking. */
  readonly confirm: PackRowConfirm | null;
}

/** What the page keeps around the rows' buttons. */
export interface PackRowActionState {
  /** The id of the pack whose row asks to confirm its removal, or null. */
  readonly confirming: string | null;
  /** A request is on its way: every row button is disabled. */
  readonly sending: boolean;
  /** Why the last request failed, or null. */
  readonly error: string | null;
}

export const IDLE_PACK_ROW_ACTIONS: PackRowActionState = Object.freeze({
  confirming: null,
  sending: false,
  error: null,
});

/**
 * The buttons of the row of `pack` (as packListView lists it), given
 * StageView's `packExport` section, the page's own state and whether the
 * preload API is there. Each is disabled while a request is on its way and
 * with no preload API; besides, 匯出… while any export is saving, and
 * 移除… while its row already asks. Removing is never held up by an export.
 */
export function packRowControls(
  pack: Pick<PackListPack, 'id' | 'name' | 'version'>,
  packExport: StagePackExport,
  actions: PackRowActionState,
  hasApi: boolean,
): PackRowControls {
  const blocked = actions.sending || !hasApi;
  const asking = actions.confirming === pack.id;
  return {
    buttons: [
      {
        key: 'export',
        label: EXPORT_BUTTON_LABEL,
        ariaLabel: `匯出：${pack.name}`,
        disabled: blocked || packExport.phase === 'saving',
        press: { kind: 'export', packId: pack.id, name: pack.name },
      },
      {
        key: 'ask-remove',
        label: REMOVE_BUTTON_LABEL,
        ariaLabel: `移除：${pack.name}`,
        disabled: blocked || asking,
        press: { kind: 'ask-remove', packId: pack.id },
      },
    ],
    confirm: asking
      ? {
          id: `remove-confirm:${pack.id}`,
          text: removeConfirmText(pack.name, pack.version),
          buttons: [
            {
              key: 'remove',
              label: REMOVE_CONFIRM_LABEL,
              ariaLabel: `確定移除：${pack.name}`,
              disabled: blocked,
              press: { kind: 'remove', packId: pack.id, name: pack.name },
            },
            {
              key: 'keep',
              label: REMOVE_CANCEL_LABEL,
              ariaLabel: `取消移除：${pack.name}`,
              disabled: blocked,
              press: { kind: 'keep' },
            },
          ],
        }
      : null,
  };
}

/** What the page shows when an export request fails; StageView is left as it is. */
export function exportRequestErrorText(
  name: string,
  error: IpcError | undefined,
): string {
  const what = `無法開始匯出「${isolatedName(name)}」`;
  return error === undefined
    ? what
    : `${what}（${error.code}：${error.message}）`;
}

/**
 * What the page shows when a removal did not go: the request failed
 * (`error`, or undefined when the call itself threw), or main answered a
 * failure code.
 */
export function removeFailedText(
  name: string,
  failure:
    | { readonly code: PackRemoveFailureCode }
    | { readonly error: IpcError | undefined },
): string {
  const what = `無法移除「${isolatedName(name)}」`;
  if ('code' in failure) {
    return `${what}：${REMOVE_FAILURE_TEXTS[failure.code]}`;
  }
  return failure.error === undefined
    ? what
    : `${what}（${failure.error.code}：${failure.error.message}）`;
}

/** `window.awp.packs`, as far as the rows need it. */
export interface PackRowApi {
  export(packId: string): Promise<IpcResult<null>>;
  remove(packId: string): Promise<IpcResult<PackRemoveResult>>;
}

export interface PackRowActions {
  /**
   * Presses one of a row's buttons (PackRowButton.press). 移除… and 取消
   * only change which row asks, and send nothing; 匯出… and 移除 send their
   * request unless one is still on its way, report `sending`, then the
   * outcome (移除 also stops asking, whatever came back). Nothing of
   * StageView is changed here; the list and the export status come back
   * through it (AD-20). Never rejects.
   */
  press(press: PackRowPress): Promise<void>;
}

/**
 * The rows' button logic. `api` is `window.awp.packs`; `onState` hears
 * every change of which row asks, `sending` and the error.
 */
export function createPackRowActions(
  api: PackRowApi,
  onState: (state: PackRowActionState) => void,
  logError: (message: string, ...details: unknown[]) => void = console.error,
): PackRowActions {
  let state = IDLE_PACK_ROW_ACTIONS;

  /** Takes `next` and tells the page; the page failing changes nothing here. */
  function report(next: PackRowActionState): void {
    state = next;
    try {
      onState(next);
    } catch {
      // The page could not take it; the press still resolves.
    }
  }

  async function send(
    channel: string,
    call: () => Promise<string | null>,
    failedText: () => string,
    stopAsking: boolean,
  ): Promise<void> {
    if (state.sending) {
      return;
    }
    let error: string | null = null;
    state = { ...state, sending: true, error: null };
    try {
      onState(state);
      error = await call();
    } catch (thrown) {
      // The call rejected, or onState or logError threw.
      error ??= failedText();
      try {
        logError(`[panels] ${channel} failed`, thrown);
      } catch {
        // Nowhere left to report it; the outcome still goes to onState.
      }
    } finally {
      // Whatever threw above, the next press must not be ignored.
      report({
        confirming: stopAsking ? null : state.confirming,
        sending: false,
        error,
      });
    }
  }

  return {
    async press(press) {
      switch (press.kind) {
        case 'ask-remove':
          if (!state.sending) {
            report({ ...state, confirming: press.packId, error: null });
          }
          return;
        case 'keep':
          if (!state.sending) {
            report({ ...state, confirming: null });
          }
          return;
        case 'export':
          return send(
            'packs:export',
            async () => {
              const result = await api.export(press.packId);
              if (result.ok) {
                return null;
              }
              logError(
                `[panels] packs:export: ${result.error.code}: ${result.error.message}`,
              );
              return exportRequestErrorText(press.name, result.error);
            },
            () => exportRequestErrorText(press.name, undefined),
            false,
          );
        case 'remove':
          return send(
            'packs:remove',
            async () => {
              const result = await api.remove(press.packId);
              if (!result.ok) {
                logError(
                  `[panels] packs:remove: ${result.error.code}: ${result.error.message}`,
                );
                return removeFailedText(press.name, { error: result.error });
              }
              return result.data.ok
                ? null
                : removeFailedText(press.name, { code: result.data.code });
            },
            () => removeFailedText(press.name, { error: undefined }),
            true,
          );
      }
    },
  };
}
