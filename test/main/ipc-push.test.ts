import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pushToRenderer, type PushTarget } from '../../src/main/ipc/push';
import { stageViewDelta } from '../../src/shared/ipc';
import type { StageViewDelta } from '../../src/shared/stage-view';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import { z } from '../../src/shared/zod-setup';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

const DEV_SERVER_URL = 'http://localhost:5173';
const OVERLAY_DEV_SERVER_URL = 'http://localhost:5174';
/** stage-view:delta goes to both renderers. */
const BOTH = ['panels', 'overlay'] as const;
const DELTA: StageViewDelta = {
  rev: 1,
  sections: {
    settings: { rev: 1, values: { ...SETTINGS_DEFAULTS, canvasDisplayId: 7 } },
  },
};

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.resetFakeElectron();
  vi.stubGlobal('PANELS_VITE_DEV_SERVER_URL', DEV_SERVER_URL);
  vi.stubGlobal('OVERLAY_VITE_DEV_SERVER_URL', OVERLAY_DEV_SERVER_URL);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function target(url = 'app://panels/index.html') {
  return fake.createFakeWebContents(7, url, false);
}

describe('pushToRenderer', () => {
  it('sends a valid payload to a live app:// page', () => {
    const contents = target();

    expect(pushToRenderer(contents, stageViewDelta, BOTH, DELTA)).toBe('sent');

    expect(contents.sent).toStrictEqual([
      { channel: 'stage-view:delta', args: [DELTA] },
    ]);
  });

  it('allows the Vite dev server origin while not packaged', () => {
    const contents = target(`${DEV_SERVER_URL}/`);

    expect(pushToRenderer(contents, stageViewDelta, BOTH, DELTA)).toBe('sent');
  });

  it.each([
    ['the overlay page', 'app://overlay/index.html'],
    ['the overlay dev server', `${OVERLAY_DEV_SERVER_URL}/`],
  ])('sends to %s too', (_label, url) => {
    const contents = target(url);

    expect(pushToRenderer(contents, stageViewDelta, BOTH, DELTA)).toBe('sent');
  });

  it.each([
    ['the overlay page', 'app://overlay/index.html', ['panels'] as const],
    [
      'the overlay dev server',
      `${OVERLAY_DEV_SERVER_URL}/`,
      ['panels'] as const,
    ],
    ['the panels page', 'app://panels/index.html', ['overlay'] as const],
    ['the panels dev server', `${DEV_SERVER_URL}/`, ['overlay'] as const],
  ])(
    'does not send to %s when the push does not list it',
    (_label, url, renderers) => {
      const contents = target(url);

      expect(pushToRenderer(contents, stageViewDelta, renderers, DELTA)).toBe(
        'rejected',
      );
      expect(contents.sent).toStrictEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['a remote page', 'https://example.com/'],
    ['file://', 'file:///app/index.html'],
    ['another app:// host', 'app://secret/index.html'],
    ['another localhost port', 'http://localhost:5175/'],
    ['about:blank', 'about:blank'],
    ['no URL yet', ''],
  ])('does not send to %s', (_label, url) => {
    const contents = target(url);

    expect(pushToRenderer(contents, stageViewDelta, BOTH, DELTA)).toBe(
      'rejected',
    );

    expect(contents.sent).toStrictEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not send to the dev server once packaged', () => {
    fake.app.isPackaged = true;
    const contents = target(`${DEV_SERVER_URL}/`);

    expect(pushToRenderer(contents, stageViewDelta, BOTH, DELTA)).toBe(
      'rejected',
    );
    expect(contents.sent).toStrictEqual([]);
  });

  it('does not send to a destroyed webContents', () => {
    const contents = target();
    contents.destroyed = true;

    expect(pushToRenderer(contents, stageViewDelta, BOTH, DELTA)).toBe(
      'destroyed',
    );
    expect(contents.sent).toStrictEqual([]);
  });

  it('treats a webContents whose mainFrame throws as destroyed', () => {
    const contents = {
      id: 7,
      isDestroyed: () => false,
      get mainFrame(): never {
        throw new Error('Render frame was disposed');
      },
      send: vi.fn(),
    } as unknown as PushTarget;

    expect(pushToRenderer(contents, stageViewDelta, BOTH, DELTA)).toBe(
      'destroyed',
    );
    expect(contents.send).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty delta', { rev: 1, sections: {} }],
    ['a delta at rev 0', { ...DELTA, rev: 0 }],
    ['a snapshot instead of a delta', { rev: 1, view: {} }],
  ])('refuses to send %s', (_label, payload) => {
    const contents = target();

    expect(
      pushToRenderer(contents, stageViewDelta, BOTH, payload as StageViewDelta),
    ).toBe('invalid');

    expect(contents.sent).toStrictEqual([]);
    expect(error).toHaveBeenCalledOnce();
  });

  it('refuses a payload whose schema throws', () => {
    const contents = target();
    const throwing = {
      channel: 'test:push',
      payload: z.string().refine(() => {
        throw new Error('boom');
      }),
    };

    expect(pushToRenderer(contents, throwing, BOTH, 'x')).toBe('invalid');
    expect(contents.sent).toStrictEqual([]);
  });

  it('refuses a channel name that is not <domain>:<action>', () => {
    const contents = target();

    expect(
      pushToRenderer(
        contents,
        { channel: 'stageViewDelta', payload: z.string() },
        BOTH,
        'x',
      ),
    ).toBe('invalid');
    expect(contents.sent).toStrictEqual([]);
  });

  it('answers failed instead of throwing when send throws', () => {
    const contents = target();
    contents.send = () => {
      throw new Error('could not be cloned');
    };

    expect(pushToRenderer(contents, stageViewDelta, BOTH, DELTA)).toBe(
      'failed',
    );
    expect(error).toHaveBeenCalledOnce();
  });
});
