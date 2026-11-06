/**
 * The app's menus (AD-14), defined here and nowhere else; character packs
 * cannot add to them.
 *
 * - The tray menu: one item per panel page (labels from
 *   src/shared/panels.ts), a separator, then 結束.
 * - The application menu: on macOS only the app menu (hide, hide others,
 *   show all, 結束), Edit (copy and paste in the panel) and Window
 *   (minimize, zoom, close ⌘W, bring all to front); no View menu, so no
 *   reload or DevTools items, packaged or not. Windows and Linux
 *   get none, so the panel window has no menu bar.
 */
import { Menu, type MenuItemConstructorOptions } from 'electron';
import { PRODUCT_NAME } from '../../shared/constants';
import { PANEL_PAGES, type PanelPageId } from '../../shared/panels';

/** Label of the quit item. */
export const QUIT_LABEL = '結束';

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

/** The application menu template for `platform`; null means no menu. */
export function applicationMenuTemplate(
  platform: NodeJS.Platform,
): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') {
    return null;
  }
  return [
    {
      label: PRODUCT_NAME,
      submenu: [
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
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
export function buildApplicationMenu(platform: NodeJS.Platform): Menu | null {
  const template = applicationMenuTemplate(platform);
  return template === null ? null : Menu.buildFromTemplate(template);
}
