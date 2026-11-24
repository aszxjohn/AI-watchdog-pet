/**
 * The app's only entry point while no panel is open (FR7, AD-14): an icon in
 * the macOS menu bar or the Windows notification area, with the menu from
 * menu.ts. Clicking it on macOS opens the menu; on Windows a left click
 * opens it too (a right click always does).
 *
 * If the icon cannot be created, that is logged and the app keeps running:
 * launching it again still opens the main panel.
 *
 * The 示範模式 submenu shows main/pool's demo mode: showTrayDemo() builds
 * the menu again on each change of it, and every 示範模式 item clicked
 * builds it again too, so a radio item Electron checked by itself (a state
 * picked while demo mode first asks which character to show) is put back
 * to what demo mode says. When demo mode asks which character to show,
 * popUpDemoCharacters() pops that question up from the icon.
 */
import { Menu, Tray } from 'electron';
import { PRODUCT_NAME } from '../../shared/constants';
import type { CharacterKey } from '../../shared/packs';
import { errorCode, logEvent } from '../log/run-log';
import {
  buildTrayMenu,
  demoCharacterMenuTemplate,
  type DemoMenuCharacter,
  type DemoMenuState,
  type TrayMenuActions,
} from './menu';
import { createTrayIcon } from './tray-icon';

/** Tooltip of the tray icon. */
export const TRAY_TOOLTIP = PRODUCT_NAME;

/**
 * Kept here for the life of the app: a Tray that is garbage-collected
 * disappears from the menu bar.
 */
let tray: Tray | undefined;
/** The tray's menu, which showTrayDemo() builds again. */
let trayMenu: Menu | undefined;
/** What the tray menu does, to build it again. */
let trayActions: TrayMenuActions | undefined;
/** What the tray menu's 示範模式 shows now. */
let trayDemo: DemoMenuState | undefined;

/** `actions`, each 示範模式 one building the menu again once it is done. */
function rebuildingAfterDemo(actions: TrayMenuActions): TrayMenuActions {
  const again = (): void => {
    if (trayDemo !== undefined) {
      showTrayDemo(trayDemo);
    }
  };
  return {
    ...actions,
    pickDemoCharacter: (key) => {
      actions.pickDemoCharacter(key);
      again();
    },
    pickDemoState: (state) => {
      actions.pickDemoState(state);
      again();
    },
    stopDemo: () => {
      actions.stopDemo();
      again();
    },
  };
}

/**
 * Creates the tray icon and its menu, its 示範模式 showing `demo`.
 * Returns undefined, after logging why, when either cannot be created.
 * Call once, after `ready`.
 */
export function createTray(
  platform: NodeJS.Platform,
  actions: TrayMenuActions,
  demo: DemoMenuState,
): Tray | undefined {
  try {
    const wired = rebuildingAfterDemo(actions);
    const menu = buildTrayMenu(wired, demo);
    const created = new Tray(createTrayIcon(platform));
    created.setToolTip(TRAY_TOOLTIP);
    created.setContextMenu(menu);
    if (platform === 'win32') {
      created.on('click', () => {
        created.popUpContextMenu(trayMenu);
      });
    }
    tray = created;
    trayMenu = menu;
    trayActions = wired;
    trayDemo = demo;
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
 * Builds the tray menu again with its 示範模式 showing `demo`, and sets it
 * on the tray. Nothing when there is no tray; a failure is logged and the
 * menu before stays.
 */
export function showTrayDemo(demo: DemoMenuState): void {
  if (tray === undefined || trayActions === undefined) {
    return;
  }
  trayDemo = demo;
  try {
    const menu = buildTrayMenu(trayActions, demo);
    tray.setContextMenu(menu);
    trayMenu = menu;
  } catch (error) {
    logEvent(
      'windows',
      `tray demo mode menu could not be built again (${errorCode(error)})`,
      'error',
    );
  }
}

/**
 * Asks which character demo mode shows: pops a menu of `characters` up from
 * the tray icon, once the menu just clicked has closed; picking one calls
 * `pick`. Returns false, after logging why, when it cannot (no tray, or
 * the menu could not be shown); then nothing is picked.
 */
export function popUpDemoCharacters(
  characters: readonly DemoMenuCharacter[],
  pick: (key: CharacterKey) => void,
): boolean {
  const shown = tray;
  if (shown === undefined) {
    logEvent(
      'windows',
      'no tray to ask which character demo mode shows',
      'warn',
    );
    return false;
  }
  try {
    const menu = Menu.buildFromTemplate(
      demoCharacterMenuTemplate(characters, pick),
    );
    setImmediate(() => {
      try {
        shown.popUpContextMenu(menu);
      } catch (error) {
        logEvent(
          'windows',
          `the demo character menu could not be shown (${errorCode(error)})`,
          'error',
        );
      }
    });
    return true;
  } catch (error) {
    logEvent(
      'windows',
      `the demo character menu could not be built (${errorCode(error)})`,
      'error',
    );
    return false;
  }
}
