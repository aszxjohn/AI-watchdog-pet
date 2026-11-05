import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIpcHandler } from '../../src/main/ipc/register';
import { appGetVersion } from '../../src/shared/ipc';
import type { PanelsApi } from '../../src/shared/preload-api';
import * as fake from '../helpers/fake-electron';

vi.mock('electron', () => import('../helpers/fake-electron'));

beforeEach(() => {
  fake.listeners.clear();
  fake.exposed.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('panels preload', () => {
  it('exposes only window.awp', async () => {
    await import('../../src/preload/panels');

    expect([...fake.exposed.keys()]).toStrictEqual(['awp']);
  });

  it('app.getVersion() resolves with { ok: true, data } from main', async () => {
    registerIpcHandler(appGetVersion, () => '1.2.3');
    await import('../../src/preload/panels');
    const api = fake.exposed.get('awp') as PanelsApi;

    expect(await api.app.getVersion()).toStrictEqual({
      ok: true,
      data: '1.2.3',
    });
  });
});
