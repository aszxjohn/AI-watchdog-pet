/**
 * What the end-to-end tests (Story 3.5) need around the app: a temporary
 * HOME and userData, a synthetic Claude Code session in that HOME, the
 * sandbox probe pack (from Story 3.9 also at another version, with an
 * entry that crashes or hangs), a 127.0.0.1 server the probe aims at,
 * launching the production build (`.vite/`, from scripts/e2e-build.mjs)
 * with Playwright's `_electron`, and reading the run log (from Story 3.9
 * also what it says of a sandbox's failures and main's answers).
 *
 * Nothing here touches the real HOME or userData, and nothing connects
 * anywhere but 127.0.0.1.
 */
import {
  _electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  PACK_RESTART_LIMIT,
  STAGE_LOG_MAX_LENGTH,
} from '../../src/shared/constants';
import type { PanelsApi } from '../../src/shared/preload-api';
import type { SandboxFailureReason } from '../../src/shared/sandbox';
import type { StageViewSnapshot } from '../../src/shared/stage-view';
import {
  contractManifest,
  contractPackFiles,
  itemsOf,
  manifestBytes,
  zipBuffer,
} from '../helpers/awpet';

/**
 * The repo root. `__dirname`, not `import.meta`: Playwright loads the e2e
 * files as CommonJS (the package is not `type: module`).
 */
export const ROOT = path.resolve(__dirname, '..', '..');

/** The probe pack's id: no character or series name. */
export const PROBE_PACK_ID = 'sandbox-probe';

/** The folders of one run, all under one temporary root. */
export interface E2eDirs {
  readonly root: string;
  /** HOME and USERPROFILE of the app. */
  readonly home: string;
  /** `--user-data-dir`. */
  readonly userData: string;
  /** The run log folder inside userData. */
  readonly logs: string;
}

/** Makes the temporary folders of one run. */
export function makeDirs(): E2eDirs {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'awp-e2e-')),
  );
  const home = path.join(root, 'home');
  const userData = path.join(root, 'user-data');
  fs.mkdirSync(home);
  fs.mkdirSync(userData);
  return { root, home, userData, logs: path.join(userData, 'logs') };
}

/**
 * Removes the folders of a run, retrying for a few seconds: on Windows the
 * app's helper processes can hold a file for a moment after it quits.
 */
export function removeDirs(dirs: E2eDirs): void {
  fs.rmSync(dirs.root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 500,
  });
}

/** A synthetic Claude Code session. */
export interface SyntheticSession {
  readonly sessionId: string;
  /** Its key as main/detection makes it. */
  readonly sessionKey: `claude-code:${string}`;
}

/** The folder of the synthetic sessions' transcripts in `home`. */
function claudeProjectFolder(home: string): string {
  return path.join(home, '.claude', 'projects', '-e2e-project');
}

/** A synthetic transcript record of `type`, timestamped now. */
function claudeRecord(
  home: string,
  sessionId: string,
  type: 'user' | 'assistant',
  message: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type,
    uuid: randomUUID(),
    sessionId,
    cwd: path.join(home, 'e2e-project'),
    timestamp: new Date().toISOString(),
    message,
  };
}

/**
 * Writes `<home>/.claude/projects/<folder>/<uuid>.jsonl` with one `user`
 * record timestamped now, written here (no real transcript): the Claude
 * Code adapter replays it at start, so the session is shown and gets a
 * character.
 */
export function writeClaudeSession(home: string): SyntheticSession {
  const sessionId = randomUUID();
  const folder = claudeProjectFolder(home);
  fs.mkdirSync(folder, { recursive: true });
  const record = claudeRecord(home, sessionId, 'user', {
    role: 'user',
    content: 'e2e sandbox check',
  });
  fs.writeFileSync(
    path.join(folder, `${sessionId}.jsonl`),
    `${JSON.stringify(record)}\n`,
  );
  return { sessionId, sessionKey: `claude-code:${sessionId}` };
}

/**
 * What a synthetic session can be made to do next, as the Claude Code
 * adapter reads it (Story 2.4): `prompt`, a user prompt (a turn starts:
 * thinking); `answer`, an assistant answer that ends the turn (done);
 * `error`, an API error Claude Code writes as an assistant record
 * (`isApiErrorMessage`, `stop_reason: 'stop_sequence'`): `error` and the
 * turn's end, so error (it goes before done) for `errorHoldMs`.
 */
