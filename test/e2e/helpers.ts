/**
 * What the end-to-end tests (Story 3.5) need around the app: a temporary
 * HOME and userData, a synthetic Claude Code session in that HOME, the
 * sandbox probe pack, a 127.0.0.1 server the probe aims at, launching the
 * production build (`.vite/`, from scripts/e2e-build.mjs) with Playwright's
 * `_electron`, and reading the run log.
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
import { STAGE_LOG_MAX_LENGTH } from '../../src/shared/constants';
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

/**
 * Writes `<home>/.claude/projects/<folder>/<uuid>.jsonl` with one `user`
 * record timestamped now, written here (no real transcript): the Claude
 * Code adapter replays it at start, so the session is shown and gets a
 * character.
 */
export function writeClaudeSession(home: string): SyntheticSession {
  const sessionId = randomUUID();
  const folder = path.join(home, '.claude', 'projects', '-e2e-project');
  fs.mkdirSync(folder, { recursive: true });
  const record = {
    type: 'user',
    uuid: randomUUID(),
    sessionId,
    cwd: path.join(home, 'e2e-project'),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'e2e sandbox check' },
  };
  fs.writeFileSync(
    path.join(folder, `${sessionId}.jsonl`),
    `${JSON.stringify(record)}\n`,
  );
  return { sessionId, sessionKey: `claude-code:${sessionId}` };
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
  return {
    init: function () {},
    spawn: function () {},
    despawn: function () {},
    params: function () {},
    meta: function () {},
    frame: function () { return {}; }
  };
})
`;
}

/**
 * Writes the probe pack to `<dir>/sandbox-probe.awpet`: the contract test
 * pack (test/helpers/awpet.ts) under the probe's id, with the probe as its
 * entry.
 */
export async function writeProbePack(
  dir: string,
  server: ProbeServer,
): Promise<string> {
  const files: Map<string, Buffer | string> = contractPackFiles();
  const manifest = contractManifest();
  manifest.id = PROBE_PACK_ID;
  manifest.name = 'Sandbox probe';
  files.set('manifest.json', manifestBytes(manifest));
  files.set(String(manifest.entry), probeEntrySource(server));
  const file = path.join(dir, `${PROBE_PACK_ID}.awpet`);
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

/** Whether `line` says the probe pack's sandbox failed or was never made. */
export function probeSandboxTrouble(line: RunLogLine): boolean {
  return (
    probeLine('sandbox failed')(line) ||
    probeLine('has an actor but gets no sandbox')(line)
  );
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
