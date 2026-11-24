import type { BaseWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applicationMenuTemplate,
  buildApplicationMenu,
  buildTrayMenu,
  CLOSE_PANEL_LABEL,
  DEMO_CHARACTERS_LABEL,
  DEMO_CHOOSE_LABEL,
  DEMO_MENU_OFF,
  DEMO_NO_CHARACTER_LABEL,
  DEMO_OFF_LABEL,
  DEMO_STATES_LABEL,
  demoCharacterItemId,
  demoCharacterMenuTemplate,
  demoItemId,
  openCanvasMenu,
  QUIT_LABEL,
  trayMenuTemplate,
  type ApplicationMenuActions,
  type DemoMenuState,
} from '../../src/main/windows/menu';
import {
  createTray,
  currentTray,
  popUpDemoCharacters,
  showTrayDemo,
  TRAY_TOOLTIP,
} from '../../src/main/windows/tray';
import {
  createTrayIcon,
  drawRingBitmap,
  TRAY_ICON_GRAY,
  TRAY_ICON_REPRESENTATIONS,
  trayIconStyle,
} from '../../src/main/windows/tray-icon';
import type { CharacterKey } from '../../src/shared/packs';
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
    pickDemoCharacter: vi.fn<(key: CharacterKey) => void>(),
    pickDemoState: vi.fn<(state: StateCode) => void>(),
    stopDemo: vi.fn<() => void>(),
    quit: vi.fn<() => void>(),
  };
}

const DYNAMES: CharacterKey = 'dynames/dynames';
const PROBE: CharacterKey = 'contract-pack/probe-one';
const CHARACTERS = [
  { key: DYNAMES, label: '力天使 GN-002（力天使）' },
  { key: PROBE, label: '探針一（契約測試包）' },
] as const;

/** Demo mode off, DYNAMES remembered. */
const OFF: DemoMenuState = {
  on: false,
  state: null,
  character: DYNAMES,
  characters: CHARACTERS,
};

/** Demo mode on: PROBE showing 思考中. */
const ON: DemoMenuState = {
  on: true,
  state: 'thinking',
  character: PROBE,
  characters: CHARACTERS,
};

/** The 示範模式 submenu's items. */
function demoItems(handlers = actions(), demo: DemoMenuState = OFF) {
  const submenu = trayMenuTemplate(handlers, demo).find(
    (item) => item.id === 'demo',
  )?.submenu;
  if (!Array.isArray(submenu)) {
    throw new Error('no 示範模式 submenu');
  }
  return submenu;
}

function demoItem(id: string, handlers = actions(), demo = OFF) {
  const item = demoItems(handlers, demo).find((entry) => entry.id === id);
  if (item === undefined) {
    throw new Error(`no item ${id}`);
  }
  return item;
}

