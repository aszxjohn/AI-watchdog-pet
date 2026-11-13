/**
 * The 管理 session page's text and order, built from StageView alone
 * (AD-20): the `sessions` and `adapters` sections main/detection
 * publishes, and the `pool` section main/pool publishes. No React and no
 * DOM types, so it is unit-tested under Node.
 *
 * - A session row: its source's display name, its name (the display name,
 *   or the native id while it has none) and its state's Chinese name, with
 *   推測 beside an inferred state. Rows go by source (SOURCE_CODES order),
 *   then in the order StageView lists the sessions (the order
 *   main/detection first saw them), so a row stays put while its state or
 *   its name changes (a Claude Code session's name goes from its folder to
 *   its title), and when it is released or shown again; a new session goes
 *   last among its source's.
 * - A released session (its key is in `pool`, Story 2.8) still shows its
 *   state; the page fades the row and marks 已釋放 beside its name. Each
 *   row has one button: 釋放, or 改回顯示 on a released row. What pressing
 *   it does is createReleaseToggle.
 * - An adapter row: its source's display name and its health's Chinese
 *   name, in SOURCE_CODES order.
 * - With no session, the page says so and points at 示範模式 on the menu
 *   bar or notification area icon.
 */
import { type SessionKey, splitSessionKey } from '../shared/detection-events';
import type { IpcError, IpcResult } from '../shared/ipc';
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

/** Column headings of the session list, in column order. */
export const SESSION_COLUMNS = ['來源', '名稱', '狀態', '操作'] as const;

/** What the page shows when no session is detected. */
export const NO_SESSIONS_TEXT = '目前沒有偵測到 session';

/**
 * The hint below NO_SESSIONS_TEXT. The icon is in the menu bar on macOS and
 * in the notification area (系統匣) on Windows.
 */
export const DEMO_MODE_HINT = `想先看看效果，可以從選單列或系統匣的圖示選「${DEMO_MODE_LABEL}」，選一種狀態產生一個示範 session。`;

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
  /** The session is released: the page fades it and marks it 已釋放. */
  readonly released: boolean;
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

/** The session list's rows, in page order. */
export function sessionRows(
  view: Pick<StageView, 'sessions' | 'pool'>,
): SessionRow[] {
  const releasedKeys = new Set<string>(view.pool.released);
  // A stable sort by source only: within a source, StageView's order stays.
  return view.sessions
    .map((session) => {
      const released = releasedKeys.has(session.sessionKey);
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

/**
 * What the page shows when releasing (or showing again) fails; the row
 * stays as StageView has it.
 */
export function releaseErrorText(
  release: boolean,
  error: IpcError | undefined,
): string {
  const what = release ? '無法釋放 session' : '無法改回顯示';
  return error === undefined
    ? what
    : `${what}（${error.code}：${error.message}）`;
}

/** What the page shows around the buttons while a request is sent. */
export interface ReleaseToggleState {
  /** A request is on its way: every 釋放 / 改回顯示 button is disabled. */
  readonly sending: boolean;
  /** Why the last request failed, or null. */
  readonly error: string | null;
}

export const IDLE_RELEASE_TOGGLE: ReleaseToggleState = Object.freeze({
  sending: false,
  error: null,
});

export interface ReleaseToggle {
  /**
   * Presses `row`'s button, unless a request is still on its way: reports
   * `sending`, asks main/pool to release the session (or show it again
   * when it is released), then reports the outcome. The row itself is
   * never changed here; it comes back through StageView (AD-20). Never
   * rejects.
   */
  toggle(row: Pick<SessionRow, 'key' | 'released'>): Promise<void>;
}

/**
 * The 管理 session page's 釋放 / 改回顯示 logic. `setReleased` is
 * `window.awp.pool.setReleased`; `onState` hears every sending / error
 * change.
 */
export function createReleaseToggle(
  setReleased: (
    sessionKey: SessionKey,
    released: boolean,
  ) => Promise<IpcResult<null>>,
  onState: (state: ReleaseToggleState) => void,
  logError: (message: string, ...details: unknown[]) => void = console.error,
): ReleaseToggle {
  let sending = false;
  return {
    async toggle(row) {
      if (sending) {
        return;
      }
      const release = !row.released;
      sending = true;
      let error: string | null = null;
      try {
        onState({ sending: true, error: null });
        const result = await setReleased(row.key, release);
        if (!result.ok) {
          error = releaseErrorText(release, result.error);
          logError(
            `[panels] pool:set-released: ${result.error.code}: ${result.error.message}`,
          );
        }
      } catch (thrown) {
        // setReleased rejected, or onState or logError threw.
        error ??= releaseErrorText(release, undefined);
        try {
          logError('[panels] pool:set-released failed', thrown);
        } catch {
          // Nowhere left to report it; the outcome still goes to onState.
        }
      } finally {
        // Whatever threw above, the next press must not be ignored.
        sending = false;
        try {
          onState({ sending: false, error });
        } catch {
          // The page could not take the outcome; toggle still resolves.
        }
      }
    },
  };
}
