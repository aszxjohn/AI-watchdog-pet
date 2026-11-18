import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  logChildProcessGone,
  watchGpuProcess,
  type ChildProcessGoneDetails,
} from '../../src/main/windows/gpu';

vi.mock('electron', () => import('../helpers/fake-electron'));

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

/** A fake `app` that the test fires `child-process-gone` on. */
function fakeApp() {
  const listeners: ((
    event: unknown,
    details: ChildProcessGoneDetails,
  ) => void)[] = [];
  return {
    on(
      event: 'child-process-gone',
      listener: (event: unknown, details: ChildProcessGoneDetails) => void,
    ) {
      expect(event).toBe('child-process-gone');
      listeners.push(listener);
    },
    gone(details: ChildProcessGoneDetails) {
      for (const listener of listeners) {
        listener({}, details);
      }
    },
    count: () => listeners.length,
  };
}

describe('I/O matrix', () => {
  it('GPU 行程當掉: one error line with the reason code and exit code; nothing else happens', () => {
    const app = fakeApp();
    watchGpuProcess(app);
    expect(app.count()).toBe(1);

    app.gone({ type: 'GPU', reason: 'crashed', exitCode: 139 });

    expect(lines(error)).toStrictEqual([
      '[windows] GPU process gone (crashed, exit code 139); the canvas recovers through its WebGL context',
    ]);
    expect(lines(warn)).toStrictEqual([]);
    expect(lines(info)).toStrictEqual([]);
  });

  it.each([
    ['killed', -1],
    ['oom', 0],
    ['launch-failed', 1003],
  ])('GPU 行程當掉 (%s): each one is its own line', (reason, exitCode) => {
    const app = fakeApp();
    watchGpuProcess(app);

    app.gone({ type: 'GPU', reason, exitCode });
    app.gone({ type: 'GPU', reason, exitCode });

    expect(lines(error)).toStrictEqual([
      `[windows] GPU process gone (${reason}, exit code ${exitCode}); the canvas recovers through its WebGL context`,
      `[windows] GPU process gone (${reason}, exit code ${exitCode}); the canvas recovers through its WebGL context`,
    ]);
  });

  it('GPU 行程當掉: the line carries the process name when Electron gives one', () => {
    logChildProcessGone({
      type: 'GPU',
      reason: 'abnormal-exit',
      exitCode: 15,
      name: 'GPU',
    });

    expect(lines(error)).toStrictEqual([
      '[windows] GPU process "GPU" gone (abnormal-exit, exit code 15); the canvas recovers through its WebGL context',
    ]);
  });

  it('GPU 行程當掉: a clean exit is one info line, with its name, and says nothing of the canvas recovering', () => {
    const app = fakeApp();
    watchGpuProcess(app);

    app.gone({ type: 'GPU', reason: 'clean-exit', exitCode: 0, name: 'GPU' });

    expect(lines(info)).toStrictEqual([
      '[windows] GPU process "GPU" exited cleanly (exit code 0)',
    ]);
    expect(lines(error)).toStrictEqual([]);
    expect(lines(warn)).toStrictEqual([]);
  });

  it.each([['Utility'], ['Zygote'], ['Sandbox helper'], ['Unknown']])(
    'GPU 行程當掉: a %s process gone is not logged here',
    (type) => {
      logChildProcessGone({ type, reason: 'crashed', exitCode: 11 });
      expect(lines(error)).toStrictEqual([]);
      expect(lines(warn)).toStrictEqual([]);
      expect(lines(info)).toStrictEqual([]);
    },
  );
});
