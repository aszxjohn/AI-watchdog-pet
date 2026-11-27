/**
 * The 管理 session page's text and order, built from StageView alone
 * (AD-20): the `sessions` and `adapters` sections main/detection
 * publishes, the `pool` and `actors` sections main/pool publishes, and the
 * `packs` section main/packs publishes (for character names). No React and
 * no DOM types, so it is unit-tested under Node.
 *
 * - A session row: its source's display name, its name (the display name,
 *   or the native id while it has none) and its state's Chinese name, with
 *   推測 beside an inferred state. Rows go by source (SOURCE_CODES order),
 *   then in the order StageView lists the sessions (the order
 *   main/detection first saw them), so a row stays put while its state or
 *   its name changes (a Claude Code session's name goes from its folder to
 *   its title), and when it is released or shown again; a new session goes
 *   last among its source's.
 * - A session held back (src/shared/pool heldBackBy: released, Story 2.8;
 *   or, while 鎖定展示 is on, not locked) still shows its state; the page
 *   fades the row and marks why beside its name: 已釋放, or 未鎖定 while
 *   鎖定展示 is on. Each row has a 鎖定 checkbox, which can be ticked or
 *   unticked at any time, and one button: 釋放, or 改回顯示 on a released
 *   row (disabled while 鎖定展示 is on).
 * - Above the list, the toolbar (sessionToolbar): 全部釋放（N）, N being
 *   the rows not released, which asks before it sends those keys; 全部顯示
 *   （M）, M being the released rows; while 鎖定展示 is on both are
 *   disabled and 鎖定中 is shown beside them. Then the 鎖定展示 switch,
 *   disabled while it is off and no row is locked, with one line saying
 *   what it does now.
 * - What pressing any of them does is createSessionActions: one request
 *   at a time, a failure shown, never rejecting.
 * - Each row names the character the session plays (Story 3.4): its actor
 *   in `actors`, by session key, gives the character key, and the
 *   installed packs give its name (the key itself when no installed pack
 *   has it any more). A session with no actor (held back, an empty pool,
 *   before the start-up sync) reads 沒有角色.
 * - An adapter row: its source's display name and its health's Chinese
 *   name, in SOURCE_CODES order.
 * - With no session, the page says so and points at 示範模式 on the menu
 *   bar or notification area icon.
 */
import { type SessionKey, splitSessionKey } from '../shared/detection-events';
import type { IpcError, IpcResult } from '../shared/ipc';
import { type CharacterKey, characterKey } from '../shared/packs';
import { heldBackBy } from '../shared/pool';
import type { StageView } from '../shared/stage-view';
import {
  ADAPTER_HEALTH_DISPLAY_NAMES,
  DEMO_MODE_LABEL,
  SOURCE_CODES,
  SOURCE_DISPLAY_NAMES,
  type AdapterHealth,
  type SourceCode,
} from '../shared/sources';
import { STATE_DISPLAY_NAMES, type StateCode } from '../shared/states';

/** Heading of the session list. */
export const SESSIONS_HEADING = '偵測到的 session';

/** Each row's checkbox, and its column: lock the session for 鎖定展示. */
export const LOCK_LABEL = '鎖定';

/** Column headings of the session list, in column order. */
export const SESSION_COLUMNS = [
  LOCK_LABEL,
  '來源',
  '名稱',
  '狀態',
  '角色',
  '操作',
] as const;

/** What the 角色 column reads for a session with no character. */
export const NO_CHARACTER_TEXT = '沒有角色';

/** What the page shows when no session is detected. */
export const NO_SESSIONS_TEXT = '目前沒有偵測到 session';

/**
 * The hint below NO_SESSIONS_TEXT. The icon is in the menu bar on macOS and
 * in the notification area (系統匣) on Windows.
 */
export const DEMO_MODE_HINT = `想先看看效果，可以從選單列或系統匣的圖示選「${DEMO_MODE_LABEL}」，再選一個角色或狀態，產生一個示範 session。`;

/** The mark beside an inferred state. */
export const INFERRED_LABEL = '推測';

/** The tooltip of INFERRED_LABEL beside an inferred request (批准、決定). */
export const INFERRED_TITLE =
  '紀錄沒有寫出這個狀態：工具執行太久還沒結束，推測在等你';

/**
 * The tooltip of INFERRED_LABEL beside an inferred 做完了 or 等你回覆: the
 * turn's end was guessed (Story 2.6).
 */
