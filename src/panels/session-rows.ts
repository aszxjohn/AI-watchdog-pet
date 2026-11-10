/**
 * The 管理 session page's text and order, built from StageView alone
 * (AD-20): the `sessions` and `adapters` sections main/detection
 * publishes. No React and no DOM types, so it is unit-tested under Node.
 *
 * - A session row: its source's display name, its name (the display name,
 *   or the native id while it has none) and its state's Chinese name, with
 *   推測 beside an inferred state. Rows go by source (SOURCE_CODES order),
 *   then name, then key, so they stay put while states change.
 * - An adapter row: its source's display name and its health's Chinese
 *   name, in SOURCE_CODES order.
 * - With no session, the page says so and points at 示範模式 on the menu
 *   bar or notification area icon.
 */
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
export const SESSION_COLUMNS = ['來源', '名稱', '狀態'] as const;

/** What the page shows when no session is detected. */
export const NO_SESSIONS_TEXT = '目前沒有偵測到 session';

/**
 * The hint below NO_SESSIONS_TEXT. The icon is in the menu bar on macOS and
 * in the notification area (系統匣) on Windows.
 */
export const DEMO_MODE_HINT = `想先看看效果，可以從選單列或系統匣的圖示選「${DEMO_MODE_LABEL}」，選一種狀態產生一個示範 session。`;

/** The mark beside an inferred state. */
export const INFERRED_LABEL = '推測';

/** The tooltip of INFERRED_LABEL. */
export const INFERRED_TITLE =
  '紀錄沒有寫出這個狀態：工具執行太久還沒結束，推測在等你';

/** Heading of the adapter list. */
export const ADAPTERS_HEADING = '轉接器';

/** What the page shows when no adapter is running. */
export const NO_ADAPTERS_TEXT = '目前沒有執行中的轉接器';

export interface SessionRow {
  /** The session key: stable, unique, the React key. */
  readonly key: string;
  readonly source: string;
  readonly name: string;
  readonly state: string;
  readonly stateCode: StateCode;
  /** The state is inferred: the page marks it 推測. */
  readonly inferred: boolean;
}

export interface AdapterRow {
  /** The source code: stable, unique, the React key. */
  readonly key: SourceCode;
  readonly source: string;
  readonly health: string;
  readonly healthCode: AdapterHealth;
}

/** The native id in a session key: everything after its first `:`. */
export function nativeIdOf(sessionKey: string): string {
  return sessionKey.slice(sessionKey.indexOf(':') + 1);
}

function sourceOrder(source: SourceCode): number {
  return SOURCE_CODES.indexOf(source);
}

/** Code-unit order, so the result is the same in every locale. */
function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** The session list's rows, in page order. */
export function sessionRows(view: Pick<StageView, 'sessions'>): SessionRow[] {
  return view.sessions
    .map((session) => ({
      order: sourceOrder(session.source),
      row: {
        key: session.sessionKey,
        source: SOURCE_DISPLAY_NAMES[session.source],
        name: session.displayName ?? nativeIdOf(session.sessionKey),
        state: STATE_DISPLAY_NAMES[session.state],
        stateCode: session.state,
        inferred: session.confidence === 'inferred',
      },
    }))
    .sort(
      (a, b) =>
        a.order - b.order ||
        compareText(a.row.name, b.row.name) ||
        compareText(a.row.key, b.row.key),
    )
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
