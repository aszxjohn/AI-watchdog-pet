/**
 * The canvas's stability (Story 3.6), in real Electron: the production
 * build (`.vite/`, from scripts/e2e-build.mjs) launched by Playwright's
 * `_electron` with a temporary HOME and userData. A synthetic Claude Code
 * session in that HOME gets a character of the contract test pack (under
 * another id), so the canvas draws it.
 *
 * - The WebGL context is lost and restored with the page's own WebGL API
 *   (`WEBGL_lose_context`), as a GPU reset would: once restored in time,
 *   and once not restored at all, which main answers by reloading the
 *   page.
 * - macOS only: the app is hidden with Electron's `app.hide()` on this
 *   test instance (as another app's 隱藏其他 or the Dock's 隱藏 would), and
 *   the windows' state is read from main: the canvas hides with the app
 *   (accepted, Story 3.6), and comes back once the app is shown again.
 *
 * The tests read the run log, the overlay's body data attributes and, for
 * hiding, main's windows. Nothing is read from the screen, and nothing
 * connects anywhere but the app itself.
 */
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  CANVAS_CONTEXT_RESTORE_MS,
  CANVAS_REBUILD_LIMIT,
} from '../../src/shared/constants';
import {
  contractManifest,
  contractPackFiles,
  itemsOf,
  manifestBytes,
  zipBuffer,
} from '../helpers/awpet';
import {
  closeStage,
  LAUNCH_TIMEOUT_MS,
  launchStage,
  makeDirs,
  readRunLog,
  removeDirs,
  waitForLine,
  WINDOW_TIMEOUT_MS,
  windowAt,
  writeClaudeSession,
  type E2eDirs,
  type RunLogLine,
} from './helpers';

/** The pack's id: no character or series name. */
const PACK_ID = 'stability-probe';

/** How long the pack's sandbox may take to be ready once launched. */
const READY_TIMEOUT_MS = 90_000;

/** How long a draw may take to show (again). */
const DRAWN_TIMEOUT_MS = 20_000;

/** Writes the contract test pack, under PACK_ID, to `<dir>/<id>.awpet`. */
async function writePack(dir: string): Promise<string> {
  const files: Map<string, Buffer | string> = contractPackFiles();
  const manifest = contractManifest();
  manifest.id = PACK_ID;
  manifest.name = 'Stability probe';
  files.set('manifest.json', manifestBytes(manifest));
  const file = path.join(dir, `${PACK_ID}.awpet`);
  fs.writeFileSync(file, await zipBuffer(itemsOf(files, PACK_ID)));
  return file;
}

/** A run log line of main/windows that is `message`, or starts with it. */
function windowsLine(message: string): (line: RunLogLine) => boolean {
  return (line) =>
    line.category === 'windows' && line.message.startsWith(message);
}

/** How many run log lines `match` takes now. */
function countLines(match: (line: RunLogLine) => boolean): number {
  return readRunLog(dirs.logs).filter(match).length;
}

/** A pack line (after `pack <id>: `) starting with `text`. */
function packLine(text: string): (line: RunLogLine) => boolean {
  const prefix = `pack ${PACK_ID}: ${text}`;
  return (line) => line.category === 'packs' && line.message.startsWith(prefix);
}

/** Whether `line` says the pack's sandbox failed or was never made. */
function packTrouble(line: RunLogLine): boolean {
  return (
    packLine('sandbox failed')(line) ||
    packLine('has an actor but gets no sandbox')(line)
  );
}

const LOST = windowsLine(
  'canvas WebGL context lost; nothing is drawn until it is restored',
);
const RESTORED = windowsLine('canvas WebGL context restored after ');
const RELOADED = windowsLine(
  `reloading the canvas page: its WebGL context was not restored within ${CANVAS_CONTEXT_RESTORE_MS / 1000} s`,
);
const CANVAS_READY = windowsLine('canvas ready (');
const SANDBOX_READY = packLine('sandbox ready');

test.describe.configure({ mode: 'serial' });

let dirs: E2eDirs;
let app: ElectronApplication;
let overlay: Page;

