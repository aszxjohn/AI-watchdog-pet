/**
 * A pack that crashes (Story 3.9), in real Electron: the production build
 * (`.vite/`, from scripts/e2e-build.mjs) launched by Playwright's
 * `_electron` with a temporary HOME and userData. A synthetic Claude Code
 * session in that HOME gets a character of the probe pack at 1.0.0 (handed
 * over as a launch argument, imported once ready), whose `frame` leaves a
 * rejected promise unhandled every time (CRASHING_FRAME): each sandbox the
 * overlay builds for it faults at its first frame (`unhandled-rejection`).
 * main/packs answers the first PACK_RESTART_LIMIT failures with a rebuild
 * and the next one with none, marking 1.0.0 failed. With the probe pack
 * the only one, the pool is then empty: the session's actor is taken back
 * (the session stays listed), and the 角色包 page says why. Importing a
 * healthy 1.0.1 from that page (main's open dialog stubbed) takes the
 * note away and gives the session an actor again.
 *
 * Before waiting for the sandbox, recorders go into the overlay (the most
 * placeholders drawn at once: the failures go by too fast to poll) and the
 * panels (when the pack's row first shows without the failure note, and
 * when the note first shows). Panel buttons get a dispatched click: the
 * stage window lies over the panel, and macOS may throttle the panel's
 * rAF, which click()'s stability check waits on.
 *
 * One launch for the whole file (serial). The tests read the run log, the
 * recorders, the panels' StageView and the 角色包 page. Nothing is read
 * from the screen, and nothing connects anywhere but the app itself.
 */
import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPORT_BUTTON_LABEL,
  REPLACE_LABEL,
} from '../../src/panels/pack-import';
import { runtimeFailedText } from '../../src/panels/pack-list';
import {
  DRAW_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_TICKS,
  PACK_RESTART_LIMIT,
  TICK_HZ,
} from '../../src/shared/constants';
import type { SandboxFailureReason } from '../../src/shared/sandbox';
import {
  closeStage,
  CRASHING_FRAME,
  HEALTHY_FRAME,
  LAUNCH_TIMEOUT_MS,
  launchStage,
  linesSince,
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
  waitForLine,
  WINDOW_TIMEOUT_MS,
  windowAt,
  writeClaudeSession,
  writeProbePack,
  writtenSince,
  type E2eDirs,
  type RunLogLine,
  type SyntheticSession,
} from './helpers';

/** The crashing version, handed over at launch. */
const CRASH_VERSION = '1.0.0';

/** The healthy version imported from the 角色包 page. */
const FIXED_VERSION = '1.0.1';

/** Why each sandbox of CRASH_VERSION fails. */
const CRASH_REASON: SandboxFailureReason = 'unhandled-rejection';

/** How many times CRASH_VERSION's sandbox fails: until main stops it. */
const FAILURES = PACK_RESTART_LIMIT + 1;

/** How long the first sandbox may take to be ready once launched. */
const READY_TIMEOUT_MS = 90_000;

/** How long a sandbox built again may take to fail, or to be ready. */
const REBUILD_TIMEOUT_MS = 30_000;

/** The shortest wait for a 5th failure that is not to come. */
const MIN_QUIET_MS = 3_000;

/** HEARTBEAT_TIMEOUT_TICKS in ms. */
const HEARTBEAT_TIMEOUT_MS = (HEARTBEAT_TIMEOUT_TICKS * 1000) / TICK_HZ;

/**
 * How long a healthy sandbox is watched once ready: longer than a sandbox
 * answering no ping, or drawing nothing valid, would last.
 */
const HEALTHY_QUIET_MS =
  Math.max(HEARTBEAT_TIMEOUT_MS, DRAW_TIMEOUT_MS) + 2_000;

/** The 角色包 page's note on a pack marked failed (App.tsx). */
const RUNTIME_FAILED_NOTE = '.pack-runtime-failed';

/** A row of the 角色包 page's pack list (App.tsx). */
const PACK_ROW = '.pack-item';

/** The 角色包 page's replace confirmation (App.tsx). */
const PACK_CONFIRM = '.pack-confirm';

test.describe.configure({ mode: 'serial' });

let dirs: E2eDirs;
let session: SyntheticSession;
let app: ElectronApplication;
let overlay: Page;
let panels: Page;
/** main's line marking CRASH_VERSION failed (當掉 4 次). */
let marked: RunLogLine;

/**
 * Records, on the overlay page `page`, the most placeholders main.ts says
 * it drew at once (its body's `data-drawn-placeholders`), from now on
 * (the value now included), under `awpE2ePlaceholdersMax` on the page's
 * `window` (a test value, not the app's).
 */