export const INFERRED_TURN_END_TITLE =
  '紀錄沒有寫出這一輪結束：回覆後一段時間沒有新紀錄，推測這一輪結束了';

/** The tooltip of the 推測 mark beside an inferred `state`. */
export function inferredTitle(state: StateCode): string {
  return state === 'done' || state === 'waiting'
    ? INFERRED_TURN_END_TITLE
    : INFERRED_TITLE;
}

/** The mark beside a released session's name. */
export const RELEASED_LABEL = '已釋放';

/** The button on a session that is shown: release it. */
export const RELEASE_ACTION = '釋放';

/** The button on a released session: show it again. */
export const SHOW_AGAIN_ACTION = '改回顯示';

/**
 * The mark beside the name of a session that is not locked while 鎖定展示
 * is on.
 */
export const UNLOCKED_LABEL = '未鎖定';

/** The toolbar's switch. */
export const LOCK_ON_LABEL = '鎖定展示';

/** Beside the release buttons while 鎖定展示 is on (they are disabled). */
export const LOCKING_NOTE = '鎖定中';

/** The toolbar's buttons: release every row, or show every one again. */
export const RELEASE_ALL_ACTION = '全部釋放';
export const SHOW_ALL_ACTION = '全部顯示';

/** The toolbar's 全部釋放 button, for `count` rows not released. */
export function releaseAllLabel(count: number): string {
  return `${RELEASE_ALL_ACTION}（${count}）`;
}

/** The toolbar's 全部顯示 button, for `count` released rows. */
export function showAllLabel(count: number): string {
  return `${SHOW_ALL_ACTION}（${count}）`;
}

/** The question 全部釋放 asks before it sends, for `count` rows. */
export function releaseAllConfirmText(count: number): string {
  return `把 ${count} 個 session 的角色全部收起來？`;
}

/** The question's buttons: send, or stop asking. */
export const RELEASE_ALL_CONFIRM_LABEL = RELEASE_ALL_ACTION;
export const RELEASE_ALL_CANCEL_LABEL = '取消';

/**
 * The line under the 鎖定展示 switch: what it does now, `lockedCount`
 * being the rows locked.
 */
export function lockNoteText(lockOn: boolean, lockedCount: number): string {
  if (lockOn && lockedCount === 0) {
    // The locked sessions ended this run: their keys stay until the next
    // start-up sweep, and the lock with them.
    return '開著，但清單上沒有勾選鎖定的 session，所以其他 session 都不出角色。關掉開關就恢復。';
  }
  if (lockOn) {
    return `開著：只有勾選鎖定的 ${lockedCount} 個 session 有角色，其他 session 和之後新出現的都不出角色。`;
  }
  if (lockedCount === 0) {
    return `關著：沒釋放的 session 都會分到角色。要打開，先在「${LOCK_LABEL}」欄勾選想留下角色的 session。`;
  }
  return `關著：沒釋放的 session 都會分到角色。打開後，只有勾選鎖定的 ${lockedCount} 個 session 有角色。`;
}

/** Heading of the adapter list. */
export const ADAPTERS_HEADING = '轉接器';

/** What the page shows when no adapter is running. */
export const NO_ADAPTERS_TEXT = '目前沒有執行中的轉接器';

export interface SessionRow {
  /** The session key: stable, unique, the React key. */
  readonly key: SessionKey;
  readonly source: string;
  readonly name: string;
  readonly state: string;
  readonly stateCode: StateCode;
  /** The state is inferred: the page marks it 推測. */
  readonly inferred: boolean;
  /** The session is released (its button reads 改回顯示). */
  readonly released: boolean;
  /** The session is locked: its 鎖定 checkbox is ticked. */
  readonly locked: boolean;
  /**
   * Why the session gets no character, as the page marks it beside its
   * name, the row faded: RELEASED_LABEL (released, 鎖定展示 off),
   * UNLOCKED_LABEL (not locked, 鎖定展示 on), or null (not held back).
   */
  readonly mark: string | null;
  /**
   * The 角色 column: the character's name, its key when no installed pack
   * names it, or NO_CHARACTER_TEXT.
   */
  readonly character: string;
  /** The character the session plays, or null when it has none. */
  readonly characterKey: CharacterKey | null;
  /** The button's text: 釋放, or 改回顯示 when released. */
  readonly action: string;
}