test.beforeAll(async () => {
  test.setTimeout(
    LAUNCH_TIMEOUT_MS + READY_TIMEOUT_MS + WINDOW_TIMEOUT_MS + 30_000,
  );
  dirs = makeDirs();
  writeClaudeSession(dirs.home);
  app = await launchStage(dirs, await writePack(dirs.root));
  await waitForLine(dirs.logs, SANDBOX_READY, READY_TIMEOUT_MS, packTrouble);
  overlay = await windowAt(app, 'app://overlay/');
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
        path.join(test.info().project.outputDir, 'stability-run-log'),
        { recursive: true },
      );
    }
    removeDirs(dirs);
  }
});

/**
 * The overlay body's data attributes; none while the page is between two
 * loads (a reload).
 */
async function overlayData(): Promise<Record<string, string | undefined>> {
  try {
    return await overlay.evaluate(() => {
      const { document } = globalThis as unknown as {
        document: { body: { dataset: Record<string, string | undefined> } };
      };
      return { ...document.body.dataset };
    });
  } catch {
    return {};
  }
}

/** Waits until the overlay draws the character and it takes the mouse. */
async function expectDrawn(): Promise<void> {
  await expect
    .poll(async () => (await overlayData()).drawnActors, {
      timeout: DRAWN_TIMEOUT_MS,
    })
    .toBe('1');
  await expect
    .poll(async () => Number((await overlayData()).drawnSprites), {
      timeout: DRAWN_TIMEOUT_MS,
    })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => (await overlayData()).hitAreas, {
      timeout: DRAWN_TIMEOUT_MS,
    })
    .toBe('1');
}

/**
 * Loses the canvas's WebGL context with the page's WebGL API, keeping the
 * extension on the page's `window` (a test value, not the app's) so that
 * restoreContext() can bring it back: once lost, the context no longer
 * hands out extensions.
 */
async function loseContext(): Promise<void> {
  await overlay.evaluate(() => {
    interface LoseContext {
      loseContext(): void;
      restoreContext(): void;
    }
    interface GlContext {
      getExtension(name: string): unknown;
    }
    const page = globalThis as unknown as {
      document: {
        querySelector(selector: string): {
          getContext(kind: string): GlContext | null;
        } | null;
      };
      awpE2eLoseContext?: LoseContext;
    };
    const canvas = page.document.querySelector('body > canvas');
    if (canvas === null) {
      throw new Error('no canvas');
    }
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const extension = gl?.getExtension('WEBGL_lose_context') as
      | LoseContext
      | null
      | undefined;
    if (extension === null || extension === undefined) {
      throw new Error('no WEBGL_lose_context');
    }
    page.awpE2eLoseContext = extension;
    extension.loseContext();
  });
}

/** Restores the context loseContext() lost. */
async function restoreContext(): Promise<void> {
  await overlay.evaluate(() => {
    const page = globalThis as unknown as {
      awpE2eLoseContext?: { restoreContext(): void };
    };
    page.awpE2eLoseContext?.restoreContext();
  });
}

