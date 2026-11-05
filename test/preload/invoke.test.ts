import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIpcHandler } from '../../src/main/ipc/register';
import { invoke } from '../../src/preload/invoke';
import { appGetVersion } from '../../src/shared/ipc';
import { z } from '../../src/shared/zod-setup';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

/** A test-only channel that takes one string argument. */
const echo = {
  channel: 'test:echo',
  input: z.tuple([z.string()]),
  output: z.string(),
} as const;

let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.listeners.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('preload invoke', () => {
  it('resolves with the IpcResult main answered', async () => {
    registerIpcHandler(appGetVersion, () => '1.2.3');

    expect(await invoke(appGetVersion)).toStrictEqual({
      ok: true,
      data: '1.2.3',
    });
  });

  it('sends the arguments through to the handler', async () => {
    registerIpcHandler(echo, (_event, text) => text.toUpperCase());

    expect(await invoke(echo, 'hi')).toStrictEqual({ ok: true, data: 'HI' });
  });

  it("passes main's failure through as the result", async () => {
    registerIpcHandler(appGetVersion, () => {
      throw new Error('boom');
    });

    expect(await invoke(appGetVersion)).toStrictEqual({
      ok: false,
      error: { code: 'handler-failed', message: 'handler failed' },
    });
  });

  it('answers invoke-failed instead of rejecting when invoke rejects', async () => {
    const result = await invoke(appGetVersion);

    expect(result).toStrictEqual({
      ok: false,
      error: {
        code: 'invoke-failed',
        message: `invoke ${appGetVersion.channel} failed`,
      },
    });
    expect(error).toHaveBeenCalledOnce();
  });

  it.each([
    ['data of the wrong type', { ok: true, data: 42 }],
    ['no envelope', '1.2.3'],
    [
      'an error with extra keys',
      {
        ok: false,
        error: { code: 'handler-failed', message: 'x', stack: 's' },
      },
    ],
  ])(
    'answers invalid-response when main replies with %s',
    async (_label, reply) => {
      fake.listeners.set(appGetVersion.channel, () => reply);

      const result = await invoke(appGetVersion);

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'invalid-response' },
      });
      expect(error).toHaveBeenCalledOnce();
    },
  );
});