export interface AdapterRow {
  /** The source code: stable, unique, the React key. */
  readonly key: SourceCode;
  readonly source: string;
  readonly health: string;
  readonly healthCode: AdapterHealth;
}

/** The native id in a session key: everything after its first `:`. */
export function nativeIdOf(sessionKey: SessionKey): string {
  return splitSessionKey(sessionKey).nativeId;
}

function sourceOrder(source: SourceCode): number {
  return SOURCE_CODES.indexOf(source);
}

/** Each installed character's name, by character key. */
function characterNames(
  packs: StageView['packs'],
): ReadonlyMap<CharacterKey, string> {
  const names = new Map<CharacterKey, string>();
  for (const pack of packs.installed) {
    for (const character of pack.characters) {
      names.set(characterKey(pack.id, character.id), character.name);
    }
  }
  return names;
}

/** The session list's rows, in page order. */
export function sessionRows(
  view: Pick<StageView, 'sessions' | 'pool' | 'actors' | 'packs'>,
): SessionRow[] {
  const releasedKeys = new Set<string>(view.pool.released);
  const lockedKeys = new Set<string>(view.pool.locked);
  const heldBack = heldBackBy(view.pool);
  const heldMark = view.pool.lockOn ? UNLOCKED_LABEL : RELEASED_LABEL;
  const characterOf = new Map<string, CharacterKey>(
    view.actors.map((actor) => [actor.sessionKey, actor.characterKey]),
  );
  const names = characterNames(view.packs);
  // A stable sort by source only: within a source, StageView's order stays.
  return view.sessions
    .map((session) => {
      const released = releasedKeys.has(session.sessionKey);
      const played = characterOf.get(session.sessionKey) ?? null;
      return {
        order: sourceOrder(session.source),
        row: {
          key: session.sessionKey,
          source: SOURCE_DISPLAY_NAMES[session.source],
          name: session.displayName ?? nativeIdOf(session.sessionKey),
          state: STATE_DISPLAY_NAMES[session.state],
          stateCode: session.state,
          inferred: session.confidence === 'inferred',
          released,
          locked: lockedKeys.has(session.sessionKey),
          mark: heldBack(session.sessionKey) ? heldMark : null,
          character:
            played === null ? NO_CHARACTER_TEXT : (names.get(played) ?? played),
          characterKey: played,
          action: released ? SHOW_AGAIN_ACTION : RELEASE_ACTION,
        },
      };
    })
    .sort((a, b) => a.order - b.order)
    .map(({ row }) => row);
}

/** The adapter list's rows, in page order. */
export function adapterRows(view: Pick<StageView, 'adapters'>): AdapterRow[] {
  return [...view.adapters]
    .sort((a, b) => sourceOrder(a.source) - sourceOrder(b.source))
    .map((adapter) => ({
      key: adapter.source,
      source: SOURCE_DISPLAY_NAMES[adapter.source],
      health: ADAPTER_HEALTH_DISPLAY_NAMES[adapter.health],
      healthCode: adapter.health,
    }));
}

/** What each of the page's requests is, for its failure text. */
export type SessionActionKind =
  | 'release'
  | 'show'
  | 'release-all'
  | 'show-all'
  | 'lock'
  | 'unlock'
  | 'lock-on'
  | 'lock-off';

/** What failed, by request. */
export const SESSION_ACTION_FAILURES: Readonly<
  Record<SessionActionKind, string>
> = Object.freeze({
  release: `無法${RELEASE_ACTION} session`,
  show: `無法${SHOW_AGAIN_ACTION}`,
  'release-all': `無法${RELEASE_ALL_ACTION}`,
  'show-all': `無法${SHOW_ALL_ACTION}`,
  lock: `無法${LOCK_LABEL} session`,
  unlock: `無法取消${LOCK_LABEL}`,
  'lock-on': `無法打開${LOCK_ON_LABEL}`,
  'lock-off': `無法關閉${LOCK_ON_LABEL}`,
});

/**
 * What the page shows when a request fails (`error`, or undefined when the
 * call itself threw); the rows stay as StageView has them.
 */
export function sessionActionErrorText(
  kind: SessionActionKind,
  error: IpcError | undefined,
): string {
  const what = SESSION_ACTION_FAILURES[kind];
  return error === undefined
    ? what
    : `${what}（${error.code}：${error.message}）`;
}