test.describe('I/O matrix', () => {
  test('context lost 後還原: lost, nothing is drawn and main logs one line; restored, the character is drawn again and main logs one line; nothing is reloaded', async () => {
    await expectDrawn();
    expect((await overlayData()).context).toBe('ok');
    const readyBefore = countLines(CANVAS_READY);

    await loseContext();

    await waitForLine(dirs.logs, LOST, DRAWN_TIMEOUT_MS);
    await expect.poll(async () => (await overlayData()).context).toBe('lost');
    const lost = await overlayData();
    expect(lost.drawnActors).toBe('0');
    expect(lost.hitAreas).toBe('0');

    await restoreContext();

    await waitForLine(dirs.logs, RESTORED, DRAWN_TIMEOUT_MS);
    await expect.poll(async () => (await overlayData()).context).toBe('ok');
    await expectDrawn();
    expect(countLines(LOST)).toBe(1);
    expect(countLines(RESTORED)).toBe(1);
    expect(countLines(RELOADED)).toBe(0);
    expect(countLines(CANVAS_READY)).toBe(readyBefore);
  });

  test('context 沒還原: not restored within CANVAS_CONTEXT_RESTORE_MS, main reloads the canvas page with one line; the page reports canvas:ready again, its sandbox is made again and the character is drawn again', async () => {
    const readyBefore = countLines(CANVAS_READY);
    const sandboxesBefore = countLines(SANDBOX_READY);
    // The previous test's loss is already in the run log (1 line in a full
    // run): wait for a new one, not that one.
    const lostBefore = countLines(LOST);

    await loseContext();

    // Before main's wait is over, the page draws nothing.
    await expect.poll(async () => (await overlayData()).context).toBe('lost');
    expect((await overlayData()).drawnActors).toBe('0');
    expect(countLines(RELOADED)).toBe(0);
    await expect
      .poll(() => countLines(LOST), { timeout: DRAWN_TIMEOUT_MS })
      .toBe(lostBefore + 1);

    const reloaded = await waitForLine(
      dirs.logs,
      RELOADED,
      CANVAS_CONTEXT_RESTORE_MS + DRAWN_TIMEOUT_MS,
    );
    expect(reloaded.message).toBe(
      `reloading the canvas page: its WebGL context was not restored within ${CANVAS_CONTEXT_RESTORE_MS / 1000} s (recovery 1 of ${CANVAS_REBUILD_LIMIT} within 60 s, rebuilds and reloads count together)`,
    );
    await expect
      .poll(() => countLines(CANVAS_READY), { timeout: DRAWN_TIMEOUT_MS })
      .toBe(readyBefore + 1);
    await expect
      .poll(() => countLines(SANDBOX_READY), { timeout: READY_TIMEOUT_MS })
      .toBeGreaterThan(sandboxesBefore);
    await expectDrawn();
    expect((await overlayData()).context).toBe('ok');
    expect(countLines(RELOADED)).toBe(1);
    // A reload, not a rebuild: the same window, no renderer gone.
    expect(countLines(windowsLine('canvas renderer gone'))).toBe(0);
    expect(countLines(windowsLine('rebuilding the canvas window'))).toBe(0);
    expect(readRunLog(dirs.logs).filter(packTrouble)).toStrictEqual([]);
  });

  test('macOS 隱藏: accepted (Story 3.6 Decisions): the app hidden, the canvas hides with the panel and nothing brings it back on its own; nothing of the app has the focus; shown again, the character is there as before', async () => {
    test.skip(
      process.platform !== 'darwin',
      'hiding a whole app is macOS only',
    );
    const windowsState = () =>
      app.evaluate(({ app: electronApp, BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        const at = (prefix: string) =>
          windows.find((each) => each.webContents.getURL().startsWith(prefix));
        return {
          hidden: electronApp.isHidden(),
          canvasVisible: at('app://overlay/')?.isVisible() ?? null,
          panelVisible: at('app://panels/')?.isVisible() ?? null,
          focused: BrowserWindow.getFocusedWindow() !== null,
        };
      });
    // The panel the import opened is there, with the canvas.
    expect(await windowsState()).toMatchObject({
      canvasVisible: true,
      panelVisible: true,
    });

    await app.evaluate(({ app: electronApp }) => {
      electronApp.hide();
    });

    const HIDDEN = {
      hidden: true,
      canvasVisible: false,
      panelVisible: false,
      focused: false,
    };
    await expect
      .poll(windowsState, { timeout: DRAWN_TIMEOUT_MS })
      .toStrictEqual(HIDDEN);
    // And it stays so: the app does not show itself again (putting the
    // canvas back would show the panel too, measured).
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await windowsState()).toStrictEqual(HIDDEN);

    // Shown again (as the menu bar icon does), without focus: the canvas
    // is back with the character.
    await app.evaluate(({ app: electronApp }) => {
      electronApp.show();
    });
    await expect
      .poll(windowsState, { timeout: DRAWN_TIMEOUT_MS })
      .toMatchObject({ hidden: false, canvasVisible: true });
    await expectDrawn();
  });
});
