/**
 * The 角色包 page's import area (Story 3.2), built from StageView's
 * `packImport` section alone (AD-20): the 匯入角色包… button, one status
 * line (with the manifest problems under it), and the replace
 * confirmation. No React and no DOM types, so it is unit-tested under Node.
 *
 * main publishes English codes only; every Chinese word of a refusal or a
 * failed install is here: one text per rejection code (with what it
 * carries: the version needed, the file named, the limit), per install
 * failure code, per PACK_API_ISSUE_RULES rule, and per zod issue code for
 * the manifest problems no rule names.
 *
 * Also here: what pressing 匯入角色包… / 取代 / 取消 does
 * (createPackImportActions). Nothing changes on the page from a reply;
 * the outcome comes back through StageView.
 */
import {
  PACK_IMPORT_MAX_ENTRIES,
  PACK_IMPORT_MAX_FILES,
  PACK_IMPORT_MAX_IMAGE_SIDE,
  PACK_IMPORT_MAX_TOTAL_BYTES,
  PACK_IMPORT_MAX_TOTAL_PIXELS,
} from '../shared/constants';
import type { IpcError, IpcResult } from '../shared/ipc';
import {
  formatApiVersion,
  PACK_API_VERSION,
  type PackApiIssueRule,
  SCALE_GRID,
} from '../shared/pack-api';
import type {
  PackEntryProblem,
  PackImageLimit,
  PackInstallFailureCode,
  PackManifestIssue,
  PackRejection,
  PackSizeLimit,
  StagePackImport,
} from '../shared/packs';

export const PACK_IMPORT_HEADING = '匯入';
export const IMPORT_BUTTON_LABEL = '匯入角色包…';
export const REPLACE_LABEL = '取代';
export const CANCEL_LABEL = '取消';
export const READING_TEXT = '讀取中…';

/** What the page says for each PACK_API_ISSUE_RULES rule. */
export const ISSUE_RULE_TEXTS: Readonly<Record<PackApiIssueRule, string>> =
  Object.freeze({
    'blank-label': '名稱不能只有空白',
    'reserved-key': '不能用「__proto__」當鍵名',
    'pack-id-all-digits': '包的 id 不能全是數字',
    'pack-id-hex-prefix': '包的 id 不能以「0x」開頭',
    'pack-id-device-name':
      '包的 id 不能是 Windows 保留的裝置名（例如 con、nul、com1）',
    'invalid-pack-path':
      '不是包裡的有效路徑（每一段只能用英數字與「.」「_」「-」，不能是空的、「.」或「..」，也不能以「.」結尾）',
    'pack-path-device-name':
      '路徑裡有 Windows 保留的裝置名（例如 con、nul、com1）',
    'pack-path-case-conflict': '和另一個路徑只差大小寫',
    'entry-not-js': '入口必須是 .js 檔',
    'scale-off-grid': `大小必須在 ${SCALE_GRID.min.toFixed(1)}～${SCALE_GRID.max.toFixed(1)} 之間，每格 ${SCALE_GRID.step}`,
    'duplicate-wander-area': '遊走區域重複了',
    'param-min-above-max': '最小值比最大值大',
    'int-max-off-grid': '最大值不在從最小值起算、每格 step 的格子上',
    'invalid-param-default': '預設值不在這個參數的範圍或格子上',
    'duplicate-choice-value': '選項的值重複了',
    'choice-default-not-option': '預設值不是其中一個選項',
    'duplicate-asset-option': '素材選項重複了',
    'asset-default-not-option': '預設素材不是其中一個選項',
    'duplicate-character-id': '角色 id 重複了',
    'duplicate-param-key': '同一個角色的參數 key 重複了',
    'missing-asset-option': '素材選項不是 assets 裡的 key',
    'missing-asset-default': '預設素材不是 assets 裡的 key',
    'duplicate-state': '狀態重複了',
    'fallback-key-in-states':
      'fallback 只能替 states 裡沒有的狀態指定替代，這個狀態已經在 states 裡',
    'fallback-value-not-in-states': 'fallback 指定的狀態不在 states 裡',
    'hitbox-outside-bounds': 'hitbox 超出了 bounds',
    'missing-projectile-asset': '投射物不是 assets 裡的 key',
    'duplicate-actor-id': 'actor id 重複了',
    'duplicate-emitter-id': '粒子發射器的 id 重複了',
    'bitmap-image-not-object': 'bitmap 的 image 必須是物件',
  });

/**
 * What the page says for a manifest problem that names no rule, by zod's
 * issue code; ZOD_ISSUE_FALLBACK_TEXT for a code not listed.
 */
