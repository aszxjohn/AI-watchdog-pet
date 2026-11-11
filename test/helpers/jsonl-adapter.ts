/**
 * Helpers for testing an adapter built on the shared JSON Lines core
 * (src/main/detection/adapters/jsonl; Story 2.6, moved here from the
 * Claude Code adapter's tests of Story 2.4):
 *
 * - readAll: splitLines over several reads;
 * - fakeWatcher: a watcher whose handlers the test fires by hand;
 * - filesUnder, fingerprintFiles: what a folder holds, to show a run left
 *   it exactly as it was;
 * - startReal, stopReal, arrives, diagnose: an adapter with the real
 *   watcher (chokidar), waiting for what it emits, with a failure message
 *   that tells why. They need console.info, console.warn and console.error
 *   spied on (vi.spyOn).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, vi } from 'vitest';
import type {
  AdapterContext,
  DetectionAdapter,
} from '../../src/main/detection/adapter';
import {
  type LineCarry,
  NO_CARRY,
  splitLines,
} from '../../src/main/detection/adapters/jsonl/read';
import type {
  WatchHandlers,
  WatchOptions,
  WatchTranscripts,
} from '../../src/main/detection/adapters/jsonl/watcher';
import type { AdapterOutput } from '../../src/shared/detection-events';
import { SETTINGS_DEFAULTS } from '../../src/shared/settings';
import type { AdapterHealth } from '../../src/shared/sources';

/**
 * How long the tests with the real watcher wait for one thing, and how long
 * each may take in all. Generous: chokidar's first scan is much slower on
 * the Windows CI runner than on macOS.
 */
export const REAL_WATCH_WAIT_MS = 20_000;
export const REAL_WATCH_TEST_MS = 60_000;

/** splitLines over `chunks`, one read each; the lines of each read. */
export function readAll(
  chunks: readonly Uint8Array[],
  carry: LineCarry = NO_CARRY,
): { lines: string[][]; carry: LineCarry } {
  const lines: string[][] = [];
  let current = carry;
  for (const chunk of chunks) {
    const split = splitLines(current, chunk);
    lines.push([...split.lines]);
    current = split.carry;
  }
  return { lines, carry: current };
}

/** The fake watcher: tests fire its handlers by hand. */
export function fakeWatcher() {
  let handlers: WatchHandlers | undefined;
  const state = {
    started: 0,
    closed: 0,
    root: undefined as string | undefined,
    follow: undefined as WatchOptions['follow'] | undefined,
    throws: false,
  };
  const watch: WatchTranscripts = (watchedRoot, { follow }, on) => {
    state.started += 1;
    if (state.throws) {
      throw Object.assign(new Error('no watcher'), { code: 'EMFILE' });
    }
    state.root = watchedRoot;
    state.follow = follow;
    handlers = on;
    return {
      close: async () => {
        state.closed += 1;
      },
    };
  };
  const on = (): WatchHandlers => {
    if (handlers === undefined) {
      throw new Error('the watcher was not started');
    }
    return handlers;
  };
  return { watch, state, on };
}

/** Every file under `dir`, relative, sorted. */
export function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => statSync(path.join(dir, file)).isFile())
    .sort();
}

/** Each file under `dir`: its path, size, modification time and content hash. */
export function fingerprintFiles(dir: string): string[] {
  return filesUnder(dir).map((file) => {
    const full = path.join(dir, file);
    const stats = statSync(full);
    const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
    return `${file} ${stats.size} ${stats.mtimeMs} ${hash}`;
  });
}

/**
 * What the adapter did so far, for a failure message (the CI log of a
 * Windows run is not public, its annotations are): how many outputs of
 * each type, the health last reported, and the `detection` log lines
 * (codes and counts only).
 */
export function diagnose(
  outputs: readonly AdapterOutput[],
  health?: AdapterHealth,
): string {
  const types = new Map<string, number>();
  for (const output of outputs) {
    types.set(output.type, (types.get(output.type) ?? 0) + 1);
  }
  // Only the console methods a test spied on have calls to read.
  const logged = [console.info, console.warn, console.error].flatMap((method) =>
    vi.isMockFunction(method)
      ? method.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('[detection]'))
      : [],
  );
  return [
    `platform ${process.platform}`,
    `health ${health ?? 'none'}`,
    `outputs ${JSON.stringify([...types])}`,
    `log ${JSON.stringify(logged)}`,
  ].join('; ');
}

/**
 * Starts `adapter` (with its real watcher) with a recheck timer of a few
 * milliseconds and waits for `sync.ready`; what it emitted, and its health
 * as last reported.
 */
export async function startReal<Adapter extends DetectionAdapter>(
  adapter: Adapter,
) {
  const outputs: AdapterOutput[] = [];
  const state = { health: undefined as AdapterHealth | undefined };
  const context: AdapterContext = {
    emit(batch, health) {
      outputs.push(...batch);
      if (health !== undefined) {
        state.health = health;
      }
    },
    timings: () => SETTINGS_DEFAULTS,
    wallNow: Date.now,
    setTimer: (run) => setTimeout(run, 20),
    clearTimer: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  adapter.start(context);
  await vi.waitFor(
    () => {
      expect(
        outputs.some((output) => output.type === 'sync.ready'),
        diagnose(outputs, state.health),
      ).toBe(true);
    },
    { timeout: REAL_WATCH_WAIT_MS, interval: 20 },
  );
  return { adapter, outputs, state };
}

/** Stops `adapter` and lets its watcher finish closing. */
export async function stopReal(adapter: { stop(): void }) {
  adapter.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/** Waits until an output matches `match`. */
export async function arrives(
  outputs: AdapterOutput[],
  match: (output: Exclude<AdapterOutput, { type: 'sync.ready' }>) => boolean,
) {
  await vi.waitFor(
    () => {
      expect(
        outputs.some((output) => output.type !== 'sync.ready' && match(output)),
        diagnose(outputs),
      ).toBe(true);
    },
    { timeout: REAL_WATCH_WAIT_MS, interval: 20 },
  );
}
