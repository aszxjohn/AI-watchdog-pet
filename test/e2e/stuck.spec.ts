/**
 * A pack that hangs (Story 3.9), in real Electron: the production build
 * (`.vite/`, from scripts/e2e-build.mjs) launched by Playwright's
 * `_electron` with a temporary HOME and userData. A synthetic Claude Code
 * session in that HOME gets a character of the probe pack (handed over as
 * a launch argument, imported once ready), whose `frame` never returns
 * (STUCK_FRAME): from its first frame the Worker answers no ping, and
 * pack-host fails the sandbox once HEARTBEAT_TIMEOUT_TICKS go by with no
 * pong (`heartbeat-timeout`). main/packs has it rebuilt PACK_RESTART_LIMIT
 * times, then marks the version failed; with the probe pack the only one,
 * the pool is then empty and the session's actor is taken back.
 *
 * pack-host takes a failed sandbox down by removing its iframe, which is
 * to end its Worker too, stuck in the pack's loop as it is (AD-7: no
 * `worker.terminate()`). The tests see the sandbox Workers through
 * Playwright (the overlay page's Workers include those of its child
 * frames; a sandbox's is made from a blob by an opaque-origin document, so
 * its url starts with `blob:null/`) and the CPU time of each of the app's
 * processes through `app.getAppMetrics()`, measured against itself: once
 * while a Worker is stuck (the control), then after the last one is gone
 * until the CPU has dropped. DevTools reports a Worker closed as soon as
 * its iframe goes, but Chromium ends one still running a script only some
 * time later (about 2 s on CI, both systems, 2026-11-27): the Worker before
 * the control's may still be running in it, and the CPU drops a while
 * after the last Worker is reported closed.
 *
 * One launch for the whole file (serial). The tests read the run log, the
 * panels' StageView, the overlay's Workers and main's process metrics.
 * Nothing is read from the screen, and nothing connects anywhere but the
 * app itself.
 */
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  type Worker,
} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  HEARTBEAT_TIMEOUT_TICKS,
  PACK_RESTART_LIMIT,
  TICK_HZ,
} from '../../src/shared/constants';
import type { SandboxFailureReason } from '../../src/shared/sandbox';
import {
  closeStage,
  LAUNCH_TIMEOUT_MS,
  launchStage,
  makeDirs,
  parseReadyLine,
  pause,
  probeEntryWithFrame,
  probeFailureReason,
  probeLine,
  probeRuntimeAnswer,
  probeSandboxTrouble,
  probeState,
  readRunLog,
  readStageView,
  removeDirs,
  restartAnswers,
  STUCK_FRAME,
  waitForLine,
  WINDOW_TIMEOUT_MS,
  windowAt,
  writeClaudeSession,
  writeProbePack,
  writtenSince,
  type E2eDirs,
  type SyntheticSession,
} from './helpers';

/** The probe pack's version, handed over at launch. */
const STUCK_VERSION = '1.0.0';

/** Why each sandbox of STUCK_VERSION fails. */
const STUCK_REASON: SandboxFailureReason = 'heartbeat-timeout';

/** How many times STUCK_VERSION's sandbox fails: until main stops it. */
const FAILURES = PACK_RESTART_LIMIT + 1;

/** How long the first sandbox may take to be ready once launched. */
const READY_TIMEOUT_MS = 90_000;

/** HEARTBEAT_TIMEOUT_TICKS in ms. */
const HEARTBEAT_TIMEOUT_MS = (HEARTBEAT_TIMEOUT_TICKS * 1000) / TICK_HZ;

/**
 * How long one sandbox may take from its failure to the next one's: built
 * again and ready, then stuck for HEARTBEAT_TIMEOUT_MS.
 */
const CYCLE_TIMEOUT_MS = HEARTBEAT_TIMEOUT_MS + 30_000;

/**
 * How long after a `sandbox ready` line the control starts: the sandbox's
 * first frame has come by then, and its Worker is stuck in it.
 */
const CONTROL_DELAY_MS = 300;

/**
 * How long each CPU measure lasts: the control's ends well before the
 * heartbeat times out.
 */
const CPU_SPAN_MS = 2_000;

/**
 * The least CPU use (CPU seconds a second) the control's busiest process is
 * to show: a Worker stuck in a loop keeps a core busy, about 1.
 */
const STUCK_RATE_MIN = 0.2;

/**
 * The most CPU use one stuck Worker can show: it is one thread. The control
 * may see two at once (the one before still ending, see the file comment).
 */
const ONE_WORKER_RATE_MAX = 1;

/** How long the overlay's sandbox Workers may take to close. */
const WORKER_CLOSE_TIMEOUT_MS = 15_000;

/**
 * How long the app's CPU may take to drop once the last sandbox Worker is
 * reported closed: well past the time Chromium takes to end a Worker still
 * running a script.
 */
const CPU_SETTLE_TIMEOUT_MS = 15_000;