/** What the page keeps around the buttons and checkboxes. */
export interface SessionActionState {
  /** A request is on its way: everything that sends is disabled. */
  readonly sending: boolean;
  /** Why the last request failed, or null. */
  readonly error: string | null;
  /** 全部釋放 was pressed: its question is asked. */
  readonly confirming: boolean;
}

export const IDLE_SESSION_ACTIONS: SessionActionState = Object.freeze({
  sending: false,
  error: null,
  confirming: false,
});

/** One of the toolbar's buttons. */
export interface SessionToolbarButton {
  readonly label: string;
  readonly disabled: boolean;
  /** The keys it sends: the rows its number counts, in page order. */
  readonly keys: readonly SessionKey[];
}

/** 全部釋放's question. */
export interface SessionReleaseAllConfirm {
  readonly text: string;
  /** Both its buttons are disabled. */
  readonly disabled: boolean;
  /** The keys 全部釋放 sends: the rows not released, as listed now. */
  readonly keys: readonly SessionKey[];
}

/** The toolbar above the session list. */
export interface SessionToolbar {
  /** Shown while a row is listed, or 鎖定展示 is on (so it can go off). */
  readonly visible: boolean;
  /** 全部釋放（N）: it asks first. */
  readonly releaseAll: SessionToolbarButton;
  /** 全部顯示（M）. */
  readonly showAll: SessionToolbarButton;
  /** LOCKING_NOTE while 鎖定展示 is on, else null. */
  readonly lockingNote: string | null;
  /** The 鎖定展示 switch. */
  readonly lockOn: { readonly checked: boolean; readonly disabled: boolean };
  /** One line: what 鎖定展示 does now (lockNoteText). */
  readonly lockNote: string;
  /** 全部釋放's question while it asks, else null. */
  readonly confirm: SessionReleaseAllConfirm | null;
  /** Each row's 釋放 / 改回顯示 is disabled. */
  readonly rowReleaseDisabled: boolean;
  /** Each row's 鎖定 checkbox is disabled. */
  readonly rowLockDisabled: boolean;
}

/**
 * The toolbar for `rows` (as sessionRows lists them), StageView's
 * 鎖定展示, the page's own state and whether the preload API is there.
 * Everything that sends is disabled while a request is on its way and
 * with no preload API; besides, every release button while 鎖定展示 is on,
 * 全部釋放 or 全部顯示 when it would send no key (and 全部釋放 while it
 * asks), and the 鎖定展示 switch while it is off and no row is locked.
 */
export function sessionToolbar(
  rows: readonly Pick<SessionRow, 'key' | 'released' | 'locked'>[],
  pool: Pick<StageView['pool'], 'lockOn'>,
  state: SessionActionState,
  hasApi: boolean,
): SessionToolbar {
  const blocked = state.sending || !hasApi;
  const shown = rows.filter((row) => !row.released).map((row) => row.key);
  const released = rows.filter((row) => row.released).map((row) => row.key);
  const lockedCount = rows.filter((row) => row.locked).length;
  const asking = state.confirming && !pool.lockOn && shown.length > 0;
  return {
    visible: rows.length > 0 || pool.lockOn,
    releaseAll: {
      label: releaseAllLabel(shown.length),
      disabled: blocked || pool.lockOn || shown.length === 0 || asking,
      keys: shown,
    },
    showAll: {
      label: showAllLabel(released.length),
      disabled: blocked || pool.lockOn || released.length === 0,
      keys: released,
    },
    lockingNote: pool.lockOn ? LOCKING_NOTE : null,
    lockOn: {
      checked: pool.lockOn,
      disabled: blocked || (!pool.lockOn && lockedCount === 0),
    },
    lockNote: lockNoteText(pool.lockOn, lockedCount),
    confirm: asking
      ? {
          text: releaseAllConfirmText(shown.length),
          disabled: blocked,
          keys: shown,
        }
      : null,
    rowReleaseDisabled: blocked || pool.lockOn,
    rowLockDisabled: blocked,
  };
}

/** `window.awp.pool`, as far as the page needs it. */
export interface SessionPoolApi {
  setReleased(
    sessionKey: SessionKey,
    released: boolean,
  ): Promise<IpcResult<null>>;
  setReleasedMany(
    sessionKeys: readonly SessionKey[],
    released: boolean,
  ): Promise<IpcResult<null>>;
  setLocked(sessionKey: SessionKey, locked: boolean): Promise<IpcResult<null>>;
  setLockOn(on: boolean): Promise<IpcResult<null>>;
}

