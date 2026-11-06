import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchPower, type PowerEvent } from '../../src/main/windows/power';
import { createWindowsStageSource } from '../../src/main/windows/stage-sources';

vi.mock('electron', () => import('../helpers/fake-electron'));

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lines(): string[] {
  return info.mock.calls.map((call: unknown[]) => String(call[0]));
}

/** A fake powerMonitor that the test fires events on. */
function fakeMonitor(idleState: () => string = () => 'active') {
  const listeners = new Map<PowerEvent, (() => void)[]>();
  return {
    getSystemIdleState: vi.fn((_threshold: number) => idleState()),
    on(event: PowerEvent, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event: PowerEvent) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
    events: () => [...listeners.keys()],
  };
}

function setup(idleState?: () => string) {
  const monitor = fakeMonitor(idleState);
  const source = createWindowsStageSource();
  const changes = vi.fn();
  source.onChange(changes);
  watchPower(monitor, source);
  return { monitor, source, changes };
}

describe('watchPower at startup', () => {
  it('reads the lock state once and changes nothing while unlocked', () => {
    const { monitor, source, changes } = setup(() => 'idle');

    expect(monitor.getSystemIdleState.mock.calls).toStrictEqual([[0]]);
    expect(source.get().power).toStrictEqual({
      suspended: false,
      locked: false,
    });
    expect(changes).not.toHaveBeenCalled();
    expect(lines()).toStrictEqual([]);
  });

  it('starts locked, with one log line, when the screen is locked', () => {
    const { monitor, source, changes } = setup(() => 'locked');

    expect(source.get().power).toStrictEqual({
      suspended: false,
      locked: true,
    });
    expect(changes.mock.calls).toStrictEqual([
      [{ power: { suspended: false, locked: true } }],
    ]);
    expect(lines()).toStrictEqual(['[windows] screen locked at startup']);

    monitor.emit('unlock-screen');
    expect(source.get().power.locked).toBe(false);
  });

  it('treats a throwing getSystemIdleState as not locked', () => {
    const { source, changes } = setup(() => {
      throw new Error('not supported');
    });

    expect(source.get().power.locked).toBe(false);
    expect(changes).not.toHaveBeenCalled();
  });
});

describe('watchPower', () => {
  it('listens for suspend, resume, lock-screen and unlock-screen', () => {
    const { monitor } = setup();
    expect(monitor.events().sort()).toStrictEqual([
      'lock-screen',
      'resume',
      'suspend',
      'unlock-screen',
    ]);
  });

  it.each([
    ['suspend', { suspended: true, locked: false }, 'system suspended'],
    ['lock-screen', { suspended: false, locked: true }, 'screen locked'],
  ] as const)(
    '%s updates the power section and logs one line',
    (event, power, line) => {
      const { monitor, source, changes } = setup();

      monitor.emit(event);

      expect(source.get().power).toStrictEqual(power);
      expect(changes.mock.calls).toStrictEqual([[{ power }]]);
      expect(lines()).toStrictEqual([`[windows] ${line}`]);
    },
  );

  it('follows a whole sleep: lock, suspend, resume, unlock', () => {
    const { monitor, source, changes } = setup();

    monitor.emit('lock-screen');
    monitor.emit('suspend');
    expect(source.get().power).toStrictEqual({ suspended: true, locked: true });
    monitor.emit('resume');
    expect(source.get().power).toStrictEqual({
      suspended: false,
      locked: true,
    });
    monitor.emit('unlock-screen');

    expect(source.get().power).toStrictEqual({
      suspended: false,
      locked: false,
    });
    expect(changes).toHaveBeenCalledTimes(4);
    expect(lines()).toStrictEqual([
      '[windows] screen locked',
      '[windows] system suspended',
      '[windows] system resumed',
      '[windows] screen unlocked',
    ]);
  });

  it('logs a repeated event but changes StageView only once', () => {
    const { monitor, changes } = setup();

    monitor.emit('suspend');
    monitor.emit('suspend');

    expect(changes).toHaveBeenCalledOnce();
    expect(lines()).toHaveLength(2);
  });

  it('touches only the power section', () => {
    const { monitor, source } = setup();
    const before = source.get();

    monitor.emit('lock-screen');

    expect(source.get().displays).toBe(before.displays);
    expect(source.get().canvas).toBe(before.canvas);
  });
});