/** How a sandbox Worker's url starts (src/sandbox/iframe.ts). */
const SANDBOX_WORKER_URL = 'blob:null/';

/** One process's CPU use over a measured span. */
interface ProcessCpu {
  readonly pid: number;
  /** Its ProcessMetric type (Browser, Tab, GPU, …). */
  readonly type: string;
  /** In CPU seconds a second: 1 is one core busy all along. */
  readonly rate: number;
}

/** The CPU use of the app's processes over a span. */
interface CpuSpan {
  /** Whether the rates come from cumulativeCPUUsage (else percentCPUUsage). */
  readonly cumulative: boolean;
  readonly processes: readonly ProcessCpu[];
}

test.describe.configure({ mode: 'serial' });

let dirs: E2eDirs;
let session: SyntheticSession;
let app: ElectronApplication;
let overlay: Page;
let panels: Page;
/** The sandbox Workers open when the control started (卡死). */
let controlWorkers: string[];
/** The control (卡死): the CPU use while a sandbox's Worker was stuck. */
let control: CpuSpan;

/** Every sandbox Worker the overlay has had. */
const sandboxWorkers = new Set<Worker>();

/** The sandbox Workers that have closed. */
const closedWorkers = new Set<Worker>();

/** Keeps track of `worker` when it is a sandbox's. */
function track(worker: Worker): void {
  if (
    worker.url().startsWith(SANDBOX_WORKER_URL) &&
    !sandboxWorkers.has(worker)
  ) {
    sandboxWorkers.add(worker);
    worker.on('close', () => {
      closedWorkers.add(worker);
    });
  }
}

/** The urls of the overlay's sandbox Workers open now. */
function openSandboxWorkers(): string[] {
  return overlay
    .workers()
    .map((worker) => worker.url())
    .filter((url) => url.startsWith(SANDBOX_WORKER_URL));
}

/**
 * The CPU use of each of the app's processes over the next `ms`, from
 * app.getAppMetrics() at the span's start and end: the difference of their
 * cumulativeCPUUsage over the span's seconds or, when a process has none,
 * each one's percentCPUUsage at the end / 100 (its average since the call
 * at the start; the app itself never calls it). A process there at only
 * one end is left out.
 */
function measureCpu(ms: number): Promise<CpuSpan> {
  return app.evaluate(async ({ app: electronApp }, spanMs) => {
    function key(metric: { pid: number; creationTime: number }): string {
      return `${metric.pid}@${metric.creationTime}`;
    }
    const before = electronApp.getAppMetrics();
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, spanMs));
    const after = electronApp.getAppMetrics();
    const seconds = (Date.now() - startedAt) / 1000;
    const all = [...before, ...after];
    const cumulative = all.every((m) => m.cpu.cumulativeCPUUsage !== undefined);
    const start = new Map(before.map((metric) => [key(metric), metric]));
    const processes = after.flatMap((metric) => {
      const first = start.get(key(metric));
      if (first === undefined) {
        return [];
      }
      const begin = first.cpu.cumulativeCPUUsage ?? 0;
      const end = metric.cpu.cumulativeCPUUsage ?? 0;
      const rate = cumulative
        ? (end - begin) / seconds
        : metric.cpu.percentCPUUsage / 100;
      return [{ pid: metric.pid, type: metric.type, rate }];
    });
    return { cumulative, processes };
  }, ms);
}

test.beforeAll(async () => {
  // Every wait below, and some room for the rest.
  test.setTimeout(
    LAUNCH_TIMEOUT_MS + READY_TIMEOUT_MS + 2 * WINDOW_TIMEOUT_MS + 30_000,
  );
  dirs = makeDirs();
  session = writeClaudeSession(dirs.home);
  const awpet = await writeProbePack(
    dirs.root,
    probeEntryWithFrame(STUCK_FRAME),
    STUCK_VERSION,
  );
  app = await launchStage(dirs, awpet);
  overlay = await windowAt(app, 'app://overlay/');
  overlay.on('worker', track);
  for (const worker of overlay.workers()) {
    track(worker);
  }
  panels = await windowAt(app, 'app://panels/');
  await waitForLine(
    dirs.logs,
    probeLine('sandbox ready'),
    READY_TIMEOUT_MS,
    probeSandboxTrouble([STUCK_REASON]),
  );
});

// The run log goes with the test results (CI uploads them when a test
// fails) before the temporary folders are removed.
test.afterAll(async () => {
  if (app !== undefined) {
    await closeStage(app);
  }
  if (dirs !== undefined) {
    if (fs.existsSync(dirs.logs)) {
      fs.cpSync(
        dirs.logs,
        path.join(test.info().project.outputDir, 'stuck-run-log'),
        { recursive: true },
      );
    }
    removeDirs(dirs);
  }
});