export const ZOD_ISSUE_TEXTS: Readonly<Record<string, string>> = Object.freeze({
  invalid_type: '型別不對，或缺少這個欄位',
  too_big: '太大或太長',
  too_small: '太小、太短或是空的',
  invalid_format: '格式不對',
  not_multiple_of: '不在規定的倍數上',
  unrecognized_keys: '不認得這個欄位',
  invalid_union: '不符合任何一種允許的寫法',
  invalid_key: '鍵名不對',
  invalid_element: '有不對的項目',
  invalid_value: '不是允許的值',
  custom: '不符合規格',
});

export const ZOD_ISSUE_FALLBACK_TEXT = '不符合規格';

/** What the page says for each install failure code. */
export const INSTALL_FAILURE_TEXTS: Readonly<
  Record<PackInstallFailureCode, string>
> = Object.freeze({
  'index-unwritable':
    '這次啟動時讀不到角色包清單（index.json），所以不能安裝；請查看 run log 後重新啟動 app',
  'stale-plan': '確認之前，這個角色包已經換成別的版本了；請重新匯入',
  'extract-failed': '無法把檔案寫進暫存資料夾（可能是磁碟空間不足或沒有權限）',
  'replace-failed': '無法把新的版本放到安裝位置',
  'index-write-failed': '無法寫入角色包清單（index.json）',
});

/** Why a `too-large` pack is too large. */
export const SIZE_LIMIT_TEXTS: Readonly<Record<PackSizeLimit, string>> =
  Object.freeze({
    'entry-count': `包裡的項目超過 ${PACK_IMPORT_MAX_ENTRIES} 個（資料夾也算）`,
    'total-size': `解壓後的總大小超過 ${PACK_IMPORT_MAX_TOTAL_BYTES / (1024 * 1024)} MiB`,
    'file-count': `檔案超過 ${PACK_IMPORT_MAX_FILES} 個`,
    'declared-size': '有檔案解壓後比它記載的大小還大',
  });

/** Why an entry cannot be loaded. */
export const ENTRY_PROBLEM_TEXTS: Readonly<Record<PackEntryProblem, string>> =
  Object.freeze({
    'syntax-error': '有語法錯誤，或用了 ES module 的 import／export',
    'html-comment': '含有 HTML 註解（<!-- 或 -->）',
    'dynamic-import': '用了 import()',
    'direct-eval': '直接呼叫了 eval()',
    require: '呼叫了 require()',
  });

/**
 * A name the pack's author wrote (labelSchema lets it hold bidi controls
 * such as U+202E), isolated with FSI … PDI so it cannot reorder the text
 * around it (the versions, the question, the warning).
 */
export function isolatedName(name: string): string {
  return `\u2068${name}\u2069`;
}

/** `<major>.<minor>` of the API this stage implements. */
const STAGE_API = formatApiVersion(PACK_API_VERSION);

function imageLimitText(limit: PackImageLimit, path: string | undefined) {
  return limit === 'side'
    ? `圖片「${path ?? '?'}」的寬或高超過 ${PACK_IMPORT_MAX_IMAGE_SIDE} 像素`
    : `所有圖片加起來超過 ${PACK_IMPORT_MAX_TOTAL_PIXELS / 10_000} 萬像素`;
}

/** One sentence for why a pack is refused, with what the code carries. */
export function rejectionText(rejection: PackRejection): string {
  switch (rejection.code) {
    case 'unreadable-file':
      return '讀不到這個檔案（可能已被移走、是資料夾，或沒有讀取權限）';
    case 'invalid-archive':
      return '這不是可用的角色包檔案（不是 zip、檔案損毀、有加密，或用了不支援的壓縮方式）';
    case 'unsafe-path':
      return `包裡有不安全的檔名「${rejection.path}」（每一段只能用英數字與「.」「_」「-」，不能有「..」或絕對路徑）`;
    case 'shortcut':
      return `包裡有捷徑或符號連結「${rejection.path}」`;
    case 'name-conflict':
      return `包裡有同名或只差大小寫的檔案「${rejection.path}」`;
    case 'invalid-root':
      return '包的最外層必須剛好是一個資料夾，沒有別的檔案或資料夾（例如 __MACOSX）';
    case 'too-large':
      return `角色包太大：${SIZE_LIMIT_TEXTS[rejection.limit]}`;
    case 'missing-manifest':
      return '包裡沒有 manifest.json';
    case 'manifest-not-json':
      return 'manifest.json 不是有效的 JSON';
    case 'api-incompatible':
      return rejection.reason === 'pack-newer'
        ? `需要舞台 API ≥ ${rejection.required}（目前是 ${STAGE_API}），請先更新 app`
        : `這個角色包的 API 版本不相容（角色包是 ${rejection.required}，舞台是 ${STAGE_API}）`;
    case 'invalid-manifest':
      return 'manifest.json 的內容不符合規格';
    case 'root-folder-mismatch':
      return `最外層資料夾「${rejection.folder}」要和 manifest 的 id「${rejection.packId}」同名`;
    case 'missing-file':
      return `manifest 指定的檔案「${rejection.path}」不在包裡`;
    case 'entry-unparsable':
      return `入口程式無法載入：${ENTRY_PROBLEM_TEXTS[rejection.reason]}`;
    case 'unsupported-image-format':
      return `圖片「${rejection.path}」不是 PNG（目前只收副檔名為 .png 的 PNG 圖片）`;
    case 'invalid-spritesheet':
      return `「${rejection.path}」不是可用的 spritesheet（要是 .json、有 frames，meta.image 指向包裡的圖片，且沒有 related_multi_packs）`;
    case 'image-too-large':
      return imageLimitText(rejection.limit, rejection.path);
  }
}

