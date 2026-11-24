/**
 * The app's menus (AD-14), defined here and nowhere else; character packs
 * cannot add to them.
 *
 * - The tray menu: one item per panel page (labels from
 *   src/shared/panels.ts), the 示範模式 submenu, a separator, then 結束.
 *   示範模式 (FR21 as changed on 2026-11-24) is built from what main/pool's
 *   demo mode shows (DemoMenuState), in three radio groups split by
 *   separators: 關閉 (checked while demo mode is off; off at every start);
 *   角色, the characters to pick from, the remembered one first (the one
 *   in use checked; while off, the remembered one), or 沒有已安裝的角色
 *   when there is none; 狀態, the 8 states in STATE_CODES order by their
 *   Chinese names (src/shared/states.ts), the one shown checked while on.
 *   Each item calls its action, which main.ts wires to main/pool's demo
 *   mode. The tray builds the menu again on each change of demo mode
 *   (tray.ts), so every check mark is what demo mode says.
 * - The 示範角色 menu: the characters alone, popped up from the tray when
 *   demo mode asks which one to show (the remembered one is not
 *   installed).
 * - The canvas menu: none yet. A right-click on a character opens nothing
 *   and logs a `windows` line; a character's menu is Story 4.3 (the demo
 *   session's menu on its square, Epic 2 acceptance, went with the square
 *   in Story 3.6).
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
import type { CharacterKey } from '../../shared/packs';
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

/** Heading of the 示範模式 submenu's characters. */
export const DEMO_CHARACTERS_LABEL = '角色';

/** What the 示範模式 submenu shows when no character is installed. */
export const DEMO_NO_CHARACTER_LABEL = '沒有已安裝的角色';

/** Heading of the 示範模式 submenu's states. */
export const DEMO_STATES_LABEL = '狀態';

/** Heading of the menu that asks which character demo mode shows. */
export const DEMO_CHOOSE_LABEL = '選擇示範角色';

/** One character of the 示範模式 menus. */
export interface DemoMenuCharacter {
  readonly key: CharacterKey;
  readonly label: string;
}

/** What the 示範模式 submenu shows: main/pool's demo mode's view. */
export interface DemoMenuState {
  readonly on: boolean;
  /** The state shown; null while off. */
  readonly state: StateCode | null;
  /** The character checked: in use while on, the remembered one while off. */
  readonly character: CharacterKey | null;
  /** The characters listed, in order. */
  readonly characters: readonly DemoMenuCharacter[];
}

/** Demo mode while off, with nothing to list: the menu before any is known. */
export const DEMO_MENU_OFF: DemoMenuState = Object.freeze({
  on: false,
  state: null,
  character: null,
  characters: Object.freeze([]),
});

/** What the 示範模式 submenu does. */
export interface DemoMenuActions {
  /** Shows `key`, turning demo mode on. */
  pickDemoCharacter(key: CharacterKey): void;
  /** Shows `state`, turning demo mode on. */
  pickDemoState(state: StateCode): void;
  /** Turns demo mode off. */
  stopDemo(): void;
}

export interface TrayMenuActions extends DemoMenuActions {
  /** Opens the panel on `page` (or switches the open panel to it). */
  openPage(page: PanelPageId): void;
  /** Quits the app. */
  quit(): void;
}

/**
 * The id of the tray's 示範模式 item for `state`, null being 關閉:
 * `demo-off`, `demo-<state>`.
 */
export function demoItemId(state: StateCode | null): string {
  return state === null ? 'demo-off' : `demo-${state}`;
}

/** The id of the 示範模式 item for character `key`: `demo-character-<key>`. */
export function demoCharacterItemId(key: CharacterKey): string {
  return `demo-character-${key}`;
}

function demoSubmenu(
  actions: DemoMenuActions,
  demo: DemoMenuState,
): MenuItemConstructorOptions[] {
  const characters: MenuItemConstructorOptions[] =
    demo.characters.length === 0
      ? [
          {
            id: 'demo-no-character',
            label: DEMO_NO_CHARACTER_LABEL,
            enabled: false,
          },
        ]
      : demo.characters.map(
          ({ key, label }): MenuItemConstructorOptions => ({
            id: demoCharacterItemId(key),
            type: 'radio',
            label,
            checked: key === demo.character,
            click: () => {
              actions.pickDemoCharacter(key);
            },
          }),
        );
  return [
    {
      id: demoItemId(null),
      type: 'radio',
      label: DEMO_OFF_LABEL,
      checked: !demo.on,
      click: () => {
        actions.stopDemo();
      },
    },
    { type: 'separator' },
    { id: 'demo-characters', label: DEMO_CHARACTERS_LABEL, enabled: false },
    ...characters,
    { type: 'separator' },
    { id: 'demo-states', label: DEMO_STATES_LABEL, enabled: false },
    ...STATE_CODES.map(
      (state): MenuItemConstructorOptions => ({
        id: demoItemId(state),
        type: 'radio',
        label: STATE_DISPLAY_NAMES[state],
        checked: demo.on && state === demo.state,
        click: () => {
          actions.pickDemoState(state);
        },
      }),
    ),
  ];
}

/**
 * The menu that asks which character demo mode shows: a heading, then
 * `characters` in order; picking one calls `pick` with it.
 */
export function demoCharacterMenuTemplate(
  characters: readonly DemoMenuCharacter[],
  pick: (key: CharacterKey) => void,
): MenuItemConstructorOptions[] {
  return [
    { id: 'demo-choose', label: DEMO_CHOOSE_LABEL, enabled: false },
    { type: 'separator' },
    ...characters.map(
      ({ key, label }): MenuItemConstructorOptions => ({
        id: demoCharacterItemId(key),
        label,
        click: () => {
          pick(key);
        },
      }),
    ),
  ];
}

/**
 * A right-click on the canvas at `sessionKey`, on `window` (the canvas). No
 * character has a canvas menu yet (Story 4.3): it opens none, logs a
 * `windows` line (with the session's source only) and returns false.
 */
export function openCanvasMenu(
  sessionKey: SessionKey,
  _window: BaseWindow,
): boolean {
  logEvent(
    'windows',
    `canvas right-click on a character (source ${splitSessionKey(sessionKey).source}); no canvas menu yet`,
  );
  return false;
}

export function trayMenuTemplate(
  actions: TrayMenuActions,
  demo: DemoMenuState,
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
    {
      id: 'demo',
      label: DEMO_MODE_LABEL,
      submenu: demoSubmenu(actions, demo),
    },
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

export function buildTrayMenu(
  actions: TrayMenuActions,
  demo: DemoMenuState,
): Menu {
  return Menu.buildFromTemplate(trayMenuTemplate(actions, demo));
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