describe('tray menu template', () => {
  it('lists 管理 session, 角色包, 舞台設定, 示範模式, a separator and 結束', () => {
    const template = trayMenuTemplate(actions(), DEMO_MENU_OFF);
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
    const item = trayMenuTemplate(handlers, OFF)[index];
    expect(item?.id).toBe(`open-${page}`);
    click(item);
    expect(handlers.openPage).toHaveBeenCalledExactlyOnceWith(page);
    expect(handlers.quit).not.toHaveBeenCalled();
  });

  it('結束 quits', () => {
    const handlers = actions();
    const item = trayMenuTemplate(handlers, OFF)[5];
    expect(item?.id).toBe('quit');
    click(item);
    expect(handlers.quit).toHaveBeenCalledOnce();
    expect(handlers.openPage).not.toHaveBeenCalled();
    expect(handlers.stopDemo).not.toHaveBeenCalled();
  });

  it('is what buildTrayMenu builds', () => {
    const handlers = actions();
    const menu = buildTrayMenu(handlers, ON) as unknown as {
      built: { label?: string }[];
    };
    expect(menu.built.map((item) => item.label)).toStrictEqual(
      trayMenuTemplate(handlers, ON).map((item) => item.label),
    );
  });

  it('sits 示範模式 after the pages and before the separator and 結束', () => {
    const ids = trayMenuTemplate(actions(), OFF).map(
      (item) => item.id ?? item.type,
    );
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

// FR21 as changed on 2026-11-24: pick a character, then states.
describe('the 示範模式 submenu', () => {
  it('is 關閉, then 角色 (the characters, as demo mode lists them), then 狀態 (the 8 states in STATE_CODES order), three radio groups split by separators', () => {
    const items = demoItems();
    expect(
      items.map((item) => [
        item.id ?? item.type,
        item.type ?? 'normal',
        item.label,
        item.enabled ?? true,
      ]),
    ).toStrictEqual([
      ['demo-off', 'radio', '關閉', true],
      ['separator', 'separator', undefined, true],
      ['demo-characters', 'normal', '角色', false],
      [`demo-character-${DYNAMES}`, 'radio', '力天使 GN-002（力天使）', true],
      [`demo-character-${PROBE}`, 'radio', '探針一（契約測試包）', true],
      ['separator', 'separator', undefined, true],
      ['demo-states', 'normal', '狀態', false],
      ['demo-waiting', 'radio', '等你回覆', true],
      ['demo-thinking', 'radio', '思考中', true],
      ['demo-working', 'radio', '工作中', true],
      ['demo-approval', 'radio', '要你批准', true],
      ['demo-decision', 'radio', '要你決定', true],
      ['demo-done', 'radio', '做完了', true],
      ['demo-idle', 'radio', '休息中', true],
      ['demo-error', 'radio', '出錯了', true],
    ]);
    expect(DEMO_OFF_LABEL).toBe('關閉');
    expect(DEMO_CHARACTERS_LABEL).toBe('角色');
    expect(DEMO_STATES_LABEL).toBe('狀態');
    expect(demoCharacterItemId(DYNAMES)).toBe('demo-character-dynames/dynames');
  });

  it('while off: 關閉 and the remembered character are checked, no state is', () => {
    const checked = demoItems()
      .filter((item) => item.checked === true)
      .map((item) => item.id);
    expect(checked).toStrictEqual(['demo-off', `demo-character-${DYNAMES}`]);
  });

  it('while off with nothing remembered (or not installed): only 關閉 is checked', () => {
    const checked = demoItems(actions(), { ...OFF, character: null })
      .filter((item) => item.checked === true)
      .map((item) => item.id);
    expect(checked).toStrictEqual(['demo-off']);
  });

  it('while on: the character in use and the state shown are checked, 關閉 is not', () => {
    const checked = demoItems(actions(), ON)
      .filter((item) => item.checked === true)
      .map((item) => item.id);
    expect(checked).toStrictEqual([`demo-character-${PROBE}`, 'demo-thinking']);
  });

  it('with no character installed: 沒有已安裝的角色, disabled, in place of the characters', () => {
    const items = demoItems(actions(), DEMO_MENU_OFF);
    expect(items.slice(2, 4)).toStrictEqual([
      { id: 'demo-characters', label: '角色', enabled: false },
      { id: 'demo-no-character', label: '沒有已安裝的角色', enabled: false },
    ]);
    expect(DEMO_NO_CHARACTER_LABEL).toBe('沒有已安裝的角色');
    expect(DEMO_MENU_OFF).toStrictEqual({
      on: false,
      state: null,
      character: null,
      characters: [],
    });
  });

  it('關閉 turns demo mode off', () => {
    const handlers = actions();
    click(demoItem('demo-off', handlers, ON));
    expect(handlers.stopDemo).toHaveBeenCalledOnce();
    expect(handlers.pickDemoState).not.toHaveBeenCalled();
  });

  it.each([DYNAMES, PROBE])('a character picks %s', (key) => {
    const handlers = actions();
    click(demoItem(demoCharacterItemId(key), handlers));
    expect(handlers.pickDemoCharacter.mock.calls).toStrictEqual([[key]]);
    expect(handlers.stopDemo).not.toHaveBeenCalled();
  });

  it.each(STATE_CODES.map((state) => [state] as const))(
    '%s picks that state',
    (state) => {
      const handlers = actions();
      click(demoItem(demoItemId(state), handlers));
      expect(handlers.pickDemoState.mock.calls).toStrictEqual([[state]]);
      expect(handlers.quit).not.toHaveBeenCalled();
    },
  );
});

describe('the 選擇示範角色 menu', () => {
  it('is a heading, a separator and the characters; picking one calls pick with it', () => {
    const pick = vi.fn<(key: CharacterKey) => void>();
    const template = demoCharacterMenuTemplate(CHARACTERS, pick);
    expect(
      template.map((item) => [item.id ?? item.type, item.label, item.enabled]),
    ).toStrictEqual([
      ['demo-choose', '選擇示範角色', false],
      ['separator', undefined, undefined],
      [`demo-character-${DYNAMES}`, '力天使 GN-002（力天使）', undefined],
      [`demo-character-${PROBE}`, '探針一（契約測試包）', undefined],
    ]);
    expect(DEMO_CHOOSE_LABEL).toBe('選擇示範角色');

    click(template[3]);
    expect(pick.mock.calls).toStrictEqual([[PROBE]]);
  });
});

// openCanvasMenu. Story 3.6: the demo session's menu went with the demo
// square; a character's menu is Story 4.3.
describe('I/O matrix', () => {
  const CANVAS_WINDOW = { fake: 'canvas window' } as unknown as BaseWindow;

  function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  it.each([
    ['demo:1', 'demo'],
    ['codex:s1', 'codex'],
    ['claude-code:0b9a7c2e', 'claude-code'],
  ] as const)(
    '滑鼠: a right-click on %s opens no menu (右鍵沒有選單) and logs one windows line naming only the source',
    (sessionKey, source) => {
      info.mockClear();

      expect(openCanvasMenu(sessionKey, CANVAS_WINDOW)).toBe(false);

      expect(fake.FakeMenu.popUps).toStrictEqual([]);
      expect(lines(info)).toStrictEqual([
        `[windows] canvas right-click on a character (source ${source}); no canvas menu yet`,
      ]);
      expect(lines(warn)).toStrictEqual([]);
    },
  );
});

describe('the tray menu follows demo mode', () => {
  type Built = InstanceType<typeof fake.FakeMenu>;

  function trayOf(tray: unknown) {
    return tray as InstanceType<typeof fake.FakeTray>;
  }

  it('showTrayDemo builds the menu again from what demo mode shows and sets it', () => {
    const tray = trayOf(createTray('linux', actions(), OFF));
    const first = tray.contextMenu as Built;
    expect(first.checkedIds()).toStrictEqual([
      'demo-off',
      `demo-character-${DYNAMES}`,
    ]);

    showTrayDemo(ON);
    const second = tray.contextMenu as Built;
    expect(second).not.toBe(first);
    expect(second.checkedIds()).toStrictEqual([
      `demo-character-${PROBE}`,
      'demo-thinking',
    ]);
    expect(tray.contextMenus).toStrictEqual([first, second]);
  });

  it('a demo item clicked builds the menu again, so a check Electron moved by itself never outlives demo mode saying otherwise', () => {
    const handlers = actions();
    const tray = trayOf(createTray('darwin', handlers, OFF));
    const first = tray.contextMenu as Built;

    // Demo mode asks which character to show: nothing changed yet.
    first.getMenuItemById('demo-thinking')?.click();
    expect(handlers.pickDemoState.mock.calls).toStrictEqual([['thinking']]);
    const again = tray.contextMenu as Built;
    expect(again).not.toBe(first);
    expect(again.checkedIds()).toStrictEqual([
      'demo-off',
      `demo-character-${DYNAMES}`,
    ]);

    again.getMenuItemById(`demo-character-${PROBE}`)?.click();
    again.getMenuItemById('demo-off')?.click();
    expect(handlers.pickDemoCharacter.mock.calls).toStrictEqual([[PROBE]]);
    expect(handlers.stopDemo).toHaveBeenCalledOnce();
    expect(tray.contextMenus).toHaveLength(4);
  });

  it('Windows: a left click pops up the menu set last', () => {
    const tray = trayOf(createTray('win32', actions(), OFF));
    showTrayDemo(ON);
    tray.listeners.get('click')?.();
    expect(tray.popUps).toStrictEqual([tray.contextMenu]);
  });

  it('logs a menu that cannot be set again as a windows error and keeps the one before', () => {
    const tray = trayOf(createTray('darwin', actions(), OFF));
    const first = tray.contextMenu;
    fake.FakeTray.failSetContextMenu = true;

    expect(() => {
      showTrayDemo(ON);
    }).not.toThrow();

    expect(tray.contextMenu).toBe(first);
    expect(error).toHaveBeenCalledWith(
      '[windows] tray demo mode menu could not be built again (Error)',
    );
  });

  it('popUpDemoCharacters pops the character menu up from the tray once the menu clicked has closed; picking one calls pick', async () => {
    const tray = trayOf(createTray('darwin', actions(), OFF));
    const pick = vi.fn<(key: CharacterKey) => void>();

    expect(popUpDemoCharacters(CHARACTERS, pick)).toBe(true);
    expect(tray.popUps).toStrictEqual([]);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(tray.popUps).toHaveLength(1);
    const menu = tray.popUps[0] as Built;
    expect(menu.built.map((item) => item.id ?? item.type)).toStrictEqual([
      'demo-choose',
      'separator',
      `demo-character-${DYNAMES}`,
      `demo-character-${PROBE}`,
    ]);
    menu.getMenuItemById(`demo-character-${DYNAMES}`)?.click();
    expect(pick.mock.calls).toStrictEqual([[DYNAMES]]);
  });
});

describe('createTray', () => {
  it('creates the tray with its tooltip and menu, and logs it', () => {
    const tray = createTray(
      'darwin',
      actions(),
      OFF,
    ) as unknown as InstanceType<typeof fake.FakeTray>;
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
    const tray = createTray(
      'darwin',
      actions(),
      OFF,
    ) as unknown as InstanceType<typeof fake.FakeTray>;
    expect(tray.listeners.has('click')).toBe(false);
    expect(tray.image.template).toBe(true);
  });

  it('Windows: a left click pops up the same menu', () => {
    const tray = createTray('win32', actions(), OFF) as unknown as InstanceType<
      typeof fake.FakeTray
    >;
    tray.listeners.get('click')?.();
    expect(tray.popUps).toStrictEqual([tray.contextMenu]);
    expect(tray.image.template).toBe(false);
  });

  it('keeps the Tray it created, so it is not garbage-collected', () => {
    const tray = createTray('darwin', actions(), OFF);
    expect(tray).toBeDefined();
    expect(currentTray()).toBe(tray);
  });

  it('logs a tray that cannot be created and keeps going', () => {
    fake.FakeTray.failNext = true;
    expect(createTray('darwin', actions(), OFF)).toBeUndefined();
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
