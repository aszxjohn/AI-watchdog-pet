/**
 * The app's menus (AD-14), defined here and nowhere else; character packs
 * cannot add to them.
 *
 * - The tray menu: one item per panel page (labels from
 *   src/shared/panels.ts), a separator, then 結束.
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
import { Menu, type MenuItemConstructorOptions } from 'electron';
import { PRODUCT_NAME } from '../../shared/constants';
import { PANEL_PAGES, type PanelPageId } from '../../shared/panels';

/** Label of the quit item. */
export const QUIT_LABEL = '結束';

/** Label of the app menu item that closes the panel (⌘H). */
export const CLOSE_PANEL_LABEL = '關閉面板';

export interface TrayMenuActions {
  /** Opens the panel on `page` (or switches the open panel to it). */
  openPage(page: PanelPageId): void;
  /** Quits the app. */
  quit(): void;
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
