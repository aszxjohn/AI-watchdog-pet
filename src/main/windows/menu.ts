/**
 * The app's menus (AD-14), defined here and nowhere else; character packs
 * cannot add to them.
 *
 * - The tray menu: one item per panel page (labels from
 *   src/shared/panels.ts), the 示範模式 submenu, a separator, then 結束.
 *   示範模式 is one group of radio items: 關閉 (checked at start: demo mode
 *   is off at every start), then the 8 states in STATE_CODES order, by
 *   their Chinese names (src/shared/states.ts). Electron moves the check
 *   mark itself when one is clicked; checkDemoItem() moves it to what
 *   main/detection reports, so it follows a change made from the canvas
 *   menu too.
 * - The canvas menu on the demo session (a right-click on its square, Epic
 *   2 acceptance): the same 8 state items with the current one checked, a
 *   separator, then 關閉示範模式. Both demo menus call setDemo(), which
 *   main.ts wires to main/detection's setDemo(). Right-clicking any other
 *   session opens no menu and logs a `windows` warning.
 * - The application menu: on macOS only the app menu (關閉面板 ⌘H, 結束),
 *   Edit (copy and paste in the panel) and Window (minimize, zoom, close ⌘W,
 *   bring all to front); no View menu, so no reload or DevTools items,
 *   packaged or not. Windows and Linux get none, so the panel window has no
 *   menu bar.
 *
 * The app menu has no hide, hide others or show all: macOS hides every
 * window of the app, the canvas included, and the canvas would only come
 * back once a panel opened (Epic 1 retro R2). ⌘H closes the panel instead,
 * as ⌘W does; the canvas stays on screen.
 */
import {
  Menu,
  type BaseWindow,
  type MenuItemConstructorOptions,
} from 'electron';
import { PRODUCT_NAME } from '../../shared/constants';
import {
  type SessionKey,
  splitSessionKey,
} from '../../shared/detection-events';
import { PANEL_PAGES, type PanelPageId } from '../../shared/panels';
import { DEMO_MODE_LABEL } from '../../shared/sources';
import {
  STATE_CODES,
  STATE_DISPLAY_NAMES,
  type StateCode,
} from '../../shared/states';
import { logEvent } from '../log/run-log';

/** Label of the quit item. */
export const QUIT_LABEL = '結束';

/** Label of the app menu item that closes the panel (⌘H). */
export const CLOSE_PANEL_LABEL = '關閉面板';

/** Label of the demo mode item that turns it off. */
export const DEMO_OFF_LABEL = '關閉';

/** Label of the canvas menu item that turns demo mode off. */
export const DEMO_TURN_OFF_LABEL = `關閉${DEMO_MODE_LABEL}`;

/** What the demo menus do. */
export interface DemoMenuActions {
  /** Demo mode: shows `state` on the demo session; null turns it off. */
  setDemo(state: StateCode | null): void;
}

export interface TrayMenuActions extends DemoMenuActions {
  /** Opens the panel on `page` (or switches the open panel to it). */
  openPage(page: PanelPageId): void;
  /** Quits the app. */
  quit(): void;
}

/**
 * The id of the tray's 示範模式 item for `state`, null being 關閉:
 * `demo-off`, `demo-<state>`. The canvas menu's state items use the same.
 */
export function demoItemId(state: StateCode | null): string {
  return state === null ? 'demo-off' : `demo-${state}`;
}

/**
 * The 8 state items both demo menus share: radio items in STATE_CODES
 * order, by their Chinese names, `current` checked (none when null). Each
 * shows its state on the demo session.
 */
function demoStateItems(
  current: StateCode | null,
  actions: DemoMenuActions,
): MenuItemConstructorOptions[] {
  return STATE_CODES.map(
    (state): MenuItemConstructorOptions => ({
      id: demoItemId(state),
      type: 'radio',
      label: STATE_DISPLAY_NAMES[state],
      checked: state === current,
      click: () => {
        actions.setDemo(state);
      },
    }),
  );
}

function demoSubmenu(actions: TrayMenuActions): MenuItemConstructorOptions[] {
  return [
    {
      id: demoItemId(null),
      type: 'radio',
      label: DEMO_OFF_LABEL,
      checked: true,
      click: () => {
        actions.setDemo(null);
      },
    },
    ...demoStateItems(null, actions),
  ];
}

/** The parts of a Menu that checkDemoItem() uses. */
export interface DemoCheckMenu {
  getMenuItemById(id: string): { checked: boolean } | null;
}

