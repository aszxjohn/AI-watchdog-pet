/**
 * The sandbox security test (Story 3.5, AD-25), in real Electron: the
 * production build (`.vite/`, from scripts/e2e-build.mjs) launched by
 * Playwright's `_electron` with a temporary HOME and userData. A synthetic
 * Claude Code session in that HOME gets a character from the probe pack
 * (handed over as a launch argument, imported once ready), so the overlay
 * builds the probe's sandbox: `<iframe sandbox="allow-scripts">` →
 * classic Worker → SES Compartment. The probe tries every escape in its
 * factory and reports with `stage.log`; the tests read the run log, the
 * overlay's DOM and frames, and the sandbox document as main serves it.
 *
 * One launch for the whole file (serial): the tests follow the sandbox
 * from ready to destroyed. The tests that read what the probe's iframe
 * shows come first; 沙盒發出 navigates that iframe (webRequest cancels it),
 * and only tests that do not depend on its content follow. Nothing
 * connects anywhere but 127.0.0.1, and nothing touches the real HOME or
 * userData.
 */
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  REMOVED_WORKER_APIS,
  SES_UNKNOWN_INTRINSICS,
} from '../../src/sandbox/lists';
import {
  SANDBOX_CSP_FILE,
  SANDBOX_DOCUMENT_FILE,
  SANDBOX_IDLE_MS,
  STAGE_LOG_MAX_LENGTH,
  STAGE_LOG_RATE_LIMIT,
} from '../../src/shared/constants';
import type { PanelsApi } from '../../src/shared/preload-api';
import { SANDBOX_DOCUMENT_URL } from '../../src/shared/sandbox';
import type { StageViewSnapshot } from '../../src/shared/stage-view';
import {
  closeStage,
  ESCAPE_ATTEMPTS,
  LAUNCH_TIMEOUT_MS,
  launchStage,
  makeDirs,
  parseReadyLine,
  PROBE_PACK_ID,
  probeLine,
  probeSandboxTrouble,
  readProbeReport,
  readRunLog,
  removeDirs,
  ROOT,
  startProbeServer,
  waitForLine,
  WINDOW_TIMEOUT_MS,
  windowAt,
  writeClaudeSession,
  writeProbePack,
  type E2eDirs,
  type ProbeReportLines,
  type ProbeServer,
  type RunLogLine,
  type SyntheticSession,
} from './helpers';

/** The build files main serves the sandbox document from. */
const BUILD_DIR = path.join(ROOT, '.vite', 'build');

/** How long the probe's sandbox may take to be ready once launched. */
const READY_TIMEOUT_MS = 90_000;

/** A file of the probe pack, which main serves to anyone but a sandbox. */
const PROBE_FILE_URL = `pack://${PROBE_PACK_ID}/1.0.0/entry.js`;

/** The line webRequest logs when the probe's sandbox goes for it. */
const SANDBOX_BLOCKED_LINE = `request blocked: pack://${PROBE_PACK_ID}, made by a sandbox (later requests to it are blocked without a log line)`;

/** Every name of the two removal lists, as the bootstrap reports them. */
const REMOVAL_NAMES = [...REMOVED_WORKER_APIS, ...SES_UNKNOWN_INTRINSICS];

test.describe.configure({ mode: 'serial' });

let dirs: E2eDirs;
let server: ProbeServer;
let session: SyntheticSession;
let app: ElectronApplication;
let overlay: Page;
let panels: Page;
let ready: RunLogLine;

test.beforeAll(async () => {
  // Every wait below, and some room for the rest.
  test.setTimeout(
    LAUNCH_TIMEOUT_MS + READY_TIMEOUT_MS + 2 * WINDOW_TIMEOUT_MS + 30_000,
  );
  dirs = makeDirs();
  server = await startProbeServer();
  session = writeClaudeSession(dirs.home);
  const awpet = await writeProbePack(dirs.root, server);
  app = await launchStage(dirs, awpet);
  ready = await waitForLine(
    dirs.logs,
    probeLine('sandbox ready'),
    READY_TIMEOUT_MS,
    probeSandboxTrouble(),
  );
  overlay = await windowAt(app, 'app://overlay/');
  panels = await windowAt(app, 'app://panels/');
});