export type SyntheticTurn = 'prompt' | 'answer' | 'error';

/** The transcript record of `turn` for `session`, timestamped now. */
function turnRecord(
  home: string,
  session: SyntheticSession,
  turn: SyntheticTurn,
): Record<string, unknown> {
  switch (turn) {
    case 'prompt':
      return claudeRecord(home, session.sessionId, 'user', {
        role: 'user',
        content: 'e2e prompt',
      });
    case 'answer':
      return claudeRecord(home, session.sessionId, 'assistant', {
        role: 'assistant',
        content: [{ type: 'text', text: 'e2e answer' }],
        stop_reason: 'end_turn',
      });
    case 'error':
      return {
        ...claudeRecord(home, session.sessionId, 'assistant', {
          role: 'assistant',
          content: [{ type: 'text', text: 'e2e API error' }],
          stop_reason: 'stop_sequence',
        }),
        isApiErrorMessage: true,
      };
  }
}

/**
 * Appends one record timestamped now to `session`'s transcript in `home`
 * (written here, no real transcript); the running adapter reads it.
 */
export function appendClaudeRecord(
  home: string,
  session: SyntheticSession,
  turn: SyntheticTurn,
): void {
  const record = turnRecord(home, session, turn);
  fs.appendFileSync(
    path.join(claudeProjectFolder(home), `${session.sessionId}.jsonl`),
    `${JSON.stringify(record)}\n`,
  );
}

/** The 127.0.0.1 server the probe's network attempts aim at. */
export interface ProbeServer {
  readonly httpUrl: string;
  readonly wsUrl: string;
  /** Every request and upgrade it got (method and path). */
  readonly hits: readonly string[];
  close(): Promise<void>;
}

