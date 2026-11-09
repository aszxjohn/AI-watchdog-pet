import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applicationMenuTemplate,
  buildApplicationMenu,
  buildTrayMenu,
  CLOSE_PANEL_LABEL,
  QUIT_LABEL,
  trayMenuTemplate,
  type ApplicationMenuActions,
} from '../../src/main/windows/menu';
import {
  createTray,
  currentTray,
  TRAY_TOOLTIP,
} from '../../src/main/windows/tray';
import {
  createTrayIcon,
  drawRingBitmap,
  TRAY_ICON_GRAY,
  TRAY_ICON_REPRESENTATIONS,
  trayIconStyle,
} from '../../src/main/windows/tray-icon';
import type { PanelPageId } from '../../src/shared/panels';

// Stand-ins for electron's Menu, Tray and nativeImage.
const fake = vi.hoisted(() => {
  class FakeImage {
    readonly representations: {
      scaleFactor: number;
      width: number;
      height: number;
      length: number;
    }[] = [];
    template = false;
    addRepresentation(options: {
      scaleFactor: number;
      width: number;
      height: number;
      buffer: Buffer;
    }) {
      this.representations.push({
        scaleFactor: options.scaleFactor,
        width: options.width,
        height: options.height,
        length: options.buffer.length,
      });
    }
    setTemplateImage(value: boolean) {
      this.template = value;
    }
  }

  class FakeTray {
    static instances: FakeTray[] = [];
    static failNext = false;
    tooltip = '';
    contextMenu: unknown = null;
    readonly listeners = new Map<string, () => void>();
    readonly popUps: unknown[] = [];
    constructor(readonly image: FakeImage) {
      if (FakeTray.failNext) {
        FakeTray.failNext = false;
        throw new Error('tray failed');
      }
      FakeTray.instances.push(this);
    }
    setToolTip(text: string) {
      this.tooltip = text;
    }
    setContextMenu(menu: unknown) {
      this.contextMenu = menu;
    }
    on(event: string, listener: () => void) {
      this.listeners.set(event, listener);
    }
    popUpContextMenu(menu?: unknown) {
      this.popUps.push(menu);
    }
  }

  return { FakeImage, FakeTray };
});

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: unknown[]) => ({ built: template }),
  },
  Tray: fake.FakeTray,
  nativeImage: {
    createFromBitmap: (
      buffer: Buffer,
      options: { width: number; height: number; scaleFactor: number },
    ) => {
      const image = new fake.FakeImage();
      image.representations.push({ ...options, length: buffer.length });
      return image;
    },
  },
}));

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.FakeTray.instances.length = 0;
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Clicks a template item the way Electron's Menu would. */
function click(item: { click?: unknown } | undefined): void {
  const handler = item?.click;
  if (typeof handler !== 'function') {
    throw new Error('menu item has no click handler');
  }
  (handler as () => void)();
}

function actions() {
  return {
    openPage: vi.fn<(page: PanelPageId) => void>(),
    quit: vi.fn<() => void>(),
  };
}

describe('tray menu template', () => {
  it('lists 管理 session, 角色包, 舞台設定, a separator and 結束', () => {
    const template = trayMenuTemplate(actions());
    expect(template.map((item) => item.type ?? item.label)).toStrictEqual([
      '管理 session',
      '角色包',
      '舞台設定',
      'separator',
      '結束',
    ]);
    expect(QUIT_LABEL).toBe('結束');
  });

  it.each([
    [0, 'sessions'],
    [1, 'packs'],
    [2, 'settings'],
  ] as const)('item %i opens the %s page', (index, page) => {
    const handlers = actions();
    const item = trayMenuTemplate(handlers)[index];
    expect(item?.id).toBe(`open-${page}`);
    click(item);
    expect(handlers.openPage).toHaveBeenCalledExactlyOnceWith(page);
    expect(handlers.quit).not.toHaveBeenCalled();
  });

  it('結束 quits', () => {
    const handlers = actions();
    const item = trayMenuTemplate(handlers)[4];
    expect(item?.id).toBe('quit');
    click(item);
    expect(handlers.quit).toHaveBeenCalledOnce();
    expect(handlers.openPage).not.toHaveBeenCalled();
  });

  it('is what buildTrayMenu builds', () => {
    const handlers = actions();
    const menu = buildTrayMenu(handlers) as unknown as {
      built: { label?: string }[];
    };
    expect(menu.built.map((item) => item.label)).toStrictEqual(
      trayMenuTemplate(handlers).map((item) => item.label),
    );
  });
});

