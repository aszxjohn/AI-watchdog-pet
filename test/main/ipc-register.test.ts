import type { IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initRunLog } from '../../src/main/log/run-log';
import { IPC_HANDLER_TIMEOUT_MS } from '../../src/shared/constants';
import { appGetVersion, ipcResultSchema } from '../../src/shared/ipc';
import { z } from '../../src/shared/zod-setup';

type Listener = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown>;

// A stand-in for the parts of electron that register.ts touches.
const fake = vi.hoisted(() => ({
  app: { isPackaged: false },
  listeners: new Map<string, Listener>(),
}));

vi.mock('electron', () => ({
  app: fake.app,
  ipcMain: {
    handle: (channel: string, listener: Listener) => {
      if (fake.listeners.has(channel)) {
        throw new Error(`second handler for ${channel}`);
      }
      fake.listeners.set(channel, listener);
    },
  },
}));

const { registerIpcHandler } = await import('../../src/main/ipc/register');

const DEV_SERVER_URL = 'http://localhost:5173';
const APP_URL = 'app://panels/index.html';

/** A top-level frame unless a parent is given. */
function frame(url: string, parent: object | null = null) {
  return { url, parent };
}

function eventFrom(senderFrame: unknown): IpcMainInvokeEvent {
  return { senderFrame } as unknown as IpcMainInvokeEvent;
}

