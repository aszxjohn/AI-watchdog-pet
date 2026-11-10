import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadSettings,
  type SettingsStore,
} from '../../src/main/settings/store';
import {
  createStageView,
  registerStageViewHandlers,
  type StageViewHub,
} from '../../src/main/stage-view/stage-view';
import {
  createWindowsStageSource,
  type WindowsStageSource,
} from '../../src/main/windows/stage-sources';
import { stageViewSubscribe } from '../../src/shared/ipc';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import {
  stageViewDeltaSchema,
  stageViewSnapshotSchema,
} from '../../src/shared/stage-view';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

let dir: string;
let settings: SettingsStore;
let windows: WindowsStageSource;
let hub: StageViewHub;

/** main/windows' sections before ready. */
const WINDOWS_BEFORE_READY = {
  displays: [],
  canvas: null,
  power: { suspended: false, locked: false },
};
const DISPLAY = {
  id: 1,
  label: 'Built-in Retina Display',
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
  primary: true,
};
const CANVAS = {
  displayId: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
  fallback: false,
};

beforeEach(() => {
  fake.resetFakeElectron();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-stage-view-'));
  settings = loadSettings({ file: path.join(dir, 'settings.json') });
  windows = createWindowsStageSource();
  hub = createStageView({ settings, windows });
});

