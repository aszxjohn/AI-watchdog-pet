/**
 * The app's only entry point while no panel is open (FR7, AD-14): an icon in
 * the macOS menu bar or the Windows notification area, with the menu from
 * menu.ts. Clicking it on macOS opens the menu; on Windows a left click
 * opens it too (a right click always does).
 *
 * If the icon cannot be created, that is logged and the app keeps running:
 * launching it again still opens the main panel.
 *
 * The 示範模式 check mark follows main/detection (showTrayDemoState), so it
 * agrees with a change made from the canvas menu on the demo session.
 */
import { type Menu, Tray } from 'electron';
import { PRODUCT_NAME } from '../../shared/constants';
import type { StateCode } from '../../shared/states';
import { errorCode, logEvent } from '../log/run-log';
import { buildTrayMenu, checkDemoItem, type TrayMenuActions } from './menu';
import { createTrayIcon } from './tray-icon';

/** Tooltip of the tray icon. */
export const TRAY_TOOLTIP = PRODUCT_NAME;

/**
 * Kept here for the life of the app: a Tray that is garbage-collected
 * disappears from the menu bar.
 */
let tray: Tray | undefined;
/** The tray's menu, whose 示範模式 check mark showTrayDemoState() moves. */
let trayMenu: Menu | undefined;

/**
 * Creates the tray icon and its menu. Returns undefined, after logging why,
 * when either cannot be created. Call once, after `ready`.
 */
export function createTray(
  platform: NodeJS.Platform,
  actions: TrayMenuActions,
): Tray | undefined {
  try {
    const menu = buildTrayMenu(actions);
    const created = new Tray(createTrayIcon(platform));
    created.setToolTip(TRAY_TOOLTIP);
    created.setContextMenu(menu);
    if (platform === 'win32') {
      created.on('click', () => {
        created.popUpContextMenu(menu);
      });
    }
    tray = created;
    trayMenu = menu;
    logEvent('windows', 'tray icon created');
    return created;
  } catch (error) {
    logEvent(
      'windows',
      `tray icon could not be created (${errorCode(error)}); the app keeps running without it`,
      'error',
    );
    return undefined;
  }
}

/** The tray created by createTray, if any. */
export function currentTray(): Tray | undefined {
  return tray;
}

/**
 * Moves the tray's 示範模式 check mark to `state` (null: 關閉), the demo
 * session's state as main/detection reports it, and sets the menu again so
 * every platform shows the change (Linux needs that). Nothing when there is
 * no tray or the mark is already there; a failure is logged.
 */
export function showTrayDemoState(state: StateCode | null): void {
  if (tray === undefined || trayMenu === undefined) {
    return;
  }
  try {
    if (checkDemoItem(trayMenu, state)) {
      tray.setContextMenu(trayMenu);
    }
  } catch (error) {
    logEvent(
      'windows',
      `tray demo mode check mark could not be moved (${errorCode(error)})`,
      'error',
    );
  }
}