/** Calls the listener registered for `channel`, as ipcMain would. */
async function invoke(
  channel: string,
  event: IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<unknown> {
  const listener = fake.listeners.get(channel);
  if (listener === undefined) {
    throw new Error(`nothing registered on ${channel}`);
  }
  return listener(event, ...args);
}

/** A test-only channel that takes one string argument. */
const echo = {
  channel: 'test:echo',
  input: z.tuple([z.string()]),
  output: z.string(),
} as const;

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let logDir: string;

/** `[category, message]` of every run log line written in this test. */
function runLogLines(): string[][] {
  return fs
    .readdirSync(logDir)
    .flatMap((name) =>
      fs.readFileSync(path.join(logDir, name), 'utf8').split('\n').slice(0, -1),
    )
    .map((line) => line.split('\t').slice(1));
}

beforeEach(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-ipc-log-'));
  initRunLog(logDir);
  fake.listeners.clear();
  fake.app.isPackaged = false;
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', DEV_SERVER_URL);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe('registerIpcHandler', () => {
  describe('normal call', () => {
    it('answers { ok: true, data } to a top-level app:// frame', async () => {
      registerIpcHandler(appGetVersion, () => '1.2.3');

      const reply = await invoke(
        appGetVersion.channel,
        eventFrom(frame(APP_URL)),
      );

      expect(reply).toStrictEqual({ ok: true, data: '1.2.3' });
      expect(
        ipcResultSchema(appGetVersion.output).safeParse(reply).success,
      ).toBe(true);
    });

    it('allows the Vite dev server origin while not packaged', async () => {
      registerIpcHandler(appGetVersion, () => '1.2.3');

      const reply = await invoke(
        appGetVersion.channel,
        eventFrom(frame(`${DEV_SERVER_URL}/`)),
      );

      expect(reply).toStrictEqual({ ok: true, data: '1.2.3' });
    });

    it('passes validated arguments and the event to the handler', async () => {
      const handler = vi.fn((_event: IpcMainInvokeEvent, text: string) =>
        text.toUpperCase(),
      );
      registerIpcHandler(echo, handler);
      const event = eventFrom(frame(APP_URL));

      const reply = await invoke(echo.channel, event, 'hi');

      expect(reply).toStrictEqual({ ok: true, data: 'HI' });
      expect(handler).toHaveBeenCalledWith(event, 'hi');
    });
  });

  describe('rejected senders', () => {
    it.each([
      ['senderFrame is null', null],
      ['the frame is an iframe', frame(APP_URL, frame(APP_URL))],
      ['packaged build loading file://', frame('file:///app/index.html')],
      ['a non-dev-server http origin', frame('http://localhost:5174/')],
      ['a remote https origin', frame('https://example.com/')],
      ['a frame with no URL yet', frame('')],
      ['about:blank', frame('about:blank')],
    ])(
      'answers { ok: false } without running the handler when %s',
      async (_label, senderFrame) => {
        const handler = vi.fn(() => '1.2.3');
        registerIpcHandler(appGetVersion, handler);

        const reply = await invoke(
          appGetVersion.channel,
          eventFrom(senderFrame),
        );

        expect(reply).toStrictEqual({
          ok: false,
          error: { code: 'sender-rejected', message: 'sender is not allowed' },
        });
        expect(handler).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledOnce();
        const logged = runLogLines();
        expect(logged).toHaveLength(1);
        expect(logged[0]?.[0]).toBe('ipc');
        expect(
          logged[0]?.[1]?.startsWith(
            `${appGetVersion.channel}: sender rejected`,
          ),
        ).toBe(true);
      },
    );

    it('rejects the dev server origin once packaged', async () => {
      fake.app.isPackaged = true;
      const handler = vi.fn(() => '1.2.3');
      registerIpcHandler(appGetVersion, handler);

      const reply = await invoke(
        appGetVersion.channel,
        eventFrom(frame(`${DEV_SERVER_URL}/`)),
      );

      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'sender-rejected' },
      });
      expect(handler).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
    });

    it('rejects every http origin when no dev server is defined', async () => {
      vi.unstubAllGlobals();
      const handler = vi.fn(() => '1.2.3');
      registerIpcHandler(appGetVersion, handler);

      const reply = await invoke(
        appGetVersion.channel,
        eventFrom(frame(`${DEV_SERVER_URL}/`)),
      );

      expect(reply).toMatchObject({ ok: false });
      expect(handler).not.toHaveBeenCalled();
    });

    it('still allows app:// once packaged', async () => {
      fake.app.isPackaged = true;
      registerIpcHandler(appGetVersion, () => '1.2.3');

      const reply = await invoke(
        appGetVersion.channel,
        eventFrom(frame(APP_URL)),
      );

      expect(reply).toStrictEqual({ ok: true, data: '1.2.3' });
    });

    it('rejects a frame that was disposed mid-call', async () => {
      const handler = vi.fn(() => '1.2.3');
      registerIpcHandler(appGetVersion, handler);
      const disposed = {
        get parent() {
          throw new Error('Render frame was disposed');
        },
      };

      const reply = await invoke(appGetVersion.channel, eventFrom(disposed));

      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'sender-rejected' },
      });
      expect(handler).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  describe('input that does not match the schema', () => {
    it.each([
      ['a number instead of a string', [42]],
      ['no argument', []],
      ['an extra argument', ['hi', 'there']],
    ])(
      'answers invalid-input without throwing for %s',
      async (_label, args) => {
        const handler = vi.fn(
          (_event: IpcMainInvokeEvent, text: string) => text,
        );
        registerIpcHandler(echo, handler);

        const reply = await invoke(
          echo.channel,
          eventFrom(frame(APP_URL)),
          ...args,
        );

        expect(reply).toStrictEqual({
          ok: false,
          error: {
            code: 'invalid-input',
            message: 'arguments do not match the channel schema',
          },
        });
        expect(handler).not.toHaveBeenCalled();
      },
    );

    it('rejects an argument sent to app:get-version', async () => {
      registerIpcHandler(appGetVersion, () => '1.2.3');

      const reply = await invoke(
        appGetVersion.channel,
        eventFrom(frame(APP_URL)),
        'unexpected',
      );

      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
    });

    it('answers invalid-input when the input schema itself throws', async () => {
      const throwing = {
        channel: 'test:throwing-input',
        input: z.tuple([
          z.string().refine(() => {
            throw new Error('secret in refine');
          }),
        ]),
        output: z.string(),
      } as const;
      const handler = vi.fn(() => 'x');
      registerIpcHandler(throwing, handler);

      const reply = await invoke(
        throwing.channel,
        eventFrom(frame(APP_URL)),
        'hi',
      );

      expect(reply).toStrictEqual({
        ok: false,
        error: {
          code: 'invalid-input',
          message: 'arguments do not match the channel schema',
        },
      });
      expect(JSON.stringify(reply)).not.toContain('secret');
      expect(handler).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
    });
  });

  describe('handler that throws', () => {
    it.each([
      [
        'throws',
        () => {
          throw new Error('secret at /Users/someone/project/file.ts:1');
        },
      ],
      [
        'rejects',
        () =>
          Promise.reject(
            new Error('secret at /Users/someone/project/file.ts:1'),
          ),
      ],
    ])(
      'answers handler-failed without leaking the error when it %s',
      async (_label, handler) => {
        registerIpcHandler(appGetVersion, handler);

        const reply = await invoke(
          appGetVersion.channel,
          eventFrom(frame(APP_URL)),
        );

        expect(reply).toStrictEqual({
          ok: false,
          error: { code: 'handler-failed', message: 'handler failed' },
        });
        const wire = JSON.stringify(reply);
        expect(wire).not.toContain('secret');
        expect(wire).not.toContain('/Users/');
        expect(error).toHaveBeenCalledOnce();
        const logged = runLogLines();
        expect(logged).toHaveLength(1);
        expect(logged[0]?.[0]).toBe('ipc');
        expect(
          logged[0]?.[1]?.startsWith(
            `${appGetVersion.channel}: handler failed`,
          ),
        ).toBe(true);
        expect(logged[0]?.[1]).not.toContain('secret');
        expect(logged[0]?.[1]).not.toContain('/Users/');
      },
    );

    it('answers invalid-output when the handler returns data the schema rejects', async () => {
      registerIpcHandler(appGetVersion, () => '');

      const reply = await invoke(
        appGetVersion.channel,
        eventFrom(frame(APP_URL)),
      );

      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'invalid-output' },
      });
      expect(error).toHaveBeenCalledOnce();
    });

    it('answers invalid-output when the output schema itself throws', async () => {
      const throwing = {
        channel: 'test:throwing-output',
        input: z.tuple([]),
        output: z.string().transform((): string => {
          throw new Error('secret in transform');
        }),
      } as const;
      registerIpcHandler(throwing, () => 'x');

      const reply = await invoke(throwing.channel, eventFrom(frame(APP_URL)));

      expect(reply).toStrictEqual({
        ok: false,
        error: {
          code: 'invalid-output',
          message: 'handler returned invalid data',
        },
      });
      expect(JSON.stringify(reply)).not.toContain('secret');
      expect(error).toHaveBeenCalledOnce();
    });

    it('answers handler-failed when the handler never settles', async () => {
      vi.useFakeTimers();
      registerIpcHandler(appGetVersion, () => new Promise<string>(() => {}));
      let settled = false;

      const pending = invoke(
        appGetVersion.channel,
        eventFrom(frame(APP_URL)),
      ).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(IPC_HANDLER_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toStrictEqual({
        ok: false,
        error: { code: 'handler-failed', message: 'handler failed' },
      });
      expect(error).toHaveBeenCalledOnce();
    });
  });

  describe('invalid channel name', () => {
    it.each([
      'getVersion',
      'app:getVersion',
      'App:get-version',
      'app:get:version',
      'app:',
    ])('throws at registration for %s', (channel) => {
      expect(() =>
        registerIpcHandler(
          { channel, input: z.tuple([]), output: z.string() },
          () => '1.2.3',
        ),
      ).toThrow(/<domain>:<action>/);
      expect(fake.listeners.has(channel)).toBe(false);
    });
  });
});