async function recordPlaceholders(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => {
    const scope = globalThis as unknown as {
      document: { body: { dataset: Record<string, string | undefined> } };
      MutationObserver: new (callback: () => void) => {
        observe(
          target: unknown,
          options: { attributes: true; attributeFilter: string[] },
        ): void;
      };
      awpE2ePlaceholdersMax?: number;
    };
    let max = 0;
    const look = (): void => {
      const { drawnPlaceholders = '0' } = scope.document.body.dataset;
      const drawn = Number(drawnPlaceholders);
      if (Number.isFinite(drawn) && drawn > max) {
        max = drawn;
      }
      scope.awpE2ePlaceholdersMax = max;
    };
    look();
    const observer = new scope.MutationObserver(look);
    observer.observe(scope.document.body, {
      attributes: true,
      attributeFilter: ['data-drawn-placeholders'],
    });
  });
}

/** What recordPlaceholders has recorded on the overlay. */
function placeholdersMax(): Promise<number | null> {
  return overlay.evaluate(() => {
    const scope = globalThis as unknown as { awpE2ePlaceholdersMax?: number };
    return scope.awpE2ePlaceholdersMax ?? null;
  });
}

/** What recordPackNotes saw, in ms since the epoch by the page's clock. */
interface PackNotes {
  /** When a pack row first showed with no RUNTIME_FAILED_NOTE anywhere. */
  readonly rowAt: number | null;
  /** When RUNTIME_FAILED_NOTE first showed. */
  readonly noteAt: number | null;
}

/**
 * Records, on the panels page `page`, from now on (what it shows now
 * included), when a pack row first shows with no RUNTIME_FAILED_NOTE on
 * the page and when the note first shows, under `awpE2ePackNotes` on the
 * page's `window` (a test value, not the app's).
 */
async function recordPackNotes(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(
    ({ row, note }) => {
      const scope = globalThis as unknown as {
        document: {
          body: unknown;
          querySelector(selector: string): unknown;
        };
        MutationObserver: new (callback: () => void) => {
          observe(
            target: unknown,
            options: { childList: true; subtree: true },
          ): void;
        };
        awpE2ePackNotes?: { rowAt: number | null; noteAt: number | null };
      };
      const notes: { rowAt: number | null; noteAt: number | null } = {
        rowAt: null,
        noteAt: null,
      };
      scope.awpE2ePackNotes = notes;
      const look = (): void => {
        const now = Date.now();
        if (scope.document.querySelector(note) !== null) {
          notes.noteAt ??= now;
        } else if (scope.document.querySelector(row) !== null) {
          notes.rowAt ??= now;
        }
      };
      look();
      const observer = new scope.MutationObserver(look);
      observer.observe(scope.document.body, { childList: true, subtree: true });
    },
    { row: PACK_ROW, note: RUNTIME_FAILED_NOTE },
  );
}

/** What recordPackNotes has recorded on the panels. */
function packNotes(): Promise<PackNotes> {
  return panels.evaluate(() => {
    const scope = globalThis as unknown as { awpE2ePackNotes?: PackNotes };
    return scope.awpE2ePackNotes ?? { rowAt: null, noteAt: null };
  });
}

/**
 * Presses `button` once it is enabled, with a dispatched click (see the
 * file comment).
 */
async function press(button: Locator): Promise<void> {
  await expect(button).toBeEnabled();
  await button.dispatchEvent('click');
}

/**
 * Makes main's open dialog answer `file` at once, with no dialog shown;
 * throws if the stub did not take.
 */
async function stubOpenDialog(file: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    const stub = (): Promise<{ canceled: boolean; filePaths: string[] }> =>
      Promise.resolve({ canceled: false, filePaths: [chosen] });
    dialog.showOpenDialog = stub;
    if (dialog.showOpenDialog !== stub) {
      throw new Error('dialog.showOpenDialog could not be stubbed');
    }
  }, file);
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
    probeEntryWithFrame(CRASHING_FRAME),
    CRASH_VERSION,
  );
  app = await launchStage(dirs, awpet);
  overlay = await windowAt(app, 'app://overlay/');
  await recordPlaceholders(overlay);
  panels = await windowAt(app, 'app://panels/');
  await recordPackNotes(panels);
  await waitForLine(
    dirs.logs,
    probeLine('sandbox ready'),
    READY_TIMEOUT_MS,
    probeSandboxTrouble([CRASH_REASON]),
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
        path.join(test.info().project.outputDir, 'crash-run-log'),
        { recursive: true },
      );
    }
    removeDirs(dirs);
  }
});