/**
 * A manifest field path as the page shows it: `characters[0].hitbox`;
 * （整份 manifest） for the manifest itself.
 */
export function fieldPathText(path: PackManifestIssue['path']): string {
  if (path.length === 0) {
    return '（整份 manifest）';
  }
  return path
    .map((part, i) =>
      typeof part === 'number' ? `[${part}]` : i === 0 ? part : `.${part}`,
    )
    .join('');
}

/** One manifest problem: where, then what. */
export function issueText(issue: PackManifestIssue): string {
  let what = ZOD_ISSUE_FALLBACK_TEXT;
  if (issue.rule !== undefined) {
    what = ISSUE_RULE_TEXTS[issue.rule];
  } else if (Object.hasOwn(ZOD_ISSUE_TEXTS, issue.code)) {
    what = ZOD_ISSUE_TEXTS[issue.code] as string;
  }
  return `${fieldPathText(issue.path)}：${what}`;
}

/** The lines under a refusal: the manifest problems, then 還有 N 項. */
export function rejectionDetails(
  rejection: PackRejection,
  moreIssues: number,
): string[] {
  if (rejection.code !== 'invalid-manifest') {
    return [];
  }
  const lines = rejection.issues.map(issueText);
  if (moreIssues > 0) {
    lines.push(`還有 ${moreIssues} 項`);
  }
  return lines;
}

/** The status line's look: in progress, done, refused or failed, or neutral. */
export type PackImportTone = 'progress' | 'success' | 'error' | 'neutral';

export interface PackImportStatus {
  readonly tone: PackImportTone;
  readonly text: string;
  /** Lines under it (the manifest problems of a refusal). */
  readonly details: readonly string[];
}

export interface PackImportConfirm {
  readonly question: string;
  /** The downgrade warning, or null when it is not a downgrade. */
  readonly downgradeWarning: string | null;
}

export interface PackImportView {
  /** Whether 匯入角色包… may be pressed: not while reading or confirming. */
  readonly canChoose: boolean;
  /** The status line, or null before any import. */
  readonly status: PackImportStatus | null;
  /** The replace confirmation, or null when none is waiting. */
  readonly confirm: PackImportConfirm | null;
}

function status(
  tone: PackImportTone,
  text: string,
  details: readonly string[] = [],
): PackImportStatus {
  return { tone, text, details };
}

/** The import area for the `packImport` section. */
export function packImportView(state: StagePackImport): PackImportView {
  switch (state.phase) {
    case 'idle':
      return { canChoose: true, status: null, confirm: null };
    case 'reading':
      return {
        canChoose: false,
        status: status('progress', READING_TEXT),
        confirm: null,
      };
    case 'confirm': {
      const { previous } = state;
      const again =
        state.version === previous.version ? '（同一個版本，會重新安裝）' : '';
      return {
        canChoose: false,
        status: null,
        confirm: {
          question: `已安裝「${isolatedName(previous.name)}」${previous.version}，要用「${isolatedName(state.name)}」${state.version} 取代嗎？${again}`,
          downgradeWarning: state.downgrade
            ? `注意：${state.version} 比已安裝的 ${previous.version} 舊，取代後會降版。`
            : null,
        },
      };
    }
    case 'result':
      break;
  }
  switch (state.outcome) {
    case 'installed':
      return {
        canChoose: true,
        status: status(
          'success',
          `已安裝：${isolatedName(state.name)} ${state.version}`,
        ),
        confirm: null,
      };
    case 'rejected':
      return {
        canChoose: true,
        status: status(
          'error',
          `無法匯入：${rejectionText(state.rejection)}`,
          rejectionDetails(state.rejection, state.moreIssues),
        ),
        confirm: null,
      };
    case 'failed':
      return {
        canChoose: true,
        status: status(
          'error',
          `安裝失敗：${INSTALL_FAILURE_TEXTS[state.code]}。已安裝的角色包沒有變動。`,
        ),
        confirm: null,
      };
    case 'cancelled':
      return {
        canChoose: true,
        status: status('neutral', '已取消，沒有取代已安裝的版本'),
        confirm: null,
      };
  }
}

