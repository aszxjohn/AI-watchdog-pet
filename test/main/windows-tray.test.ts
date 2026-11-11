import type { BaseWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_SESSION_KEY } from '../../src/main/detection/adapters/demo/demo';
import {
  createDetection,
  demoStateOf,
  watchDemoState,
} from '../../src/main/detection/detection';
import {
  applicationMenuTemplate,
  buildApplicationMenu,
  buildTrayMenu,
  checkDemoItem,
  CLOSE_PANEL_LABEL,
  DEMO_OFF_LABEL,
  DEMO_TURN_OFF_LABEL,
  demoCanvasMenuTemplate,
  demoItemId,
  openCanvasMenu,
  QUIT_LABEL,
  trayMenuTemplate,
  type ApplicationMenuActions,
  type DemoMenuTarget,
} from '../../src/main/windows/menu';
import {
  createTray,
  currentTray,
  showTrayDemoState,
  TRAY_TOOLTIP,
} from '../../src/main/windows/tray';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import { fakeClock } from '../helpers/fake-clock';
import {
  createTrayIcon,
  drawRingBitmap,
  TRAY_ICON_GRAY,
  TRAY_ICON_REPRESENTATIONS,
  trayIconStyle,
} from '../../src/main/windows/tray-icon';
import type { PanelPageId } from '../../src/shared/panels';
import { DEMO_MODE_LABEL } from '../../src/shared/sources';
import { STATE_CODES, type StateCode } from '../../src/shared/states';

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

  interface TemplateItem {
    id?: string;
    type?: string;
    checked?: boolean;
    click?: () => void;
    submenu?: unknown;
  }

  /**
   * A built menu item, checked the way Electron's are: setting `checked`
   * on a radio item (to any value) checks it and unchecks the rest of its
   * group, the adjacent radio items; click() flips it first, as Electron
   * does before calling the template's click.
   */
  class FakeMenuItem {
    private value: boolean;
    constructor(
      readonly entry: TemplateItem,
      readonly group: FakeMenuItem[],
    ) {
      this.value = entry.checked === true;
    }
    get checked() {
      return this.value;
    }
    set checked(next: boolean) {
      if (this.entry.type !== 'radio') {
        this.value = next;
        return;
      }
      for (const other of this.group) {
        other.value = false;
      }
      this.value = true;
    }
    click() {
      if (this.entry.type === 'radio') {
        this.checked = true;
      }
      this.entry.click?.();
    }
  }

  /** A stand-in for a Menu built from a template. */
  class FakeMenu {
    static popUps: { menu: FakeMenu; options: unknown }[] = [];
    readonly items = new Map<string, FakeMenuItem>();
    constructor(readonly built: TemplateItem[]) {
      this.index(built);
    }
    private index(template: TemplateItem[]) {
      let group: FakeMenuItem[] = [];
      for (const entry of template) {
        if (entry.type !== 'radio') {
          group = [];
        }
        const item = new FakeMenuItem(entry, group);
        if (entry.type === 'radio') {
          group.push(item);
        }
        if (entry.id !== undefined) {
          this.items.set(entry.id, item);
        }
        if (Array.isArray(entry.submenu)) {
          this.index(entry.submenu as TemplateItem[]);
        }
      }
    }
    getMenuItemById(id: string) {
      return this.items.get(id) ?? null;
    }
    /** The ids of the checked items, in template order. */
    checkedIds() {
      return [...this.items]
        .filter(([, item]) => item.checked)
        .map(([id]) => id);
    }
    popup(options: unknown) {
      FakeMenu.popUps.push({ menu: this, options });
    }
  }

  class FakeTray {
    static instances: FakeTray[] = [];
    static failNext = false;
    static failSetContextMenu = false;
    tooltip = '';
    contextMenu: unknown = null;
    /** Every menu setContextMenu was given, in order. */
    readonly contextMenus: unknown[] = [];
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
      if (FakeTray.failSetContextMenu) {
        throw new Error('tray gone');
      }
      this.contextMenu = menu;
      this.contextMenus.push(menu);
    }
    on(event: string, listener: () => void) {
      this.listeners.set(event, listener);
    }
    popUpContextMenu(menu?: unknown) {
      this.popUps.push(menu);
    }
  }

  return { FakeImage, FakeMenu, FakeTray };
});

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: unknown[]) =>
      new fake.FakeMenu(template as never),
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
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.FakeTray.instances.length = 0;
  fake.FakeTray.failSetContextMenu = false;
  fake.FakeMenu.popUps.length = 0;
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    setDemo: vi.fn<(state: StateCode | null) => void>(),
    quit: vi.fn<() => void>(),
  };
}