afterEach(() => {
  settings.flushSync();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function setDisplay(value: number | null) {
  return settings.patch({
    baseRev: settings.get().rev,
    ops: [{ op: 'set', field: 'canvasDisplayId', value }],
  });
}

function contents(id: number, url = 'app://panels/index.html') {
  return fake.createFakeWebContents(id, url, false);
}

describe('StageView composition', () => {
  it("starts at rev 0 with the settings as loaded and main/windows' sections before ready", () => {
    const snapshot = hub.snapshot();

    expect(snapshot).toStrictEqual({
      rev: 0,
      view: {
        settings: { rev: 0, values: SETTINGS_DEFAULTS },
        ...WINDOWS_BEFORE_READY,
      },
    });
    expect(stageViewSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('pushes one delta per settings change, with its own rev, replacing the section', () => {
    const subscriber = contents(1);
    hub.subscribe(subscriber);

    setDisplay(69733632);
    setDisplay(5);

    expect(subscriber.sent).toStrictEqual([
      {
        channel: 'stage-view:delta',
        args: [
          {
            rev: 1,
            sections: {
              settings: {
                rev: 1,
                values: { ...SETTINGS_DEFAULTS, canvasDisplayId: 69733632 },
              },
            },
          },
        ],
      },
      {
        channel: 'stage-view:delta',
        args: [
          {
            rev: 2,
            sections: {
              settings: {
                rev: 2,
                values: { ...SETTINGS_DEFAULTS, canvasDisplayId: 5 },
              },
            },
          },
        ],
      },
    ]);
    for (const { args } of subscriber.sent) {
      expect(stageViewDeltaSchema.safeParse(args[0]).success).toBe(true);
    }
    expect(hub.snapshot()).toStrictEqual({
      rev: 2,
      view: { settings: settings.get(), ...WINDOWS_BEFORE_READY },
    });
  });

  it('keeps its rev separate from the settings rev', () => {
    setDisplay(1);
    setDisplay(2);

    const later = createStageView({ settings, windows });

    expect(later.snapshot().rev).toBe(0);
    expect(later.snapshot().view.settings.rev).toBe(2);
    setDisplay(3);
    expect(later.snapshot().rev).toBe(1);
    expect(later.snapshot().view.settings.rev).toBe(3);
  });

  it('pushes nothing when a patch changes nothing', () => {
    const subscriber = contents(1);
    hub.subscribe(subscriber);

    setDisplay(null);

    expect(subscriber.sent).toStrictEqual([]);
    expect(hub.snapshot().rev).toBe(0);
  });

  it('pushes to every subscriber', () => {
    const first = contents(1);
    const second = contents(2);
    hub.subscribe(first);
    hub.subscribe(second);

    setDisplay(3);

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
  });
});

describe("main/windows' sections", () => {
  it('starts from what the windows source has', () => {
    windows.update({ displays: [DISPLAY], canvas: CANVAS });

    const later = createStageView({ settings, windows });

    expect(later.snapshot()).toStrictEqual({
      rev: 0,
      view: {
        settings: settings.get(),
        displays: [DISPLAY],
        canvas: CANVAS,
        power: WINDOWS_BEFORE_READY.power,
      },
    });
  });

  it('pushes one delta per change, carrying only the sections that changed', () => {
    const subscriber = contents(1);
    hub.subscribe(subscriber);

    windows.update({ displays: [DISPLAY], canvas: CANVAS });
    windows.update({
      power: { suspended: true, locked: false },
      displays: [DISPLAY],
    });

    expect(subscriber.sent.map(({ args }) => args[0])).toStrictEqual([
      { rev: 1, sections: { displays: [DISPLAY], canvas: CANVAS } },
      { rev: 2, sections: { power: { suspended: true, locked: false } } },
    ]);
    for (const { args } of subscriber.sent) {
      expect(stageViewDeltaSchema.safeParse(args[0]).success).toBe(true);
    }
    expect(hub.snapshot()).toStrictEqual({
      rev: 2,
      view: {
        settings: settings.get(),
        displays: [DISPLAY],
        canvas: CANVAS,
        power: { suspended: true, locked: false },
      },
    });
  });

  it('pushes nothing when an update changes nothing', () => {
    const subscriber = contents(1);
    hub.subscribe(subscriber);

    windows.update({ ...WINDOWS_BEFORE_READY });

    expect(subscriber.sent).toStrictEqual([]);
    expect(hub.snapshot().rev).toBe(0);
  });

  it('pushes a canvas that goes back to null', () => {
    windows.update({ canvas: CANVAS });
    const subscriber = contents(1);
    hub.subscribe(subscriber);

    windows.update({ canvas: null });

    expect(subscriber.sent.map(({ args }) => args[0])).toStrictEqual([
      { rev: 2, sections: { canvas: null } },
    ]);
  });

  it('keeps one rev across settings and windows changes', () => {
    setDisplay(5);
    windows.update({ canvas: CANVAS });
    setDisplay(6);

    expect(hub.snapshot().rev).toBe(3);
  });

  it('pushes to the overlay as well as the panels', () => {
    const panels = contents(1);
    const overlay = contents(2, 'app://overlay/index.html');
    hub.subscribe(panels);
    hub.subscribe(overlay);

    windows.update({ canvas: CANVAS });

    expect(panels.sent).toHaveLength(1);
    expect(overlay.sent).toHaveLength(1);
  });
});

describe('subscribers', () => {
  it('answers a fresh snapshot to a second subscribe without registering the webContents again', () => {
    const subscriber = contents(1);

    expect(hub.subscribe(subscriber).rev).toBe(0);
    setDisplay(2);
    const again = hub.subscribe(subscriber);

    expect(again).toStrictEqual({
      rev: 1,
      view: {
        settings: {
          rev: 1,
          values: { ...SETTINGS_DEFAULTS, canvasDisplayId: 2 },
        },
        ...WINDOWS_BEFORE_READY,
      },
    });
    expect(hub.subscriberCount()).toBe(1);
    expect(subscriber.destroyedListenerCount()).toBe(1);

    setDisplay(3);
    expect(subscriber.sent).toHaveLength(2);
  });

  it('drops a webContents when it is destroyed', () => {
    const subscriber = contents(1);
    hub.subscribe(subscriber);

    subscriber.destroy();
    setDisplay(2);

    expect(hub.subscriberCount()).toBe(0);
    expect(subscriber.sent).toStrictEqual([]);
  });

  it('drops a webContents that a push finds destroyed', () => {
    const gone = contents(1);
    const live = contents(2);
    hub.subscribe(gone);
    hub.subscribe(live);
    gone.destroyed = true;

    setDisplay(2);

    expect(hub.subscriberCount()).toBe(1);
    expect(gone.sent).toStrictEqual([]);
    expect(live.sent).toHaveLength(1);
  });

  it('skips, but keeps, a webContents whose page is no longer allowed', () => {
    const subscriber = contents(1);
    hub.subscribe(subscriber);

    subscriber.mainFrame.url = 'https://example.com/';
    setDisplay(2);

    expect(subscriber.sent).toStrictEqual([]);
    expect(hub.subscriberCount()).toBe(1);

    subscriber.mainFrame.url = 'app://panels/index.html';
    setDisplay(3);

    expect(subscriber.sent).toHaveLength(1);
    expect(
      (subscriber.sent[0]?.args[0] as { rev: number } | undefined)?.rev,
    ).toBe(2);
  });
});

describe('stage-view:subscribe', () => {
  it('subscribes the calling webContents and answers a snapshot', async () => {
    registerStageViewHandlers(hub);

    const reply = await fake.ipcRenderer.invoke(stageViewSubscribe.channel);

    expect(reply).toStrictEqual({ ok: true, data: hub.snapshot() });
    expect(hub.subscriberCount()).toBe(1);
  });

  it('subscribes the same webContents once across reloads', async () => {
    registerStageViewHandlers(hub);

    await fake.ipcRenderer.invoke(stageViewSubscribe.channel);
    await fake.ipcRenderer.invoke(stageViewSubscribe.channel);

    expect(hub.subscriberCount()).toBe(1);
    expect(fake.sender.destroyedListenerCount()).toBe(1);
  });

  it('subscribes the overlay too', async () => {
    registerStageViewHandlers(hub);
    fake.sender.mainFrame.url = 'app://overlay/index.html';

    const reply = await fake.ipcRenderer.invoke(stageViewSubscribe.channel);

    expect(reply).toStrictEqual({ ok: true, data: hub.snapshot() });
    expect(hub.subscriberCount()).toBe(1);
  });

  it('refuses a sender whose page is not allowed', async () => {
    registerStageViewHandlers(hub);
    fake.sender.mainFrame.url = 'https://example.com/';

    const reply = await fake.ipcRenderer.invoke(stageViewSubscribe.channel);

    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'sender-rejected' },
    });
    expect(hub.subscriberCount()).toBe(0);
  });
});