describe('createTray', () => {
  it('creates the tray with its tooltip and menu, and logs it', () => {
    const tray = createTray('darwin', actions()) as unknown as InstanceType<
      typeof fake.FakeTray
    >;
    expect(fake.FakeTray.instances).toStrictEqual([tray]);
    expect(tray.tooltip).toBe(TRAY_TOOLTIP);
    expect(TRAY_TOOLTIP).toBe('AI Watchdog Pet');
    expect(
      (tray.contextMenu as { built: { label?: string }[] }).built.map(
        (item) => item.label,
      ),
    ).toStrictEqual(['管理 session', '角色包', '舞台設定', undefined, '結束']);
    expect(info).toHaveBeenCalledWith('[windows] tray icon created');
  });

  it('macOS: clicking opens the context menu by itself; no click handler', () => {
    const tray = createTray('darwin', actions()) as unknown as InstanceType<
      typeof fake.FakeTray
    >;
    expect(tray.listeners.has('click')).toBe(false);
    expect(tray.image.template).toBe(true);
  });

  it('Windows: a left click pops up the same menu', () => {
    const tray = createTray('win32', actions()) as unknown as InstanceType<
      typeof fake.FakeTray
    >;
    tray.listeners.get('click')?.();
    expect(tray.popUps).toStrictEqual([tray.contextMenu]);
    expect(tray.image.template).toBe(false);
  });

  it('keeps the Tray it created, so it is not garbage-collected', () => {
    const tray = createTray('darwin', actions());
    expect(tray).toBeDefined();
    expect(currentTray()).toBe(tray);
  });

  it('logs a tray that cannot be created and keeps going', () => {
    fake.FakeTray.failNext = true;
    expect(createTray('darwin', actions())).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      '[windows] tray icon could not be created (Error); the app keeps running without it',
    );
  });
});

describe('tray icon', () => {
  /** Alpha and first colour channel of pixel (x, y). */
  function pixel(bitmap: Buffer, size: number, x: number, y: number) {
    const offset = (y * size + x) * 4;
    return {
      channels: [...bitmap.subarray(offset, offset + 3)],
      alpha: bitmap[offset + 3],
    };
  }

  it('macOS: black template; Windows and Linux: opaque mid-gray', () => {
    expect(trayIconStyle('darwin')).toStrictEqual({ gray: 0, template: true });
    expect(trayIconStyle('win32')).toStrictEqual({
      gray: TRAY_ICON_GRAY,
      template: false,
    });
    expect(trayIconStyle('linux')).toStrictEqual(trayIconStyle('win32'));
  });

  it.each(TRAY_ICON_REPRESENTATIONS.map(({ size }) => [size]))(
    'draws a %ipx ring: clear centre and corners, opaque band',
    (size) => {
      const bitmap = drawRingBitmap(size, TRAY_ICON_GRAY);
      expect(bitmap.length).toBe(size * size * 4);
      const middle = size / 2;
      // Centre (inside the hole) and corners (outside the ring) are clear.
      expect(pixel(bitmap, size, middle, middle).alpha).toBe(0);
      expect(pixel(bitmap, size, 0, 0).alpha).toBe(0);
      expect(pixel(bitmap, size, size - 1, size - 1).alpha).toBe(0);
      // Halfway through the band, left of centre, is fully opaque gray.
      const band = Math.floor(middle - (size * 5.5) / 16);
      expect(pixel(bitmap, size, band, middle)).toStrictEqual({
        channels: [TRAY_ICON_GRAY, TRAY_ICON_GRAY, TRAY_ICON_GRAY],
        alpha: 255,
      });
    },
  );

  it('premultiplies the colour by alpha on the anti-aliased edge', () => {
    const size = 32;
    const bitmap = drawRingBitmap(size, 200);
    let edges = 0;
    for (let i = 0; i < size * size; i += 1) {
      const alpha = bitmap[i * 4 + 3] ?? 0;
      const channel = bitmap[i * 4] ?? 0;
      expect(channel).toBe(Math.round((200 * alpha) / 255));
      if (alpha > 0 && alpha < 255) {
        edges += 1;
      }
    }
    expect(edges).toBeGreaterThan(0);
  });

  it('is black everywhere on macOS', () => {
    const bitmap = drawRingBitmap(16, 0);
    for (let i = 0; i < 16 * 16; i += 1) {
      expect([...bitmap.subarray(i * 4, i * 4 + 3)]).toStrictEqual([0, 0, 0]);
    }
  });

  it.each([['darwin'], ['win32']] as const)(
    '%s: builds 16px with 1.25x, 1.5x and 2x representations',
    (platform) => {
      const image = createTrayIcon(platform) as unknown as InstanceType<
        typeof fake.FakeImage
      >;
      expect(image.representations).toStrictEqual([
        { width: 16, height: 16, scaleFactor: 1, length: 16 * 16 * 4 },
        { width: 20, height: 20, scaleFactor: 1.25, length: 20 * 20 * 4 },
        { width: 24, height: 24, scaleFactor: 1.5, length: 24 * 24 * 4 },
        { width: 32, height: 32, scaleFactor: 2, length: 32 * 32 * 4 },
      ]);
    },
  );
});