test.describe('I/O matrix', () => {
  test('卡死: every failure is heartbeat-timeout; after the first come a restart and a new sandbox ready; 4 failures in all, and the 4th marks the version failed', async () => {
    // Each failure, the control's measure, and some room for the rest.
    test.setTimeout((FAILURES + 1) * CYCLE_TIMEOUT_MS + CPU_SPAN_MS + 30_000);
    const trouble = probeSandboxTrouble([STUCK_REASON]);
    const restarted = await waitForLine(
      dirs.logs,
      (line) => probeRuntimeAnswer(line)?.count === 1,
      CYCLE_TIMEOUT_MS,
      trouble,
    );
    const rebuilt = await waitForLine(
      dirs.logs,
      writtenSince(restarted.at, probeLine('sandbox ready')),
      CYCLE_TIMEOUT_MS,
      trouble,
    );
    // The control: the rebuilt sandbox's Worker is stuck in its first
    // frame until the heartbeat times out, well after the measure ends
    // (the Worker before it may still be ending; see the file comment).
    await pause(Math.max(0, rebuilt.at + CONTROL_DELAY_MS - Date.now()));
    controlWorkers = openSandboxWorkers();
    control = await measureCpu(CPU_SPAN_MS);

    await waitForLine(
      dirs.logs,
      (line) => probeRuntimeAnswer(line)?.restart === false,
      PACK_RESTART_LIMIT * CYCLE_TIMEOUT_MS,
      trouble,
    );
    const lines = readRunLog(dirs.logs);
    const failed = lines.filter(
      (line) => probeFailureReason(line) !== undefined,
    );
    const answered = lines.filter(
      (line) => probeRuntimeAnswer(line) !== undefined,
    );
    const readies = lines.filter(probeLine('sandbox ready'));
    const reasons = failed.map((line) => probeFailureReason(line));
    const answers = answered.map((line) => probeRuntimeAnswer(line));
    const versions = readies.map(
      (line) => parseReadyLine(line.message).version,
    );
    expect(reasons).toStrictEqual(Array(FAILURES).fill(STUCK_REASON));
    expect(answers).toStrictEqual(restartAnswers(STUCK_VERSION, STUCK_REASON));
    expect(versions).toStrictEqual(Array(FAILURES).fill(STUCK_VERSION));
    // Each restart comes after its failure, and a new sandbox is ready
    // after the restart.
    for (let index = 0; index < PACK_RESTART_LIMIT; index += 1) {
      expect(answered[index].at).toBeGreaterThanOrEqual(failed[index].at);
      expect(readies[index + 1].at).toBeGreaterThanOrEqual(answered[index].at);
    }
    await expect
      .poll(async () => probeState(await readStageView(panels)))
      .toStrictEqual({
        version: STUCK_VERSION,
        runtimeFailed: STUCK_REASON,
        actors: [],
        sessions: [session.sessionKey],
      });
  });

  test('沒有殘留: with the 4th failure past and the actor taken back, every sandbox Worker the overlay had is closed, and the CPU drops: soon no process of the app uses half of what one stuck Worker did in the control', async () => {
    // The wait for the Workers, the measures, and some room for the rest.
    test.setTimeout(
      WORKER_CLOSE_TIMEOUT_MS + CPU_SETTLE_TIMEOUT_MS + CPU_SPAN_MS + 30_000,
    );
    // The control saw a sandbox Worker open and a process busy: there was
    // something to go.
    expect(controlWorkers.length).toBeGreaterThanOrEqual(1);
    const busiest = Math.max(0, ...control.processes.map((each) => each.rate));
    expect(busiest, `control: ${JSON.stringify(control)}`).toBeGreaterThan(
      STUCK_RATE_MIN,
    );
    expect(probeState(await readStageView(panels)).actors).toStrictEqual([]);

    await expect
      .poll(openSandboxWorkers, { timeout: WORKER_CLOSE_TIMEOUT_MS })
      .toStrictEqual([]);
    // One Worker for each sandbox built (src/sandbox/iframe.ts).
    expect(sandboxWorkers.size).toBe(FAILURES);
    const unclosed = [...sandboxWorkers]
      .filter((worker) => !closedWorkers.has(worker))
      .map((worker) => worker.url());
    expect(unclosed).toStrictEqual([]);

    // Measured again until no process is that busy, or the time is up.
    const threshold = Math.min(busiest, ONE_WORKER_RATE_MAX) / 2;
    const deadline = Date.now() + CPU_SETTLE_TIMEOUT_MS;
    const after: CpuSpan[] = [];
    let busy: readonly ProcessCpu[];
    do {
      const span = await measureCpu(CPU_SPAN_MS);
      after.push(span);
      busy = span.processes.filter((each) => each.rate >= threshold);
    } while (busy.length > 0 && Date.now() < deadline);
    // Every span in the message: whether a process busy after was busy in
    // the control too (a GPU process drawing in software, say) or a Worker
    // was left behind.
    const spans = `control: ${JSON.stringify(control)}; after: ${JSON.stringify(after)}`;
    expect(busy, spans).toStrictEqual([]);
    expect(
      after.map((span) => span.cumulative),
      spans,
    ).toStrictEqual(after.map(() => control.cumulative));
  });
});