/** One button of the replace confirmation and what it sends. */
export interface PackConfirmButton {
  readonly key: 'replace' | 'keep';
  readonly label: string;
  /** What `packs:confirm` gets: true replaces the installed version. */
  readonly replace: boolean;
  readonly disabled: boolean;
}

/** The import area's buttons: whether each may be pressed, and what it sends. */
export interface PackImportControls {
  /** 匯入角色包…: disabled while a request is on its way, with no preload API, or while reading or confirming. */
  readonly importDisabled: boolean;
  /** 取代 then 取消: disabled while a request is on its way or with no preload API. */
  readonly confirmButtons: readonly PackConfirmButton[];
}

/**
 * The buttons for `view`, given whether a request is on its way and
 * whether the preload API is there.
 */
export function packImportControls(
  view: Pick<PackImportView, 'canChoose'>,
  sending: boolean,
  hasApi: boolean,
): PackImportControls {
  const blocked = sending || !hasApi;
  return {
    importDisabled: blocked || !view.canChoose,
    confirmButtons: [
      {
        key: 'replace',
        label: REPLACE_LABEL,
        replace: true,
        disabled: blocked,
      },
      { key: 'keep', label: CANCEL_LABEL, replace: false, disabled: blocked },
    ],
  };
}

/** What pressing a button sends. */
export type PackImportRequest = 'choose' | 'replace' | 'keep';

/** What the page shows when a request fails; StageView is left as it is. */
export function requestErrorText(
  request: PackImportRequest,
  error: IpcError | undefined,
): string {
  const what =
    request === 'choose'
      ? '無法開始匯入'
      : request === 'replace'
        ? '無法取代'
        : '無法取消';
  return error === undefined
    ? what
    : `${what}（${error.code}：${error.message}）`;
}

/** What the page shows around the buttons while a request is sent. */
export interface PackImportActionState {
  /** A request is on its way: every import button is disabled. */
  readonly sending: boolean;
  /** Why the last request failed, or null. */
  readonly error: string | null;
}

export const IDLE_PACK_IMPORT_ACTIONS: PackImportActionState = Object.freeze({
  sending: false,
  error: null,
});

/** `window.awp.packs`, as far as the buttons need it. */
export interface PackImportApi {
  choose(): Promise<IpcResult<null>>;
  confirm(replace: boolean): Promise<IpcResult<null>>;
}

export interface PackImportActions {
  /**
   * Presses 匯入角色包…, unless a request is still on its way: reports
   * `sending`, asks main to open the file dialog, then reports the
   * outcome. Never rejects.
   */
  choose(): Promise<void>;
  /** Presses 取代 (true) or 取消 (false), the same way. Never rejects. */
  confirm(replace: boolean): Promise<void>;
}

/**
 * The import area's buttons. `api` is `window.awp.packs`; `onState` hears
 * every sending / error change. The section itself is never changed here;
 * it comes back through StageView (AD-20).
 */
export function createPackImportActions(
  api: PackImportApi,
  onState: (state: PackImportActionState) => void,
  logError: (message: string, ...details: unknown[]) => void = console.error,
): PackImportActions {
  let sending = false;

  async function send(
    request: PackImportRequest,
    channel: string,
    call: () => Promise<IpcResult<null>>,
  ): Promise<void> {
    if (sending) {
      return;
    }
    sending = true;
    let error: string | null = null;
    try {
      onState({ sending: true, error: null });
      const result = await call();
      if (!result.ok) {
        error = requestErrorText(request, result.error);
        logError(
          `[panels] ${channel}: ${result.error.code}: ${result.error.message}`,
        );
      }
    } catch (thrown) {
      // The call rejected, or onState or logError threw.
      error ??= requestErrorText(request, undefined);
      try {
        logError(`[panels] ${channel} failed`, thrown);
      } catch {
        // Nowhere left to report it; the outcome still goes to onState.
      }
    } finally {
      // Whatever threw above, the next press must not be ignored.
      sending = false;
      try {
        onState({ sending: false, error });
      } catch {
        // The page could not take the outcome; the press still resolves.
      }
    }
  }

  return {
    choose: () => send('choose', 'packs:choose', () => api.choose()),
    confirm: (replace) =>
      send(replace ? 'replace' : 'keep', 'packs:confirm', () =>
        api.confirm(replace),
      ),
  };
}