// The run log goes with the test results (CI uploads them when a test
// fails) before the temporary folders are removed.
test.afterAll(async () => {
  if (app !== undefined) {
    await closeStage(app);
  }
  await server?.close();
  if (dirs !== undefined) {
    if (fs.existsSync(dirs.logs)) {
      fs.cpSync(
        dirs.logs,
        path.join(test.info().project.outputDir, 'run-log'),
        {
          recursive: true,
        },
      );
    }
    removeDirs(dirs);
  }
});

/** The probe's report, put back together from its `stage.log` lines. */
function probeReport(): Promise<ProbeReportLines> {
  return readProbeReport(dirs.logs, 10_000);
}

/** The sandbox iframes in the overlay's DOM, as their attributes say. */
function overlayIframes(): Promise<
  { sandbox: string | null; src: string | null }[]
> {
  return overlay.evaluate(() => {
    // The page's own document (this file is typed without the DOM).
    const { document } = globalThis as unknown as {
      document: {
        querySelectorAll(selector: string): Iterable<{
          getAttribute(name: string): string | null;
        }>;
      };
    };
    return [...document.querySelectorAll('iframe')].map((iframe) => ({
      sandbox: iframe.getAttribute('sandbox'),
      src: iframe.getAttribute('src'),
    }));
  });
}

/** The StageView snapshot the panels see. */
function panelsSnapshot(): Promise<StageViewSnapshot> {
  return panels.evaluate(
    () =>
      new Promise<StageViewSnapshot>((resolve, reject) => {
        const { awp } = globalThis as unknown as { awp: PanelsApi };
        let done = false;
        let stop: (() => void) | undefined;
        const finish = (): void => {
          done = true;
          // After subscribe has returned, even if it called back at once.
          queueMicrotask(() => stop?.());
        };
        stop = awp.stageView.subscribe(
          (snapshot) => {
            if (!done) {
              finish();
              resolve(snapshot);
            }
          },
          (error) => {
            if (!done) {
              finish();
              reject(new Error(error.code));
            }
          },
        );
      }),
  );
}