/** The 示範模式 submenu's items. */
function demoItems(handlers = actions()) {
  const submenu = trayMenuTemplate(handlers).find(
    (item) => item.id === 'demo',
  )?.submenu;
  if (!Array.isArray(submenu)) {
    throw new Error('no 示範模式 submenu');
  }
  return submenu;
}

describe('tray menu template', () => {
  it('lists 管理 session, 角色包, 舞台設定, 示範模式, a separator and 結束', () => {
    const template = trayMenuTemplate(actions());
    expect(template.map((item) => item.type ?? item.label)).toStrictEqual([
      '管理 session',
      '角色包',
      '舞台設定',
      '示範模式',
      'separator',
      '結束',
    ]);
    expect(QUIT_LABEL).toBe('結束');
    expect(DEMO_MODE_LABEL).toBe('示範模式');
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
    const item = trayMenuTemplate(handlers)[5];
    expect(item?.id).toBe('quit');
    click(item);
    expect(handlers.quit).toHaveBeenCalledOnce();
    expect(handlers.openPage).not.toHaveBeenCalled();
    expect(handlers.setDemo).not.toHaveBeenCalled();
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

describe('the 示範模式 submenu', () => {
  it('is one radio group: 關閉, then the 8 states in STATE_CODES order by their Chinese names', () => {
    const items = demoItems();
    expect(items.map((item) => [item.id, item.type, item.label])).toStrictEqual(
      [
        ['demo-off', 'radio', '關閉'],
        ['demo-waiting', 'radio', '等你回覆'],
        ['demo-thinking', 'radio', '思考中'],
        ['demo-working', 'radio', '工作中'],
        ['demo-approval', 'radio', '要你批准'],
        ['demo-decision', 'radio', '要你決定'],
        ['demo-done', 'radio', '做完了'],
        ['demo-idle', 'radio', '休息中'],
        ['demo-error', 'radio', '出錯了'],
      ],
    );
    expect(DEMO_OFF_LABEL).toBe('關閉');
  });

  it('starts with 關閉 checked: demo mode is off at every start', () => {
    expect(demoItems().map((item) => item.checked)).toStrictEqual([
      true,
      ...STATE_CODES.map(() => false),
    ]);
  });

  it('關閉 turns demo mode off', () => {
    const handlers = actions();
    click(demoItems(handlers)[0]);
    expect(handlers.setDemo.mock.calls).toStrictEqual([[null]]);
    expect(handlers.openPage).not.toHaveBeenCalled();
  });

  it.each(STATE_CODES.map((state, index) => [state, index + 1] as const))(
    '%s shows that state on the demo session',
    (state, index) => {
      const handlers = actions();
      click(demoItems(handlers)[index]);
      expect(handlers.setDemo.mock.calls).toStrictEqual([[state]]);
      expect(handlers.quit).not.toHaveBeenCalled();
    },
  );

  it('sits after the pages and before the separator and 結束', () => {
    const ids = trayMenuTemplate(actions()).map((item) => item.id ?? item.type);
    expect(ids).toStrictEqual([
      'open-sessions',
      'open-packs',
      'open-settings',
      'demo',
      'separator',
      'quit',
    ]);
  });
});

describe('the canvas menu on the demo session', () => {
  it('右鍵: the 8 states with the current one checked, a separator, then 關閉示範模式', () => {
    const template = demoCanvasMenuTemplate('approval', actions());
    expect(
      template.map((item) => [item.id, item.type, item.label, item.checked]),
    ).toStrictEqual([
      ['demo-waiting', 'radio', '等你回覆', false],
      ['demo-thinking', 'radio', '思考中', false],
      ['demo-working', 'radio', '工作中', false],
      ['demo-approval', 'radio', '要你批准', true],
      ['demo-decision', 'radio', '要你決定', false],
      ['demo-done', 'radio', '做完了', false],
      ['demo-idle', 'radio', '休息中', false],
      ['demo-error', 'radio', '出錯了', false],
      [undefined, 'separator', undefined, undefined],
      ['demo-turn-off', undefined, '關閉示範模式', undefined],
    ]);
    expect(DEMO_TURN_OFF_LABEL).toBe('關閉示範模式');
  });

  it.each(STATE_CODES)(
    'checks only %s when it is the current state',
    (state) => {
      const checked = demoCanvasMenuTemplate(state, actions())
        .filter((item) => item.checked === true)
        .map((item) => item.id);
      expect(checked).toStrictEqual([demoItemId(state)]);
    },
  );

  it.each(STATE_CODES.map((state, index) => [state, index] as const))(
    '從選單選: %s shows that state on the demo session',
    (state, index) => {
      const handlers = actions();
      click(demoCanvasMenuTemplate('working', handlers)[index]);
      expect(handlers.setDemo.mock.calls).toStrictEqual([[state]]);
    },
  );

  it('關閉示範模式 turns demo mode off', () => {
    const handlers = actions();
    click(demoCanvasMenuTemplate('working', handlers).at(-1));
    expect(handlers.setDemo.mock.calls).toStrictEqual([[null]]);
  });

  it('shares its state items with the tray submenu: same ids, labels and order', () => {
    const shape = (item: { id?: string; type?: string; label?: string }) => [
      item.id,
      item.type,
      item.label,
    ];
    expect(
      demoCanvasMenuTemplate('done', actions()).slice(0, 8).map(shape),
    ).toStrictEqual(demoItems().slice(1).map(shape));
  });
});

describe('openCanvasMenu', () => {
  const CANVAS_WINDOW = { fake: 'canvas window' } as unknown as BaseWindow;

  function target(state: StateCode | null) {
    const setDemo = vi.fn<(next: StateCode | null) => void>();
    const demo: DemoMenuTarget = {
      sessionKey: 'demo:1',
      state: () => state,
      setDemo,
    };
    return { demo, setDemo };
  }

  function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  it('右鍵: pops the demo menu up on the canvas window, its current state checked', () => {
    const { demo } = target('approval');

    expect(openCanvasMenu('demo:1', CANVAS_WINDOW, demo)).toBe(true);

    expect(fake.FakeMenu.popUps).toHaveLength(1);
    const [popped] = fake.FakeMenu.popUps;
    expect(popped?.options).toStrictEqual({ window: CANVAS_WINDOW });
    expect(popped?.menu.checkedIds()).toStrictEqual(['demo-approval']);
    expect(lines(warn)).toStrictEqual([]);
  });

  it('從選單選: picking 出錯了 from the popped-up menu calls setDemo(error)', () => {
    const { demo, setDemo } = target('approval');
    openCanvasMenu('demo:1', CANVAS_WINDOW, demo);

    fake.FakeMenu.popUps[0]?.menu.getMenuItemById('demo-error')?.click();

    expect(setDemo.mock.calls).toStrictEqual([['error']]);
  });

  it.each([
    ['codex:s1', 'codex'],
    ['claude-code:0b9a7c2e', 'claude-code'],
    ['demo:2', 'demo'],
  ] as const)(
    '不是示範 session (%s): no menu, one windows warning naming only the source',
    (sessionKey, source) => {
      const { demo, setDemo } = target('approval');

      expect(openCanvasMenu(sessionKey, CANVAS_WINDOW, demo)).toBe(false);

      expect(fake.FakeMenu.popUps).toStrictEqual([]);
      expect(setDemo).not.toHaveBeenCalled();
      expect(lines(warn)).toStrictEqual([
        `[windows] canvas menu asked for a session that is not the demo session (source ${source}); no menu`,
      ]);
    },
  );

  it('demo mode already off (its square was still drawn): no menu, one windows warning', () => {
    const { demo } = target(null);

    expect(openCanvasMenu('demo:1', CANVAS_WINDOW, demo)).toBe(false);

    expect(fake.FakeMenu.popUps).toStrictEqual([]);
    expect(lines(warn)).toStrictEqual([
      '[windows] canvas menu asked for the demo session while demo mode is off; no menu',
    ]);
  });
});

describe('the tray check mark follows detection', () => {
  function trayMenuOf(tray: unknown) {
    return (tray as InstanceType<typeof fake.FakeTray>)
      .contextMenu as InstanceType<typeof fake.FakeMenu>;
  }

  it('checkDemoItem moves the check to the state, unchecking the rest; false when it is already there or missing', () => {
    const menu = buildTrayMenu(actions()) as unknown as InstanceType<
      typeof fake.FakeMenu
    >;
    expect(menu.checkedIds()).toStrictEqual(['demo-off']);

    expect(checkDemoItem(menu, 'error')).toBe(true);
    expect(menu.checkedIds()).toStrictEqual(['demo-error']);

    expect(checkDemoItem(menu, 'error')).toBe(false);
    expect(checkDemoItem(menu, null)).toBe(true);
    expect(menu.checkedIds()).toStrictEqual(['demo-off']);

    expect(checkDemoItem({ getMenuItemById: () => null }, 'done')).toBe(false);
  });

  it('兩個入口同步: showTrayDemoState moves the mark and sets the menu again so every platform shows it', () => {
    const tray = createTray('linux', actions()) as unknown as InstanceType<
      typeof fake.FakeTray
    >;
    const menu = trayMenuOf(tray);
    expect(tray.contextMenus).toStrictEqual([menu]);

    showTrayDemoState('error');
    expect(menu.checkedIds()).toStrictEqual(['demo-error']);
    expect(tray.contextMenus).toStrictEqual([menu, menu]);

    showTrayDemoState(null);
    expect(menu.checkedIds()).toStrictEqual(['demo-off']);
    expect(tray.contextMenus).toStrictEqual([menu, menu, menu]);
  });

  it('a mark already in place (a tray click moved it itself) is not set again', () => {
    const tray = createTray('darwin', actions()) as unknown as InstanceType<
      typeof fake.FakeTray
    >;
    const menu = trayMenuOf(tray);
    menu.getMenuItemById('demo-done')?.click();

    showTrayDemoState('done');
    showTrayDemoState('done');

    expect(menu.checkedIds()).toStrictEqual(['demo-done']);
    expect(tray.contextMenus).toStrictEqual([menu]);
  });

  it('logs a failure as a windows error and keeps going', () => {
    createTray('darwin', actions());
    fake.FakeTray.failSetContextMenu = true;

    expect(() => {
      showTrayDemoState('idle');
    }).not.toThrow();

    expect(error).toHaveBeenCalledWith(
      '[windows] tray demo mode check mark could not be moved (Error)',
    );
  });

  it('end to end, wired as main.ts does: the tray and the canvas menu change the same demo session and the tray mark follows both', () => {
    const clock = fakeClock();
    const detection = createDetection({
      settings: {
        get: () => ({ rev: 0, values: SETTINGS_DEFAULTS }),
        onChange: () => () => {},
      },
      monotonic: clock.monotonic,
      wall: clock.wall,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const setDemo = (state: StateCode | null) => {
      detection.setDemo(state);
    };
    const tray = createTray('darwin', { ...actions(), setDemo });
    const menu = trayMenuOf(tray);
    watchDemoState(detection, showTrayDemoState);
    const demo: DemoMenuTarget = {
      sessionKey: DEMO_SESSION_KEY,
      state: () => demoStateOf(detection.get().sessions),
      setDemo,
    };
    const canvasWindow = {} as BaseWindow;

    // 出現: from the tray, 要你批准.
    menu.getMenuItemById('demo-approval')?.click();
    expect(demoStateOf(detection.get().sessions)).toBe('approval');

    // 右鍵 then 從選單選 出錯了: detection and the tray mark both follow.
    expect(openCanvasMenu(DEMO_SESSION_KEY, canvasWindow, demo)).toBe(true);
    const canvasMenu = fake.FakeMenu.popUps.at(-1)?.menu;
    expect(canvasMenu?.checkedIds()).toStrictEqual(['demo-approval']);
    canvasMenu?.getMenuItemById('demo-error')?.click();
    expect(demoStateOf(detection.get().sessions)).toBe('error');
    expect(menu.checkedIds()).toStrictEqual(['demo-error']);

    // The next right-click shows 出錯了 checked.
    openCanvasMenu(DEMO_SESSION_KEY, canvasWindow, demo);
    expect(fake.FakeMenu.popUps.at(-1)?.menu.checkedIds()).toStrictEqual([
      'demo-error',
    ]);

    // 關閉示範模式 from the canvas: the session is gone, the tray says 關閉.
    fake.FakeMenu.popUps.at(-1)?.menu.getMenuItemById('demo-turn-off')?.click();
    expect(detection.get().sessions).toStrictEqual([]);
    expect(menu.checkedIds()).toStrictEqual(['demo-off']);

    detection.stop();
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
    ).toStrictEqual([
      '管理 session',
      '角色包',
      '舞台設定',
      '示範模式',
      undefined,
      '結束',
    ]);
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