describe('application menu', () => {
  function menuActions() {
    return { closePanel: vi.fn<ApplicationMenuActions['closePanel']>() };
  }

  /** The macOS app menu's items. */
  function appMenuItems(handlers: ApplicationMenuActions) {
    const appMenu = applicationMenuTemplate('darwin', handlers)?.[0];
    return (appMenu?.submenu ?? []) as {
      id?: string;
      role?: string;
      label?: string;
      accelerator?: string;
      click?: unknown;
    }[];
  }

  it('macOS: app menu (關閉面板 ⌘H, 結束), Edit and Window only', () => {
    expect(applicationMenuTemplate('darwin', menuActions())).toStrictEqual([
      {
        label: 'AI Watchdog Pet',
        submenu: [
          {
            id: 'close-panel',
            label: '關閉面板',
            accelerator: 'Command+H',
            click: expect.any(Function),
          },
          { type: 'separator' },
          { role: 'quit', label: '結束' },
        ],
      },
      { role: 'editMenu' },
      {
        role: 'window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { role: 'close' },
          { type: 'separator' },
          { role: 'front' },
        ],
      },
    ]);
    expect(CLOSE_PANEL_LABEL).toBe('關閉面板');
  });

  it('macOS: has no hide, hide others or show all, which would hide the canvas too (R2)', () => {
    const json = JSON.stringify(
      applicationMenuTemplate('darwin', menuActions()),
    );
    for (const role of ['hide', 'hideOthers', 'unhide']) {
      expect(json).not.toContain(`"${role}"`);
    }
  });

  it('macOS: ⌘H is 關閉面板, which closes the panel and nothing else', () => {
    const handlers = menuActions();
    const items = appMenuItems(handlers).filter(
      (item) => item.accelerator === 'Command+H',
    );
    expect(items.map((item) => item.label)).toStrictEqual([CLOSE_PANEL_LABEL]);
    expect(items[0]?.role).toBeUndefined();
    click(items[0]);
    expect(handlers.closePanel).toHaveBeenCalledOnce();
  });

  it('macOS: ⌘W closes the panel (the close role is in the Window menu)', () => {
    const windowMenu = applicationMenuTemplate('darwin', menuActions())?.find(
      (item) => item.role === 'window',
    );
    expect(windowMenu?.submenu).toContainEqual({ role: 'close' });
  });

  it('has no View menu, reload or DevTools item', () => {
    const roles = JSON.stringify(
      applicationMenuTemplate('darwin', menuActions()),
    );
    for (const role of [
      'viewMenu',
      'reload',
      'forceReload',
      'toggleDevTools',
      'fileMenu',
    ]) {
      expect(roles).not.toContain(`"${role}"`);
    }
  });

  it.each([['win32'], ['linux']] as const)('%s: no menu at all', (platform) => {
    expect(applicationMenuTemplate(platform, menuActions())).toBeNull();
    expect(buildApplicationMenu(platform, menuActions())).toBeNull();
  });

  it('builds the macOS template, wired to the same actions', () => {
    const handlers = menuActions();
    const menu = buildApplicationMenu('darwin', handlers) as unknown as {
      built: { submenu?: { click?: unknown }[] }[];
    };
    expect(JSON.stringify(menu.built)).toBe(
      JSON.stringify(applicationMenuTemplate('darwin', handlers)),
    );
    click(menu.built[0]?.submenu?.[0]);
    expect(handlers.closePanel).toHaveBeenCalledOnce();
  });
});