test.describe('I/O matrix', () => {
  test('當掉 4 次: each sandbox of 1.0.0 fails with unhandled-rejection; main restarts it the first 3 times (restart N of 3) and at the 4th does not, marking the version failed; no 5th failure follows', async () => {
    // The failures, the wait for a 5th, and some room for the rest.
    test.setTimeout((FAILURES + 1) * REBUILD_TIMEOUT_MS + 30_000);
    marked = await waitForLine(
      dirs.logs,
      (line) => probeRuntimeAnswer(line)?.restart === false,
      FAILURES * REBUILD_TIMEOUT_MS,
      probeSandboxTrouble([CRASH_REASON]),
    );
    // A 5th sandbox would have failed by now: twice the longest time from
    // one failure to the next.
    const failedAt = readRunLog(dirs.logs)
      .filter((line) => probeFailureReason(line) !== undefined)
      .map((line) => line.at);
    const gaps = failedAt.slice(1).map((at, index) => at - failedAt[index]);
    const quiet = Math.max(MIN_QUIET_MS, 2 * Math.max(0, ...gaps));
    await pause(Math.min(quiet, REBUILD_TIMEOUT_MS));

    const lines = readRunLog(dirs.logs);
    const reasons = lines.flatMap((line) => probeFailureReason(line) ?? []);
    const answers = lines.flatMap((line) => probeRuntimeAnswer(line) ?? []);
    const versions = lines
      .filter(probeLine('sandbox ready'))
      .map((line) => parseReadyLine(line.message).version);
    expect(reasons).toStrictEqual(Array(FAILURES).fill(CRASH_REASON));
    expect(answers).toStrictEqual(restartAnswers(CRASH_VERSION, CRASH_REASON));
    expect(versions).toStrictEqual(Array(FAILURES).fill(CRASH_VERSION));
  });

  test('失敗期間: from the first failure on, the actor is drawn as the placeholder: the overlay drew 1 or more placeholders at once', async () => {
    expect(await placeholdersMax()).toBeGreaterThanOrEqual(1);
  });

  test('標記後: StageView has 1.0.0 marked unhandled-rejection, no actor, the session still listed; the 角色包 page shows runtimeFailedText for it, a note it did not show before the mark', async () => {
    const text = runtimeFailedText(CRASH_REASON);
    expect(text).not.toBeNull();

    await expect
      .poll(async () => probeState(await readStageView(panels)))
      .toStrictEqual({
        version: CRASH_VERSION,
        runtimeFailed: CRASH_REASON,
        actors: [],
        sessions: [session.sessionKey],
      });
    await expect(panels.locator(RUNTIME_FAILED_NOTE)).toHaveText(text ?? '');
    // Before the mark the pack's row showed with no note; the note came
    // with the mark, not before.
    const notes = await packNotes();
    expect(notes.rowAt).not.toBeNull();
    expect(notes.rowAt ?? Number.POSITIVE_INFINITY).toBeLessThan(marked.at);
    expect(notes.noteAt ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(
      marked.at,
    );
  });

  test('重新匯入: importing a healthy 1.0.1 from the 角色包 page (匯入角色包…, then 取代): the note goes, no runtimeFailed, the session has an actor again, 1.0.1 gets a sandbox ready, and none fails after', async () => {
    // The wait for the sandbox, the watch over it, and room for the
    // presses and the checks (each within the expect timeout).
    test.setTimeout(REBUILD_TIMEOUT_MS + HEALTHY_QUIET_MS + 60_000);
    const file = await writeProbePack(
      dirs.root,
      probeEntryWithFrame(HEALTHY_FRAME),
      FIXED_VERSION,
    );
    await stubOpenDialog(file);
    const importedAt = Date.now();
    await press(
      panels.getByRole('button', { name: IMPORT_BUTTON_LABEL, exact: true }),
    );
    await press(
      panels
        .locator(PACK_CONFIRM)
        .getByRole('button', { name: REPLACE_LABEL, exact: true }),
    );

    await waitForLine(
      dirs.logs,
      writtenSince(
        importedAt,
        (line) =>
          probeLine('sandbox ready')(line) &&
          parseReadyLine(line.message).version === FIXED_VERSION,
      ),
      REBUILD_TIMEOUT_MS,
      writtenSince(importedAt, probeSandboxTrouble()),
    );
    await pause(HEALTHY_QUIET_MS);

    const trouble = linesSince(dirs.logs, importedAt)
      .filter(probeSandboxTrouble())
      .map((line) => line.message);
    expect(trouble).toStrictEqual([]);
    expect(probeState(await readStageView(panels))).toStrictEqual({
      version: FIXED_VERSION,
      runtimeFailed: null,
      actors: [session.sessionKey],
      sessions: [session.sessionKey],
    });
    await expect(panels.locator(RUNTIME_FAILED_NOTE)).toHaveCount(0);
  });
});