test.describe('I/O matrix', () => {
  test('正向對照: the probe pack gets an actor and its sandbox is ready: every list entry removed or never there, 0 console lines, and the factory reports through stage.log', async () => {
    const parsed = parseReadyLine(ready.message);

    expect(parsed.version).toBe('1.0.0');
    expect(parsed.consoleLines).toBe(0);
    expect([...parsed.removals.keys()].sort()).toStrictEqual(
      [...REMOVAL_NAMES].sort(),
    );
    for (const name of REMOVAL_NAMES) {
      expect(['removed', 'absent'], name).toContain(parsed.removals.get(name));
    }

    const { report } = await probeReport();
    expect(report.probe).toBe('sandbox-escape');
    expect(report.ran).toBe(true);
    expect(report.sum).toBe(6);

    // The session that got the actor is the synthetic one.
    const { view } = await panelsSnapshot();
    expect(view.actors.map((actor) => actor.sessionKey)).toStrictEqual([
      session.sessionKey,
    ]);
    expect(view.actors[0]?.characterKey.startsWith(`${PROBE_PACK_ID}/`)).toBe(
      true,
    );
    const lines = readRunLog(dirs.logs);
    expect(
      lines.filter((line) =>
        line.message.startsWith(`pack ${PROBE_PACK_ID}: sandbox failed`),
      ),
    ).toStrictEqual([]);
  });

  test('逃逸失敗: fetch, XHR, WebSocket, EventSource, importScripts, a nested Worker, parent, top, indexedDB, Date.now, Math.random, OffscreenCanvas webgl, globals through a Function constructor, a dynamic import() and everything else section 10 of the author docs says a pack does not have all fail', async () => {
    const { report, texts } = await probeReport();

    // The report came whole: a few lines, none cut, within stage.log's limit.
    expect(texts.length).toBeLessThanOrEqual(STAGE_LOG_RATE_LIMIT);
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(STAGE_LOG_MAX_LENGTH);
      expect(text.endsWith('…')).toBe(false);
    }
    // Made the same way as the attempts, the control returns: an attempt
    // that got through would have been reported.
    expect(report.control).toBe('returned:number');
    expect(Object.keys(report.attempts)).toStrictEqual([...ESCAPE_ATTEMPTS]);
    const escaped = Object.entries(report.attempts).filter(
      ([, outcome]) => !outcome.startsWith('threw:'),
    );
    expect(escaped).toStrictEqual([]);
  });

  test('實際組出來的鏈: the overlay has exactly one sandbox="allow-scripts" iframe of pack://_stage/sandbox.html; its origin is null and reading parent throws', async () => {
    expect(await overlayIframes()).toStrictEqual([
      { sandbox: 'allow-scripts', src: SANDBOX_DOCUMENT_URL },
    ]);

    const frames = overlay
      .frames()
      .filter((frame) => frame.url() === SANDBOX_DOCUMENT_URL);
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (frame === undefined) {
      return;
    }
    expect(frame.parentFrame()).toBe(overlay.mainFrame());
    expect(
      await frame.evaluate(
        () => (globalThis as unknown as { origin: string }).origin,
      ),
    ).toBe('null');
    expect(
      await frame.evaluate(() => {
        const { parent } = globalThis as unknown as {
          parent: { document: unknown };
        };
        try {
          return `read ${typeof parent.document}`;
        } catch (error) {
          return `threw ${(error as Error).name}`;
        }
      }),
    ).toBe('threw SecurityError');
  });

  test('沙盒 CSP: pack://_stage/sandbox.html comes with the CSP the build wrote: sandbox allow-scripts, no frame-ancestors, and the sandbox still got ready', async () => {
    const built = JSON.parse(
      fs.readFileSync(path.join(BUILD_DIR, SANDBOX_CSP_FILE), 'utf8'),
    ) as { csp: string; sha256: string };
    const html = fs.readFileSync(
      path.join(BUILD_DIR, SANDBOX_DOCUMENT_FILE),
      'utf8',
    );

    const served = await app.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url);
      return {
        status: response.status,
        csp: response.headers.get('content-security-policy'),
        body: await response.text(),
      };
    }, SANDBOX_DOCUMENT_URL);

    expect(served.status).toBe(200);
    expect(served.csp).toBe(built.csp);
    expect(served.body).toBe(html);
    const directives = (served.csp ?? '')
      .split(';')
      .map((directive) => directive.trim());
    expect(directives).toContain('sandbox allow-scripts');
    expect(
      directives.filter((directive) => directive.startsWith('frame-ancestors')),
    ).toStrictEqual([]);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(createHash('sha256').update(script, 'utf8').digest('base64')).toBe(
      built.sha256,
    );
    expect(directives).toContain(
      `script-src 'sha256-${built.sha256}' 'unsafe-eval'`,
    );
    // Served with this CSP, the sandbox booted (the ready line of beforeAll).
    expect(parseReadyLine(ready.message).consoleLines).toBe(0);
  });

  test('沙盒 CSP: the CSP alone sandboxes the document: an iframe of pack://_stage/sandbox.html without a sandbox attribute still has a null origin, and reading parent throws', async () => {
    const name = 'awp-e2e-csp-only';
    await overlay.evaluate(
      ({ name: frameName, url }) =>
        new Promise<void>((resolve) => {
          // The page's own document (this file is typed without the DOM).
          const { document } = globalThis as unknown as {
            document: {
              createElement(tag: 'iframe'): {
                name: string;
                hidden: boolean;
                src: string;
                addEventListener(type: 'load', listener: () => void): void;
              };
              body: { append(node: unknown): void };
            };
          };
          const iframe = document.createElement('iframe');
          iframe.name = frameName;
          iframe.hidden = true;
          iframe.addEventListener('load', () => resolve());
          iframe.src = url;
          document.body.append(iframe);
        }),
      { name, url: SANDBOX_DOCUMENT_URL },
    );
    try {
      const frame = overlay.frames().find((each) => each.name() === name);
      expect(frame?.url()).toBe(SANDBOX_DOCUMENT_URL);
      expect(
        await overlay.evaluate(
          (frameName) =>
            (
              globalThis as unknown as {
                document: {
                  querySelector(selector: string): {
                    getAttribute(attribute: string): string | null;
                  } | null;
                };
              }
            ).document
              .querySelector(`iframe[name="${frameName}"]`)
              ?.getAttribute('sandbox'),
          name,
        ),
      ).toBeNull();
      expect(
        await frame?.evaluate(
          () => (globalThis as unknown as { origin: string }).origin,
        ),
      ).toBe('null');
      expect(
        await frame?.evaluate(() => {
          const { parent } = globalThis as unknown as {
            parent: { document: unknown };
          };
          try {
            return `read ${typeof parent.document}`;
          } catch (error) {
            return `threw ${(error as Error).name}`;
          }
        }),
      ).toBe('threw SecurityError');
    } finally {
      await overlay.evaluate((frameName) => {
        (
          globalThis as unknown as {
            document: {
              querySelector(selector: string): { remove(): void } | null;
            };
          }
        ).document
          .querySelector(`iframe[name="${frameName}"]`)
          ?.remove();
      }, name);
    }
    expect(await overlayIframes()).toStrictEqual([
      { sandbox: 'allow-scripts', src: SANDBOX_DOCUMENT_URL },
    ]);
  });

  // Breaks what the probe's iframe shows: the tests after it do not read it.
  test('沙盒發出: the sandbox navigating itself to a pack:// file is cancelled by webRequest (the overlay CSP and the navigation guard let it through), with one line saying a sandbox made it', async () => {
    // Anyone but a sandbox gets the file.
    const served = await app.evaluate(
      async ({ net }, url) => (await net.fetch(url)).status,
      PROBE_FILE_URL,
    );
    expect(served).toBe(200);

    const frame = overlay
      .frames()
      .find((each) => each.url() === SANDBOX_DOCUMENT_URL);
    expect(frame).toBeDefined();
    const startedAt = Date.now();
    await frame
      ?.evaluate((url) => {
        (
          globalThis as unknown as { location: { href: string } }
        ).location.href = url;
      }, PROBE_FILE_URL)
      .catch(() => {
        // The navigation may take the frame's context with it.
      });

    const blocked = await waitForLine(
      dirs.logs,
      (line) =>
        line.category === 'windows' &&
        line.message === SANDBOX_BLOCKED_LINE &&
        line.at >= startedAt,
      10_000,
    );
    expect(blocked.message).toBe(SANDBOX_BLOCKED_LINE);
    // The iframe pack-host made is still there; it never showed the file.
    expect(await overlayIframes()).toStrictEqual([
      { sandbox: 'allow-scripts', src: SANDBOX_DOCUMENT_URL },
    ]);
    expect(
      overlay.frames().filter((each) => each.url() === PROBE_FILE_URL),
    ).toStrictEqual([]);
  });

  test('閒置銷毀: released from the panels, the session lets its actor go; SANDBOX_IDLE_MS later the sandbox is destroyed and its iframe gone', async () => {
    test.setTimeout(SANDBOX_IDLE_MS + 60_000);
    const releasedAt = Date.now();
    const result = await panels.evaluate(
      (key) =>
        (globalThis as unknown as { awp: PanelsApi }).awp.pool.setReleased(
          key,
          true,
        ),
      session.sessionKey,
    );
    expect(result.ok).toBe(true);

    const destroyed = await waitForLine(
      dirs.logs,
      (line) => probeLine('sandbox destroyed')(line) && line.at >= releasedAt,
      SANDBOX_IDLE_MS + 30_000,
    );
    expect(destroyed.message).toBe(
      `pack ${PROBE_PACK_ID}: sandbox destroyed (no actor for ${SANDBOX_IDLE_MS} ms)`,
    );
    expect(destroyed.at - releasedAt).toBeGreaterThanOrEqual(
      SANDBOX_IDLE_MS - 1_000,
    );
    await expect.poll(overlayIframes).toStrictEqual([]);
    expect(
      overlay.frames().filter((frame) => frame.url() === SANDBOX_DOCUMENT_URL),
    ).toStrictEqual([]);
  });

  test('隔離: the app ran on the temporary HOME and userData only, and nothing reached the 127.0.0.1 server or tried to leave', async () => {
    const paths = await app.evaluate(({ app: electronApp }) => ({
      userData: electronApp.getPath('userData'),
      home: process.env.HOME ?? null,
      userProfile: process.env.USERPROFILE ?? null,
    }));
    expect(fs.realpathSync(paths.userData)).toBe(dirs.userData);
    expect(paths.home).toBe(dirs.home);
    expect(paths.userProfile).toBe(dirs.home);
    expect(fs.existsSync(dirs.logs)).toBe(true);

    // Detection read the temporary HOME: the synthetic session is the only one.
    const { view } = await panelsSnapshot();
    expect(view.sessions.map((entry) => entry.sessionKey)).toStrictEqual([
      session.sessionKey,
    ]);

    // Nothing reached the probe server, and the only request cancelled is
    // the one 沙盒發出 made the sandbox send: nothing tried to leave.
    expect(server.hits).toStrictEqual([]);
    const blocked = readRunLog(dirs.logs)
      .filter(
        (line) =>
          line.category === 'windows' &&
          line.message.startsWith('request blocked: '),
      )
      .map((line) => line.message);
    expect(blocked).toStrictEqual([SANDBOX_BLOCKED_LINE]);
  });
});