/**
 * Moves the tray's 示範模式 check mark to `state` (null: 關閉), the state
 * main/detection reports. Setting `checked` on a radio item makes Electron
 * uncheck the rest of its group. Returns whether the mark moved: false when
 * it was already there or the item is missing.
 */
export function checkDemoItem(
  menu: DemoCheckMenu,
  state: StateCode | null,
): boolean {
  const item = menu.getMenuItemById(demoItemId(state));
  if (item === null || item.checked) {
    return false;
  }
  item.checked = true;
  return true;
}

/**
 * The canvas menu on the demo session: the 8 state items with `current`
 * checked, a separator, then 關閉示範模式.
 */
export function demoCanvasMenuTemplate(
  current: StateCode,
  actions: DemoMenuActions,
): MenuItemConstructorOptions[] {
  return [
    ...demoStateItems(current, actions),
    { type: 'separator' },
    {
      id: 'demo-turn-off',
      label: DEMO_TURN_OFF_LABEL,
      click: () => {
        actions.setDemo(null);
      },
    },
  ];
}

/**
 * The demo session as the canvas menu needs it. main.ts builds it from
 * main/detection, which main/windows does not import.
 */
export interface DemoMenuTarget extends DemoMenuActions {
  /** The demo session's key. */
  readonly sessionKey: SessionKey;
  /** The state the demo session shows now; null when demo mode is off. */
  state(): StateCode | null;
}

/**
 * A right-click on the canvas at `sessionKey`. The demo session gets its
 * canvas menu, with the state it shows now checked, popped up at the
 * cursor on `window` (the canvas); returns true. Until Epic 3 no other
 * session has a menu: it gets none and a `windows` warning (with its
 * source only), and so does the demo session once demo mode is off (its
 * square was still drawn); returns false.
 */
export function openCanvasMenu(
  sessionKey: SessionKey,
  window: BaseWindow,
  demo: DemoMenuTarget,
): boolean {
  if (sessionKey !== demo.sessionKey) {
    logEvent(
      'windows',
      `canvas menu asked for a session that is not the demo session (source ${splitSessionKey(sessionKey).source}); no menu`,
      'warn',
    );
    return false;
  }
  const current = demo.state();
  if (current === null) {
    logEvent(
      'windows',
      'canvas menu asked for the demo session while demo mode is off; no menu',
      'warn',
    );
    return false;
  }
  Menu.buildFromTemplate(demoCanvasMenuTemplate(current, demo)).popup({
    window,
  });
  return true;
}

export function trayMenuTemplate(
  actions: TrayMenuActions,
): MenuItemConstructorOptions[] {
  return [
    ...PANEL_PAGES.map(
      (page): MenuItemConstructorOptions => ({
        id: `open-${page.id}`,
        label: page.label,
        click: () => {
          actions.openPage(page.id);
        },
      }),
    ),
    { id: 'demo', label: DEMO_MODE_LABEL, submenu: demoSubmenu(actions) },
    { type: 'separator' },
    {
      id: 'quit',
      label: QUIT_LABEL,
      click: () => {
        actions.quit();
      },
    },
  ];
}

export function buildTrayMenu(actions: TrayMenuActions): Menu {
  return Menu.buildFromTemplate(trayMenuTemplate(actions));
}

export interface ApplicationMenuActions {
  /** Closes the panel, as ⌘W does; nothing when no panel is open. */
  closePanel(): void;
}

/** The application menu template for `platform`; null means no menu. */
export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  actions: ApplicationMenuActions,
): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') {
    return null;
  }
  return [
    {
      label: PRODUCT_NAME,
      submenu: [
        {
          id: 'close-panel',
          label: CLOSE_PANEL_LABEL,
          accelerator: 'Command+H',
          click: () => {
            actions.closePanel();
          },
        },
        { type: 'separator' },
        { role: 'quit', label: QUIT_LABEL },
      ],
    },
    { role: 'editMenu' },
    {
      // Spelled out: macOS's windowMenu role has no close item, and without
      // a File menu ⌘W would not close the panel.
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
}

/** The menu for `Menu.setApplicationMenu`; null on Windows and Linux. */
export function buildApplicationMenu(
  platform: NodeJS.Platform,
  actions: ApplicationMenuActions,
): Menu | null {
  const template = applicationMenuTemplate(platform, actions);
  return template === null ? null : Menu.buildFromTemplate(template);
}