/** Starts a server on 127.0.0.1 that records whatever reaches it. */
export async function startProbeServer(): Promise<ProbeServer> {
  const hits: string[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    hits.push(`${request.method ?? '?'} ${request.url ?? ''}`);
    response.setHeader('access-control-allow-origin', '*');
    response.end('reached');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket) => {
    hits.push(`UPGRADE ${request.url ?? ''}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

/**
 * The escape attempts the probe makes in its factory, each the body of a
 * function: returning at all counts as an escape, throwing as blocked.
 * `HTTP` and `WS` are the probe server's URLs.
 */
const ATTEMPTS: Readonly<Record<string, string>> = Object.freeze({
  // The spec's list (I/O matrix, 逃逸失敗).
  fetch: "return fetch(HTTP + '/fetch');",
  xhr: "var request = new XMLHttpRequest(); request.open('GET', HTTP + '/xhr'); request.send(); return request;",
  webSocket: "return new WebSocket(WS + '/ws');",
  eventSource: "return new EventSource(HTTP + '/sse');",
  importScripts: "return importScripts(HTTP + '/import.js');",
  nestedWorker: "return new Worker(HTTP + '/worker.js');",
  parent: "return parent.postMessage('escape', '*');",
  top: "return top.postMessage('escape', '*');",
  indexedDB: "return indexedDB.open('escape');",
  dateNow: 'return Date.now();',
  mathRandom: 'return Math.random();',
  offscreenWebgl: "return new OffscreenCanvas(1, 1).getContext('webgl');",
  // The Compartment's own Function constructor: its globalThis, or this.
  functionGlobal:
    "return hostGlobals([Function('return globalThis')(), Function('return this')()]);",
  // The Worker realm's Function constructor, reached through stage.
  stageFunctionGlobal:
    "return hostGlobals([stage.log.constructor('return globalThis')(), stage.log.constructor('return this')()]);",
  // A dynamic import() put together from strings, through the Function
  // constructor (the entry itself may not spell it).
  dynamicImport:
    "return Function('return imp' + 'ort(' + JSON.stringify(HTTP + '/import.mjs') + ')')();",
  // Everything else docs/pack-api-v1.md section 10 says a pack does not
  // have: host APIs, what SES removes or tames, the removed lists.
  performanceNow: 'return performance.now();',
  cryptoGetRandomValues: 'return crypto.getRandomValues(new Uint8Array(1));',
  cryptoSubtle: "return crypto.subtle.digest('SHA-256', new Uint8Array(1));",
  intl: "return new Intl.DateTimeFormat('en').format(0);",
  self: "return self.postMessage('escape');",
  postMessage: "return postMessage('escape');",
  navigator: 'return navigator.userAgent;',
  location: 'return location.href;',
  sharedArrayBuffer: 'return new SharedArrayBuffer(8);',
  atomics: 'return Atomics.add(new Int32Array(1), 0, 1);',
  weakRef: 'return new WeakRef({});',
  finalizationRegistry: 'return new FinalizationRegistry(function () {});',
  newDate: 'return new Date();',
  dateCall: 'return Date();',
  console: "return console.log('escape');",
  setTimeout: 'return setTimeout(function () {}, 0);',
  setInterval: 'return setInterval(function () {}, 1000);',
  requestAnimationFrame: 'return requestAnimationFrame(function () {});',
  queueMicrotask: 'return queueMicrotask(function () {});',
  float16Array: 'return new Float16Array(1);',
  float32Array: 'return new Float32Array(1);',
  float64Array: 'return new Float64Array(1);',
  iteratorJoin: "return [1, 2].values().join(',');",
  iteratorIncludes: 'return [1, 2].values().includes(1);',
  webTransport: "return new WebTransport(HTTP + '/wt');",
  sharedWorker: "return new SharedWorker(HTTP + '/shared.js');",
  caches: "return caches.open('escape');",
});

/** The names of the escape attempts, in the order the probe makes them. */
export const ESCAPE_ATTEMPTS: readonly string[] = Object.freeze(
  Object.keys(ATTEMPTS),
);

/**
 * The control: plain code that runs in any Compartment, made the same way
 * as the attempts. It returning shows a returning attempt would be seen.
 */
const CONTROL = 'return [1, 2, 3].length;';

/** What the probe reports with `stage.log`, as JSON. */
export interface ProbeReport {
  readonly probe: 'sandbox-escape';
  readonly ran: true;
  /** `[1, 2, 3]` summed in the Compartment: 6. */
  readonly sum: number;
  /** The control's outcome: `returned:number`. */
  readonly control: string;
  /**
   * Each attempt's outcome: `threw:<error name>` (blocked) or
   * `returned:<what it returned>` (escaped).
   */
  readonly attempts: Readonly<Record<string, string>>;
}

/** What starts each part of the report: `awp-probe <part>/<parts> `. */
export const PROBE_PART_PREFIX = 'awp-probe ';

/**
 * How much of the report's JSON one `stage.log` line carries: with its
 * prefix, well under STAGE_LOG_MAX_LENGTH, so no line is ever cut.
 */
const PROBE_PART_LENGTH = STAGE_LOG_MAX_LENGTH - 100;

/**
 * The probe's entry: a classic script whose value is the factory. In the
 * factory it makes every attempt, each in its own try/catch, and reports
 * them all as JSON: every character outside printable ASCII written as a
 * `\uXXXX` escape (so no step on the way escapes or cuts anything), split
 * into parts of PROBE_PART_LENGTH, one `stage.log` line each, `awp-probe
 * <part>/<parts> <text>`. A few lines, well within the 20 lines per 10
 * seconds `stage.log` allows. ASCII only, no `import(`, `eval(` or
 * `require(`, so the import check takes it.
 */
export function probeEntrySource(server: ProbeServer): string {
  const attempts = Object.entries(ATTEMPTS)
    .map(([name, body]) => `    ${name}: function () { ${body} },`)
    .join('\n');
  return `(function (stage) {
  'use strict';
  var HTTP = ${JSON.stringify(server.httpUrl)};
  var WS = ${JSON.stringify(server.wsUrl)};
  var HOST = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'indexedDB', 'OffscreenCanvas', 'postMessage', 'self', 'parent', 'top', 'console', 'setTimeout', 'navigator', 'location'];
  function hostGlobals(candidates) {
    var found = [];
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      if (candidate === null || candidate === undefined) { continue; }
      for (var j = 0; j < HOST.length; j += 1) {
        if (typeof candidate[HOST[j]] !== 'undefined') { found.push(HOST[j]); }
      }
    }
    if (found.length === 0) { throw new TypeError('no host global reached'); }
    return found.join(',');
  }
  function attempt(run) {
    try {
      var value = run();
      return 'returned:' + (typeof value === 'string' ? value.slice(0, 60) : typeof value);
    } catch (error) {
      var kind = 'unknown';
      try { kind = String(error && error.name); } catch (ignored) { kind = 'unreadable'; }
      return 'threw:' + kind;
    }
  }
  var attempts = {
${attempts}
  };
  var results = {};
  var names = Object.keys(attempts);
  for (var k = 0; k < names.length; k += 1) {
    results[names[k]] = attempt(attempts[names[k]]);
  }
  var json = JSON.stringify({
    probe: 'sandbox-escape',
    ran: true,
    sum: [1, 2, 3].reduce(function (a, b) { return a + b; }, 0),
    control: attempt(function () { ${CONTROL} }),
    attempts: results
  }).replace(/[^\\x20-\\x7e]/g, function (c) {
    return '\\\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
  var parts = Math.ceil(json.length / ${PROBE_PART_LENGTH});
  for (var p = 0; p < parts; p += 1) {
    stage.log(${JSON.stringify(PROBE_PART_PREFIX)} + (p + 1) + '/' + parts + ' ' + json.slice(p * ${PROBE_PART_LENGTH}, (p + 1) * ${PROBE_PART_LENGTH}));
  }
${probeHandlers(HEALTHY_FRAME)}
})
`;
}

/** A `frame` handler that answers each frame with an empty (valid) draw. */
export const HEALTHY_FRAME = 'function () { return {}; }';

/**
 * A `frame` handler that leaves a rejected promise unhandled every time and
 * answers with no draw: the sandbox faults (`unhandled-rejection`) at its
 * first frame, a rebuilt one too. (A `frame` that throws is answered with
 * `sandbox.no-draw`, which is no valid draw: that sandbox fails only after
 * DRAW_TIMEOUT_MS, as `draw-timeout`.)
 */
export const CRASHING_FRAME =
  "function () { Promise.reject(new Error('awp-crash')); }";

/**
 * A `frame` handler that never returns: from its first frame the Worker
 * answers no ping (`heartbeat-timeout`) and keeps a CPU core busy.
 */
export const STUCK_FRAME = 'function () { while (true) {} }';

/** The end of a probe entry: handlers that do nothing, but `frame`. */
function probeHandlers(frame: string): string {
  return `  return {
    init: function () {},
    spawn: function () {},
    despawn: function () {},
    params: function () {},
    meta: function () {},
    frame: ${frame}
  };`;
}

/**
 * A probe entry that tries nothing and reports nothing: its factory only
 * returns the handlers, with `frame` (a function expression's source,
 * HEALTHY_FRAME, CRASHING_FRAME or STUCK_FRAME) as the `frame` handler.
 * ASCII only, no `import(`, `eval(` or `require(`, so the import check
 * takes it.
 */
export function probeEntryWithFrame(frame: string): string {
  return `(function () {
  'use strict';
${probeHandlers(frame)}
})
`;
}

/**
 * Writes the probe pack at `version` to
 * `<dir>/sandbox-probe-<version>.awpet`: the contract test pack
 * (test/helpers/awpet.ts) under the probe's id and that version. Its entry
 * is `entry`: the escape probe aimed at a probe server (probeEntrySource),
 * or an entry's source (probeEntryWithFrame).
 */
export async function writeProbePack(
  dir: string,
  entry: ProbeServer | string,
  version = '1.0.0',
): Promise<string> {
  const files: Map<string, Buffer | string> = contractPackFiles();
  const manifest = contractManifest();
  manifest.id = PROBE_PACK_ID;
  manifest.name = 'Sandbox probe';
  manifest.version = version;
  files.set('manifest.json', manifestBytes(manifest));
  files.set(
    String(manifest.entry),
    typeof entry === 'string' ? entry : probeEntrySource(entry),
  );
  const file = path.join(dir, `${PROBE_PACK_ID}-${version}.awpet`);
  fs.writeFileSync(file, await zipBuffer(itemsOf(files, PROBE_PACK_ID)));
  return file;
}

/** How long launching the app may take. */
export const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * Launches the production build in `.vite/` (`electron .`) with the
 * run's userData, HOME and USERPROFILE, and `awpet` as a launch argument
 * (the app imports it once ready).
 */
export async function launchStage(
  dirs: E2eDirs,
  awpet: string,
): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') {
      env[name] = value;
    }
  }
  env.HOME = dirs.home;
  env.USERPROFILE = dirs.home;
  return _electron.launch({
    args: ['.', `--user-data-dir=${dirs.userData}`, awpet],
    cwd: ROOT,
    env,
    timeout: LAUNCH_TIMEOUT_MS,
  });
}

/** Closes the app; kills it if it has not quit within a few seconds. */
export async function closeStage(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const quit = app.close().catch(() => {});
  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), 15_000).unref();
  });
  if ((await Promise.race([quit, timeout])) === 'timeout') {
    child.kill();
  }
}

/** How long windowAt waits for a window. */
export const WINDOW_TIMEOUT_MS = 30_000;

/** The app's window showing `prefix` (`app://overlay/`), once it has one. */
export async function windowAt(
  app: ElectronApplication,
  prefix: string,
  timeoutMs = WINDOW_TIMEOUT_MS,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = app
      .windows()
      .find((window) => window.url().startsWith(prefix));
    if (page !== undefined) {
      return page;
    }
    if (Date.now() > deadline) {
      throw new Error(`no window at ${prefix} within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The StageView snapshot the panels window (`panels`) sees. */
export function readStageView(panels: Page): Promise<StageViewSnapshot> {
  return panels.evaluate(
    () =>
      new Promise<StageViewSnapshot>((resolve, reject) => {
        const { awp } = globalThis as unknown as { awp: PanelsApi };
        let done = false;
        let stop: (() => void) | undefined;
        const finish = (): void => {
          done = true;
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

/** What a StageView snapshot says of the probe pack and the sessions. */
export interface ProbeState {
  /** The probe pack's version installed; null when it is not. */
  readonly version: string | null;
  /** Why that version is marked failed this run; null when it is not. */
  readonly runtimeFailed: string | null;
  /** The session of each actor. */
  readonly actors: readonly string[];
  readonly sessions: readonly string[];
}

/** The ProbeState of `snapshot`. */
export function probeState({ view }: StageViewSnapshot): ProbeState {
  const pack = view.packs.installed.find((each) => each.id === PROBE_PACK_ID);
  return {
    version: pack?.version ?? null,
    runtimeFailed: pack?.runtimeFailed ?? null,
    actors: view.actors.map((actor) => actor.sessionKey),
    sessions: view.sessions.map((entry) => entry.sessionKey),
  };
}

/**
 * The overlay window's (`overlay`) body data attributes: what main.ts says
 * was last drawn, for DevTools and these tests.
 */
export function readOverlayData(
  overlay: Page,
): Promise<Record<string, string | undefined>> {
  return overlay.evaluate(() => {
    const { document } = globalThis as unknown as {
      document: { body: { dataset: Record<string, string | undefined> } };
    };
    return { ...document.body.dataset };
  });
}

/**
 * Loses the overlay canvas's WebGL context with the page's WebGL API (as a
 * GPU reset would), keeping the extension on the page's `window` (a test
 * value, not the app's) so that restoreOverlayContext() can bring it back:
 * once lost, the context no longer hands out extensions.
 */
export async function loseOverlayContext(overlay: Page): Promise<void> {
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

/**
 * Restores the context loseOverlayContext() lost, and forgets the
 * extension it kept. Throws when there is none (it was not called on this
 * page, the page was reloaded since, or this restored it already), so a
 * test does not wait in vain for a restore.
 */
export async function restoreOverlayContext(overlay: Page): Promise<void> {
  await overlay.evaluate(() => {
    const page = globalThis as unknown as {
      awpE2eLoseContext?: { restoreContext(): void };
    };
    const extension = page.awpE2eLoseContext;
    if (extension === undefined) {
      throw new Error(
        'no WEBGL_lose_context kept: call loseOverlayContext first',
      );
    }
    extension.restoreContext();
    delete page.awpE2eLoseContext;
  });
}

/** One run log line. */
export interface RunLogLine {
  /** When it was written, in ms since the epoch. */
  readonly at: number;
  readonly category: string;
  readonly message: string;
}

/**
 * Every line of the run log in `logs`: one file per local hour, so all of
 * them, in name (= time) order. None yet is an empty list.
 */
export function readRunLog(logs: string): RunLogLine[] {
  let names: string[];
  try {
    names = fs.readdirSync(logs).filter((name) => name.endsWith('.log'));
  } catch {
    return [];
  }
  return names.sort().flatMap((name) =>
    fs
      .readFileSync(path.join(logs, name), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [at = '', category = '', ...message] = line.split('\t');
        return { at: Date.parse(at), category, message: message.join('\t') };
      }),
  );
}

/**
 * The first run log line `match` takes, waiting up to `timeoutMs` for one.
 * A line `failOn` takes ends the wait at once, with that line's text.
 */
export async function waitForLine(
  logs: string,
  match: (line: RunLogLine) => boolean,
  timeoutMs: number,
  failOn: (line: RunLogLine) => boolean = () => false,
): Promise<RunLogLine> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = readRunLog(logs);
    const line = lines.find(match);
    if (line !== undefined) {
      return line;
    }
    const failed = lines.find(failOn);
    if (failed !== undefined) {
      throw new Error(`run log: ${failed.message}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`no matching run log line within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A run log line of the probe pack starting with `text` (after `pack <id>: `). */
export function probeLine(text: string): (line: RunLogLine) => boolean {
  const prefix = `pack ${PROBE_PACK_ID}: ${text}`;
  return (line) => line.category === 'packs' && line.message.startsWith(prefix);
}

/** The run log lines written at or after `since` (ms since the epoch). */
export function linesSince(logs: string, since: number): RunLogLine[] {
  return readRunLog(logs).filter((line) => line.at >= since);
}

/** `match`, for lines written at or after `since` (ms since the epoch) only. */
export function writtenSince(
  since: number,
  match: (line: RunLogLine) => boolean,
): (line: RunLogLine) => boolean {
  return (line) => line.at >= since && match(line);
}

/** Waits `ms`. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FAILED = new RegExp(
  `^pack ${PROBE_PACK_ID}: sandbox failed \\(([^)]+)\\)`,
);

/**
 * Why a `sandbox failed` line of the probe pack (main/packs/sandbox-log.ts)
 * says its sandbox failed; undefined for any other line.
 */
export function probeFailureReason(line: RunLogLine): string | undefined {
  if (line.category !== 'packs') {
    return undefined;
  }
  return FAILED.exec(line.message)?.[1];
}

/**
 * A test of whether a run log line says the probe pack's sandbox failed or
 * was never made: any failure, but one for a reason in `expected` (what
 * the test makes the probe do).
 */
export function probeSandboxTrouble(
  expected: readonly SandboxFailureReason[] = [],
): (line: RunLogLine) => boolean {
  const allowed: readonly string[] = expected;
  return (line) => {
    if (probeLine('sandbox failed')(line)) {
      const reason = probeFailureReason(line);
      return reason === undefined || !allowed.includes(reason);
    }
    return probeLine('has an actor but gets no sandbox')(line);
  };
}

/**
 * What main/packs answered one failure of the probe pack's sandbox
 * (main/packs/runtime-failures.ts), as its run log line says.
 */
export interface RuntimeAnswer {
  /** `restarting …` (true) or `not restarting …` (false). */
  readonly restart: boolean;
  readonly version: string;
  readonly reason: string;
  /** Which failure of that version this is: `restart N` or `failure N`. */
  readonly count: number;
  /** The restart limit the line names (`of N`, `past N restarts`). */
  readonly limit: number;
  /** Whether this answer marked the version failed (`marked it failed`). */
  readonly marked: boolean;
}

const RESTARTING = new RegExp(
  `^pack ${PROBE_PACK_ID}: restarting its sandbox of version (\\S+) \\(([^;]+); restart (\\d+) of (\\d+)\\)$`,
);

const NOT_RESTARTING = new RegExp(
  `^pack ${PROBE_PACK_ID}: not restarting its sandbox of version (\\S+) \\(([^;]+); failure (\\d+), past (\\d+) restarts in this run\\): (marked it failed|marked failed already); `,
);

/**
 * main/packs' answer to a failure of the probe pack's sandbox, from its
 * run log line; undefined for any other line (a failure of a version not
 * installed, `not counted`, included).
 */
export function probeRuntimeAnswer(
  line: RunLogLine,
): RuntimeAnswer | undefined {
  if (line.category !== 'packs') {
    return undefined;
  }
  const restarting = RESTARTING.exec(line.message);
  if (restarting !== null) {
    return {
      restart: true,
      version: restarting[1] ?? '',
      reason: restarting[2] ?? '',
      count: Number(restarting[3]),
      limit: Number(restarting[4]),
      marked: false,
    };
  }
  const stopped = NOT_RESTARTING.exec(line.message);
  if (stopped !== null) {
    return {
      restart: false,
      version: stopped[1] ?? '',
      reason: stopped[2] ?? '',
      count: Number(stopped[3]),
      limit: Number(stopped[4]),
      marked: stopped[5] === 'marked it failed',
    };
  }
  return undefined;
}

/**
 * What main/packs answers PACK_RESTART_LIMIT + 1 failures in a row of the
 * probe pack at `version`, each for `reason`: a restart for each of the
 * first PACK_RESTART_LIMIT, then none, which marks the version failed.
 */
export function restartAnswers(
  version: string,
  reason: SandboxFailureReason,
): RuntimeAnswer[] {
  return Array.from({ length: PACK_RESTART_LIMIT + 1 }, (_, index) => {
    const count = index + 1;
    const restart = count <= PACK_RESTART_LIMIT;
    return {
      restart,
      version,
      reason,
      count,
      limit: PACK_RESTART_LIMIT,
      marked: !restart,
    };
  });
}

/** The probe's report, put back together, and the `stage.log` texts it came in. */
export interface ProbeReportLines {
  readonly report: ProbeReport;
  /** Each part's whole `stage.log` text, in order. */
  readonly texts: readonly string[];
}

/**
 * Waits up to `timeoutMs` for every part of the probe's report in the run
 * log, then puts it back together (see probeEntrySource).
 */
export async function readProbeReport(
  logs: string,
  timeoutMs: number,
): Promise<ProbeReportLines> {
  const prefix = `pack ${PROBE_PACK_ID}: stage.log: `;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const parts = new Map<number, { total: number; text: string }>();
    for (const line of readRunLog(logs)) {
      if (line.category !== 'packs' || !line.message.startsWith(prefix)) {
        continue;
      }
      const text = line.message.slice(prefix.length);
      const match = /^awp-probe (\d+)\/(\d+) /.exec(text);
      if (match !== null) {
        parts.set(Number(match[1]), { total: Number(match[2]), text });
      }
    }
    const total = parts.get(1)?.total ?? 0;
    const texts: string[] = [];
    for (let part = 1; part <= total; part += 1) {
      const found = parts.get(part);
      if (found?.total === total) {
        texts.push(found.text);
      }
    }
    if (total > 0 && texts.length === total) {
      const json = texts
        .map((text) =>
          text.slice(text.indexOf(' ', PROBE_PART_PREFIX.length) + 1),
        )
        .join('');
      return { report: JSON.parse(json) as ProbeReport, texts };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the probe's report did not arrive within ${timeoutMs} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** What a `sandbox ready` line says. */
export interface ReadyLine {
  readonly version: string;
  /** Each removal's status, by name. */
  readonly removals: ReadonlyMap<string, string>;
  readonly consoleLines: number;
}

const READY = new RegExp(
  `^pack ${PROBE_PACK_ID}: sandbox ready \\(version ([^;]+); (.+); console (\\d+) lines up to the end of lockdown\\)$`,
);

/** Parses the probe's `sandbox ready` line (main/packs/sandbox-log.ts). */
export function parseReadyLine(message: string): ReadyLine {
  const match = READY.exec(message);
  if (match === null) {
    throw new Error(`not a sandbox ready line: ${message}`);
  }
  const removals = new Map<string, string>();
  for (const group of (match[2] ?? '').split('; ')) {
    const [status = '', names = ''] = group.split(': ');
    for (const name of names.split(', ')) {
      removals.set(name, status);
    }
  }
  return {
    version: match[1] ?? '',
    removals,
    consoleLines: Number(match[3]),
  };
}