export interface SessionActions {
  /** A row's 釋放, or 改回顯示 on a released row. */
  toggle(row: Pick<SessionRow, 'key' | 'released'>): Promise<void>;
  /** 全部釋放（N）: asks; sends nothing. */
  askReleaseAll(): void;
  /** 取消 on the question: stops asking; sends nothing. */
  keepAll(): void;
  /**
   * 全部釋放 on the question: releases `keys` in one request, then stops
   * asking, whatever came back.
   */
  releaseAll(keys: readonly SessionKey[]): Promise<void>;
  /** 全部顯示（M）: shows `keys` again in one request. */
  showAll(keys: readonly SessionKey[]): Promise<void>;
  /** A row's 鎖定 checkbox: locks the row, or unlocks a locked one. */
  toggleLock(row: Pick<SessionRow, 'key' | 'locked'>): Promise<void>;
  /** The 鎖定展示 switch: turns it on (true) or off (false). */
  setLockOn(on: boolean): Promise<void>;
}

/**
 * The 管理 session page's button and checkbox logic. `api` is
 * `window.awp.pool`; `onState` hears every change of `sending`, the error
 * and the question. A request is sent unless one is still on its way: the
 * page hears `sending`, then the outcome. asking and 取消 send nothing,
 * and nothing happens to them while a request is on its way. Nothing of
 * StageView is changed here; the rows come back through it (AD-20). Never
 * rejects, whatever `api`, `onState` or `logError` do.
 */
export function createSessionActions(
  api: SessionPoolApi,
  onState: (state: SessionActionState) => void,
  logError: (message: string, ...details: unknown[]) => void = console.error,
): SessionActions {
  let state = IDLE_SESSION_ACTIONS;

  /** Takes `next` and tells the page; the page failing changes nothing here. */
  function report(next: SessionActionState): void {
    state = next;
    try {
      onState(next);
    } catch {
      // The page could not take it; the press still resolves.
    }
  }

  async function send(
    kind: SessionActionKind,
    channel: string,
    call: () => Promise<IpcResult<null>>,
  ): Promise<void> {
    if (state.sending) {
      return;
    }
    let error: string | null = null;
    state = { ...state, sending: true, error: null };
    try {
      onState(state);
      const result = await call();
      if (!result.ok) {
        error = sessionActionErrorText(kind, result.error);
        logError(
          `[panels] ${channel}: ${result.error.code}: ${result.error.message}`,
        );
      }
    } catch (thrown) {
      // The call rejected, or onState or logError threw.
      error ??= sessionActionErrorText(kind, undefined);
      try {
        logError(`[panels] ${channel} failed`, thrown);
      } catch {
        // Nowhere left to report it; the outcome still goes to onState.
      }
    } finally {
      // Whatever threw above, the next press must not be ignored.
      report({
        sending: false,
        error,
        // Any press ends the 全部釋放 question: it never comes back by
        // itself once the lock or the rows hid it.
        confirming: false,
      });
    }
  }

  function keepAll(): void {
    if (!state.sending && state.confirming) {
      report({ ...state, confirming: false });
    }
  }

  return {
    toggle(row) {
      const release = !row.released;
      return send(release ? 'release' : 'show', 'pool:set-released', () =>
        api.setReleased(row.key, release),
      );
    },

    askReleaseAll() {
      if (!state.sending && !state.confirming) {
        report({ ...state, confirming: true, error: null });
      }
    },

    keepAll,

    async releaseAll(keys) {
      if (keys.length === 0) {
        keepAll();
        return;
      }
      const given = [...keys];
      await send('release-all', 'pool:set-released-many', () =>
        api.setReleasedMany(given, true),
      );
    },

    async showAll(keys) {
      if (keys.length === 0) {
        return;
      }
      const given = [...keys];
      await send('show-all', 'pool:set-released-many', () =>
        api.setReleasedMany(given, false),
      );
    },

    toggleLock(row) {
      const lock = !row.locked;
      return send(lock ? 'lock' : 'unlock', 'pool:set-locked', () =>
        api.setLocked(row.key, lock),
      );
    },

    setLockOn(on) {
      return send(on ? 'lock-on' : 'lock-off', 'pool:set-lock-on', () =>
        api.setLockOn(on),
      );
    },
  };
}
