'use strict';

/**
 * Story 1.2 sandbox prototype (AD-7 gate). Disposable; nothing in src/ may
 * depend on it. One file, two roles. The role is decided by what
 * `require('electron')` returns, not by any flag: a string (the Electron
 * binary path) under plain Node, the Electron API inside Electron.
 * `--proto-role=child` on the child command line is only a label.
 *
 * - Orchestrator: `node prototypes/sandbox/main.cjs` (run by
 *   `npm run proto:sandbox` after the overlay is bundled). Runs one hidden
 *   Electron child per `pack` scheme privilege combination, aggregates the
 *   four gate items (a)-(d) and writes .vite/proto-sandbox/results.json.
 *   Exit code: 0 gate passed, 1 gate not passed, 2 the prototype itself
 *   failed (a child could not start, timed out or left no result).
 * - Electron entry: `electron prototypes/sandbox/main.cjs`.
 *   Rebuilds the AD-7 / AD-24 Electron layer (privileged `app` / `pack`
 *   schemes and handlers, webRequest allowlist, window settings), checks the
 *   127.0.0.1 control server from the main process, runs the overlay page in
 *   a hidden window and writes that run's raw results and verdicts.
 *
 * Nothing here contacts any host other than 127.0.0.1.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

let electron;
try {
  electron = require('electron');
} catch (error) {
  console.error('[proto:sandbox] cannot load electron:', error);
  process.exit(2);
}

const PROTO_DIR = __dirname;
const REPO_ROOT = path.resolve(PROTO_DIR, '..', '..');
const SANDBOX_WEB_DIR = path.join(PROTO_DIR, 'web', 'sandbox');
const OUT_DIR = path.join(REPO_ROOT, '.vite', 'proto-sandbox');
const OVERLAY_DIST = path.join(OUT_DIR, 'overlay');
const RESULTS_FILE = path.join(OUT_DIR, 'results.json');
const PRELOAD = path.join(PROTO_DIR, 'preload.cjs');
const SES_NODE_CHECK = path.join(PROTO_DIR, 'ses-node-check.cjs');
const SES_DIR = path.join(REPO_ROOT, 'node_modules', 'ses');
const PIXI_DIR = path.join(REPO_ROOT, 'node_modules', 'pixi.js');

// AD-24: `app` and `pack` get at least standard + secure, never bypassCSP.
const BASE_PRIVILEGES = Object.freeze({ standard: true, secure: true });
const APP_PRIVILEGES = BASE_PRIVILEGES;
// Extra `pack` privileges tried for (d), smallest set first.
const PACK_EXTRA_CANDIDATES = [
  [],
  ['corsEnabled'],
  ['supportFetchAPI'],
  ['supportFetchAPI', 'corsEnabled'],
];
const KNOWN_PACK_EXTRAS = new Set(['supportFetchAPI', 'corsEnabled']);

// AD-24 overlay CSP (no 'unsafe-eval') and AD-7 sandbox iframe CSP.
const OVERLAY_CSP = "script-src 'self'";
const OVERLAY_ORIGIN = 'app://overlay';
const sandboxCsp = (hash) =>
  `default-src 'none'; script-src 'sha256-${hash}' 'unsafe-eval'; worker-src blob:; connect-src 'none'`;

const PACK_ID = 'test-pack';
const PACK_VERSION = '1.0.0';
const PACK_ASSETS = new Set([
  'sprite-default.png',
  'sprite-no-workers.png',
  'sprite-image-element.png',
]);
const SPRITE = Object.freeze({
  width: 48,
  height: 32,
  rgba: [51, 153, 204, 255],
});
const PIXEL_TOLERANCE = 3;
const EXPECTED_EVALUATE_VALUE = 6;
const NETWORK_APIS = ['fetch', 'xhr', 'webSocket', 'eventSource'];
// `from=` tags used by the probe Worker and the main-process control group.
const PROBE_TAGS = {
  fetch: 'probe-fetch',
  xhr: 'probe-xhr',
  webSocket: 'probe-ws',
  eventSource: 'probe-sse',
};
const MAIN_CONTROL_TAGS = [
  'main-fetch',
  'main-xhr',
  'main-websocket',
  'main-eventsource',
];

const CHILD_TIMEOUT_MS = 90_000;
const OVERLAY_TIMEOUT_MS = 60_000;
const CONTROL_TIMEOUT_MS = 5_000;
const LATE_HIT_GRACE_MS = 750;

if (typeof electron === 'string') {
  // Plain Node: `require('electron')` is the path of the Electron binary.
  const fail = (error) => {
    console.error('[proto:sandbox] orchestrator failed:', error);
    process.exit(2);
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  orchestrate(electron).catch(fail);
} else {
  runChild(electron);
}

// ---------------------------------------------------------------------------
// Orchestrator (plain Node)
// ---------------------------------------------------------------------------

async function orchestrate(electronBinary) {
  if (!fs.existsSync(path.join(OVERLAY_DIST, 'index.html'))) {
    console.error(
      '[proto:sandbox] overlay bundle missing; use `npm run proto:sandbox` (it runs vite build first).',
    );
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Supplementary (b) evidence on the same V8, outside any iframe/Worker:
  // without the list (reproduces the first-round warning) and with it.
  const sesNodeCheck = {
    withoutList: await runSesNodeCheck(electronBinary, false),
    withList: await runSesNodeCheck(electronBinary, true),
  };
  const runs = [];
  for (const packExtra of PACK_EXTRA_CANDIDATES) {
    runs.push(
      await spawnRun(
        electronBinary,
        { packExtra, acao: true },
        runs.length + 1,
      ),
    );
  }
  // Re-run every combination that loaded the texture without the CORS
  // response header, to see whether the pack:// handler has to send it.
  const passingWithHeader = runs.filter(
    (run) => run.result?.verdicts?.d?.pass === true,
  );
  for (const run of passingWithHeader) {
    runs.push(
      await spawnRun(
        electronBinary,
        { packExtra: run.config.packExtra, acao: false },
        runs.length + 1,
      ),
    );
  }
  fs.rmSync(path.join(OUT_DIR, 'user-data'), { recursive: true, force: true });
  const summary = summarize(runs, sesNodeCheck);
  const environment = runs.find((run) => run.result?.environment)?.result
    .environment;
  fs.writeFileSync(
    RESULTS_FILE,
    `${JSON.stringify(
      {
        story: '1.2',
        generatedAt: new Date().toISOString(),
        environment: environment ?? null,
        summary,
        runs,
      },
      null,
      2,
    )}\n`,
  );
  printSummary(summary, environment);
  const harnessFailed =
    runs.some((run) => run.harnessError !== null) ||
    Object.values(sesNodeCheck).some((check) => check.harnessError !== null);
  if (harnessFailed) {
    console.error(
      '[proto:sandbox] the prototype itself failed in at least one run (see harnessError in results.json)',
    );
  }
  process.exitCode = harnessFailed ? 2 : summary.gate === 'pass' ? 0 : 1;
}

// Runs one child process with the same timeout for every kind of child.
// Resolves exactly once, also when spawning fails ('error' event).
function runProcess(binary, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let timer = null;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, spawnError });
    };
    let child;
    try {
      child = spawn(binary, args, {
        ...options,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      spawnError = error.message;
      finish(null, null);
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function harnessErrorOf(processResult) {
  if (processResult.spawnError !== null) {
    return `could not start: ${processResult.spawnError}`;
  }
  if (processResult.timedOut) return `killed after ${CHILD_TIMEOUT_MS} ms`;
  return null;
}

function runSesNodeCheck(electronBinary, removeList) {
  const outFile = path.join(
    OUT_DIR,
    `ses-node-check-${removeList ? 'with' : 'without'}-list.json`,
  );
  fs.rmSync(outFile, { force: true });
  console.log(
    `[proto:sandbox] SES check in Electron's Node mode, ${removeList ? 'with' : 'without'} the unknown-intrinsics list`,
  );
  return runProcess(
    electronBinary,
    [
      SES_NODE_CHECK,
      `--proto-remove=${removeList ? 'on' : 'off'}`,
      `--proto-out=${outFile}`,
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  ).then((processResult) => {
    const { code, stdout, stderr } = processResult;
    let harnessError = harnessErrorOf(processResult);
    let result = null;
    try {
      result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      fs.rmSync(outFile, { force: true });
    } catch (error) {
      harnessError ??= `no result file (exit ${code}): ${error.message}`;
    }
    return {
      removeList,
      exitCode: code,
      harnessError,
      stdout,
      stderr,
      result,
      silent:
        harnessError === null &&
        code === 0 &&
        stdout === '' &&
        stderr === '' &&
        (!removeList || result?.removal?.ok === true) &&
        result?.lockdown?.ok === true,
    };
  });
}

function spawnRun(electronBinary, config, index) {
  const id = `run-${index}`;
  const outFile = path.join(OUT_DIR, `${id}.json`);
  const userData = path.join(OUT_DIR, 'user-data', id);
  fs.rmSync(outFile, { force: true });
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  const label = `pack privileges = ${privilegeList(config.packExtra).join(', ')}; Access-Control-Allow-Origin = ${config.acao ? 'on' : 'off'}`;
  console.log(`[proto:sandbox] ${id}: ${label}`);
  const args = [
    __filename,
    '--proto-role=child',
    `--proto-pack-extra=${config.packExtra.join(',')}`,
    `--proto-acao=${config.acao ? 'on' : 'off'}`,
    `--proto-out=${outFile}`,
    `--proto-user-data=${userData}`,
  ];
  return runProcess(electronBinary, args).then((processResult) => {
    const { code, signal, stdout, stderr } = processResult;
    let harnessError = harnessErrorOf(processResult);
    let result = null;
    try {
      result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      fs.rmSync(outFile, { force: true });
    } catch (error) {
      harnessError ??= `no result file (exit ${code}, signal ${signal}): ${error.message}`;
    }
    if (result?.fatal) harnessError ??= `child failed: ${result.fatal.message}`;
    fs.rmSync(userData, { recursive: true, force: true });
    return {
      id,
      config,
      label,
      exit: { code, signal },
      harnessError,
      processOutputTail: tailLines(`${stdout}${stderr}`, 40),
      result,
    };
  });
}

function minimalPackRuns(runs) {
  const passing = runs.filter(
    (run) => run.config.acao && run.result?.verdicts?.d?.pass === true,
  );
  if (passing.length === 0) return [];
  const smallest = Math.min(
    ...passing.map((run) => run.config.packExtra.length),
  );
  return passing.filter((run) => run.config.packExtra.length === smallest);
}

function summarize(runs, sesNodeCheck) {
  const items = {};
  for (const key of ['a', 'b', 'c']) {
    const perRun = runs.map((run) => {
      const verdict = run.result?.verdicts?.[key];
      return {
        run: run.id,
        pass: verdict?.pass === true,
        problems: verdict?.problems ?? [run.harnessError ?? 'no result'],
        notes: verdict?.notes ?? [],
      };
    });
    items[key] = { pass: perRun.every((entry) => entry.pass), perRun };
  }
  // (b) also needs the supplementary Node-mode check (with the list) silent.
  items.b.sesNodeCheck = sesNodeCheck;
  items.b.pass = items.b.pass && sesNodeCheck.withList.silent;
  items.b.notes = [];
  const controlOutput =
    `${sesNodeCheck.withoutList.stdout}${sesNodeCheck.withoutList.stderr}`.trim();
  if (sesNodeCheck.withoutList.harnessError === null && controlOutput === '') {
    items.b.notes.push(
      'Node-mode control (without the list) printed nothing, so the effect of the list cannot be shown',
    );
  }

  const perRunD = runs.map((run) => ({
    run: run.id,
    packPrivileges: privilegeList(run.config.packExtra),
    acao: run.config.acao,
    passingModes: run.result?.verdicts?.d?.passingModes ?? [],
    problems: run.result?.verdicts?.d?.problems ?? [
      run.harnessError ?? 'no result',
    ],
    modes: run.result?.verdicts?.d?.modes ?? [],
  }));
  const minimal = minimalPackRuns(runs);
  // Per passing combination: which loader modes still work without the
  // Access-Control-Allow-Origin header on pack:// responses.
  const acaoComparison = runs
    .filter((run) => run.config.acao && run.result?.verdicts?.d?.pass === true)
    .map((run) => {
      const key = run.config.packExtra.join(',');
      const withoutRun = runs.find(
        (other) =>
          !other.config.acao && other.config.packExtra.join(',') === key,
      );
      const withHeader = run.result.verdicts.d.passingModes;
      // A rerun that errored, timed out or never got an overlay report says
      // nothing about the header: report `unknown` instead of guessing.
      const rerunValid =
        withoutRun !== undefined &&
        withoutRun.harnessError === null &&
        Boolean(withoutRun.result?.overlay?.report) &&
        !withoutRun.result.overlay.report.fatal;
      const withoutHeader = rerunValid
        ? withoutRun.result.verdicts.d.passingModes
        : null;
      return {
        privileges: privilegeList(run.config.packExtra),
        withHeader,
        withoutHeader,
        headerRequiredFor: rerunValid
          ? withHeader.filter((mode) => !withoutHeader.includes(mode))
          : 'unknown',
      };
    });
  // (d) passes when some combination loads the texture; the gate separately
  // requires (a)-(c) to pass in every run, including that combination.
  items.d = {
    pass: minimal.length > 0,
    minimalPackPrivileges: minimal.map((run) => ({
      run: run.id,
      privileges: privilegeList(run.config.packExtra),
      passingModes: run.result.verdicts.d.passingModes,
    })),
    acaoComparison,
    perRun: perRunD,
  };
  const gate = ['a', 'b', 'c', 'd'].every((key) => items[key].pass)
    ? 'pass'
    : 'fail';
  return { gate, items };
}

function printSummary(summary, environment) {
  const mark = (pass) => (pass ? 'PASS' : 'FAIL');
  const { items } = summary;
  const lines = [
    '',
    `[proto:sandbox] Story 1.2 sandbox prototype -- Electron ${environment?.electron ?? '?'} / Chrome ${environment?.chrome ?? '?'} / SES ${environment?.ses ?? '?'} / PixiJS ${environment?.pixi ?? '?'}`,
    `  (a) blob classic Worker in sandbox iframe ............ ${mark(items.a.pass)}`,
    `  (b) lockdown() + Compartment.evaluate ................ ${mark(items.b.pass)}`,
    `  (c) fetch / XHR / WebSocket / EventSource blocked .... ${mark(items.c.pass)}`,
    `  (d) PixiJS texture from pack:// ...................... ${mark(items.d.pass)}`,
  ];
  for (const check of [
    items.b.sesNodeCheck.withoutList,
    items.b.sesNodeCheck.withList,
  ]) {
    const output = `${check.stdout}${check.stderr}`.trim();
    const lineCount = output === '' ? 0 : output.split('\n').length;
    lines.push(
      `      (b) Electron Node mode (V8 ${check.result?.v8 ?? '?'}), ${check.removeList ? 'with' : 'without'} the list: ${check.harnessError ?? `${check.result?.removal?.ok === false ? `list removal FAILED (${check.result.removal.error.message}), ` : ''}lockdown ${check.result?.lockdown?.ok ? 'ok' : 'FAILED'}, ${lineCount} line(s) of output`}`,
    );
  }
  for (const note of items.b.notes) lines.push(`      (b) note: ${note}`);
  for (const minimal of items.d.minimalPackPrivileges) {
    lines.push(
      `      minimal pack privileges: ${minimal.privileges.join(', ')} (loader modes: ${minimal.passingModes.join(', ')})`,
    );
  }
  for (const comparison of items.d.acaoComparison) {
    lines.push(
      `      [${comparison.privileges.join(', ')}] Access-Control-Allow-Origin required for: ${comparison.headerRequiredFor === 'unknown' ? 'unknown' : comparison.headerRequiredFor.join(', ') || '(none)'}`,
    );
  }
  for (const run of items.d.perRun) {
    lines.push(
      `      ${run.run} [${run.packPrivileges.join(', ')}; ACAO ${run.acao ? 'on' : 'off'}] -> ${run.passingModes.join(', ') || 'no loader mode works'}`,
    );
  }
  for (const key of ['a', 'b', 'c']) {
    // Group identical problems across runs to keep the summary short.
    const byProblem = new Map();
    for (const entry of items[key].perRun) {
      for (const problem of entry.problems) {
        byProblem.set(problem, [...(byProblem.get(problem) ?? []), entry.run]);
      }
      for (const note of entry.notes) {
        const text = `note: ${note}`;
        byProblem.set(text, [...(byProblem.get(text) ?? []), entry.run]);
      }
    }
    for (const [problem, runIds] of byProblem) {
      lines.push(`      (${key}) ${runIds.join(', ')}: ${problem}`);
    }
  }
  lines.push(`  Gate: ${summary.gate === 'pass' ? 'PASS' : 'NOT PASSED'}`);
  lines.push(`  Full results: ${path.relative(REPO_ROOT, RESULTS_FILE)}`, '');
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Electron child
// ---------------------------------------------------------------------------

function runChild(api) {
  const { app, protocol } = api;
  // Never let Electron show its "JavaScript error in the main process" dialog.
  process.on('uncaughtException', (error) => {
    console.error('[proto:sandbox] child crashed:', error);
    app.exit(2);
  });
  let options;
  try {
    options = parseChildArgs(process.argv);
  } catch (error) {
    console.error('[proto:sandbox] bad child arguments:', error.message);
    app.exit(2);
    return;
  }
  const ctx = {
    webRequest: [],
    protocolRequests: [],
    permissionRequests: [],
    blockedNavigations: [],
    windowOpenAttempts: [],
    rejectedIpc: [],
    consoleMessages: [],
    webContentsEvents: [],
  };
  const writeResult = (result) => {
    fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
  };
  try {
    app.setPath('userData', options.userData);
    // AD-24: registered once, before ready.
    protocol.registerSchemesAsPrivileged([
      { scheme: 'app', privileges: { ...APP_PRIVILEGES } },
      { scheme: 'pack', privileges: packPrivileges(options.packExtra) },
    ]);
  } catch (error) {
    writeResult({ fatal: describeError(error), ctx });
    app.exit(2);
    return;
  }
  // Keep running with no visible windows until the run exits explicitly.
  app.on('window-all-closed', () => {});
  app
    .whenReady()
    .then(() => runChildSession(api, options, ctx))
    .then((result) => {
      writeResult(result);
      app.exit(0);
    })
    .catch((error) => {
      writeResult({ fatal: describeError(error), ctx });
      app.exit(2);
    });
}

async function runChildSession(api, options, ctx) {
  const { app, BrowserWindow, ipcMain, net, session } = api;
  app.dock?.hide();

  const sandboxDocument = buildSandboxDocument();
  const sprite = encodePng(SPRITE);
  const control = await startControlServer();
  try {
    const mainControl = await runMainControl(net, control.port);

    const protoSession = session.fromPartition('proto-sandbox');
    configureSession(
      protoSession,
      { sandboxDocument, sprite, acao: options.acao },
      ctx,
    );

    // AD-24 window settings; show: false so the prototype never shows a window.
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        session: protoSession,
        preload: PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        backgroundThrottling: false,
      },
    });
    guardWebContents(win.webContents, ctx);

    const overlay = await new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ timedOut: true, report: null }),
        OVERLAY_TIMEOUT_MS,
      );
      ipcMain.on('proto:result', (event, report) => {
        const frame = event.senderFrame;
        if (
          !frame ||
          frame.parent !== null ||
          !frame.url.startsWith(`${OVERLAY_ORIGIN}/`)
        ) {
          ctx.rejectedIpc.push(frame ? frame.url : null);
          return;
        }
        clearTimeout(timer);
        resolve({ timedOut: false, report });
      });
      win
        .loadURL(`${OVERLAY_ORIGIN}/index.html?port=${control.port}`)
        .catch((error) => {
          ctx.webContentsEvents.push({
            type: 'loadURL-rejected',
            error: describeError(error),
          });
        });
    });

    // Let late requests (if any) reach the control server and webRequest log.
    await delay(LATE_HIT_GRACE_MS);
    win.destroy();

    const raw = {
      environment: describeEnvironment(),
      config: {
        appPrivileges: { ...APP_PRIVILEGES },
        packPrivileges: packPrivileges(options.packExtra),
        packAcaoHeader: options.acao ? OVERLAY_ORIGIN : null,
        overlayCsp: OVERLAY_CSP,
        sandboxCsp: sandboxDocument.csp,
        sandboxScriptSha256: sandboxDocument.hash,
        sandboxScriptLength: sandboxDocument.scriptLength,
        controlPort: control.port,
      },
      mainControl,
      overlay,
      serverHits: control.hits,
      ctx,
    };
    raw.verdicts = evaluateRun(raw);
    return raw;
  } finally {
    control.close();
  }
}

function parseChildArgs(argv) {
  const read = (name) => {
    const prefix = `--${name}=`;
    const arg = argv.find((value) => value.startsWith(prefix));
    return arg === undefined ? null : arg.slice(prefix.length);
  };
  const packExtra = (read('proto-pack-extra') ?? '').split(',').filter(Boolean);
  for (const extra of packExtra) {
    if (!KNOWN_PACK_EXTRAS.has(extra)) {
      throw new Error(`unknown pack privilege: ${extra}`);
    }
  }
  const out = read('proto-out');
  const userData = read('proto-user-data');
  if (!out || !userData) {
    throw new Error('child run needs --proto-out and --proto-user-data');
  }
  return { packExtra, acao: read('proto-acao') !== 'off', out, userData };
}

function packPrivileges(packExtra) {
  const privileges = { ...BASE_PRIVILEGES };
  for (const extra of packExtra) privileges[extra] = true;
  return privileges;
}

function privilegeList(packExtra) {
  return Object.keys(packPrivileges(packExtra));
}

function describeEnvironment() {
  const versionOf = (dir) =>
    JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  return {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    ses: versionOf(SES_DIR),
    pixi: versionOf(PIXI_DIR),
  };
}

// --- Electron layer (AD-24) -------------------------------------------------

const isAllowedUrl = (url) =>
  url.startsWith('app://') || url.startsWith('pack://');

function configureSession(protoSession, assets, ctx) {
  protoSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      ctx.permissionRequests.push(permission);
      callback(false);
    },
  );
  // AD-24: webRequest only lets app:// and pack:// through.
  protoSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedUrl(details.url);
    ctx.webRequest.push({
      url: shorten(details.url),
      resourceType: details.resourceType,
      allowed,
    });
    callback({ cancel: !allowed });
  });
  protoSession.protocol.handle('app', (request) => serveApp(request, ctx));
  protoSession.protocol.handle('pack', (request) =>
    servePack(request, assets, ctx),
  );
}

function guardWebContents(contents, ctx) {
  contents.setWindowOpenHandler((details) => {
    ctx.windowOpenAttempts.push(details.url);
    return { action: 'deny' };
  });
  contents.on('will-frame-navigate', (event) => {
    if (!isAllowedUrl(event.url)) {
      ctx.blockedNavigations.push(event.url);
      event.preventDefault();
    }
  });
  contents.on('console-message', (event) => {
    let frameUrl = null;
    try {
      frameUrl = event.frame?.url ?? null;
    } catch {
      frameUrl = null;
    }
    ctx.consoleMessages.push({
      level: event.level,
      message: shorten(String(event.message), 600),
      source: shorten(String(event.sourceId)),
      line: event.lineNumber,
      frame: frameUrl === null ? null : shorten(frameUrl),
    });
  });
  contents.on('render-process-gone', (_event, details) => {
    ctx.webContentsEvents.push({ type: 'render-process-gone', ...details });
  });
  contents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      ctx.webContentsEvents.push({
        type: 'did-fail-load',
        errorCode,
        errorDescription,
        url: shorten(validatedURL),
        isMainFrame,
      });
    },
  );
}

function serveApp(request, ctx) {
  ctx.protocolRequests.push({ scheme: 'app', url: shorten(request.url) });
  const url = new URL(request.url);
  if (url.host !== 'overlay') return notFound();
  const relative =
    decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(OVERLAY_DIST, relative);
  if (
    !file.startsWith(OVERLAY_DIST + path.sep) ||
    !fs.existsSync(file) ||
    !fs.statSync(file).isFile()
  ) {
    return notFound();
  }
  const headers = { 'content-type': contentTypeOf(file) };
  if (file.endsWith('.html')) headers['content-security-policy'] = OVERLAY_CSP;
  return new Response(fs.readFileSync(file), { headers });
}

// AD-24 pack:// shapes: pack://_stage/... and pack://<packId>/<version>/<path>.
function servePack(request, assets, ctx) {
  ctx.protocolRequests.push({ scheme: 'pack', url: shorten(request.url) });
  const url = new URL(request.url);
  if (url.host === '_stage') {
    if (url.pathname !== '/sandbox.html') return notFound();
    return new Response(assets.sandboxDocument.html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': assets.sandboxDocument.csp,
      },
    });
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (
    url.host !== PACK_ID ||
    segments.length !== 2 ||
    segments[0] !== PACK_VERSION ||
    !PACK_ASSETS.has(segments[1])
  ) {
    return notFound();
  }
  const headers = { 'content-type': 'image/png' };
  if (assets.acao) headers['access-control-allow-origin'] = OVERLAY_ORIGIN;
  return new Response(assets.sprite, { headers });
}

function notFound() {
  return new Response('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  });
}

function contentTypeOf(file) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
  };
  return types[path.extname(file)] ?? 'application/octet-stream';
}

// pack://_stage/sandbox.html: the iframe bootstrap is inline and the CSP
// carries its SHA-256 (AD-7 rule 1). SES and the Worker bootstrap are
// embedded in that same hashed script (AD-19).
function buildSandboxDocument() {
  const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const embedded = {
    ses: read(path.join(SES_DIR, 'dist', 'ses.umd.min.js')),
    workerPrelude: read(path.join(SANDBOX_WEB_DIR, 'worker-prelude.js')),
    sesUnknownIntrinsics: read(
      path.join(SANDBOX_WEB_DIR, 'ses-unknown-intrinsics.js'),
    ),
    workerBootstrap: read(path.join(SANDBOX_WEB_DIR, 'worker-bootstrap.js')),
    probeWorker: read(path.join(SANDBOX_WEB_DIR, 'probe-worker.js')),
  };
  const script = `const EMBEDDED = ${toInlineScriptJson(embedded)};\n${read(
    path.join(SANDBOX_WEB_DIR, 'iframe-bootstrap.js'),
  )}`;
  if (/<\/script|<!--/i.test(script)) {
    throw new Error('sandbox bootstrap would break out of its inline <script>');
  }
  if (/[^\t\n\x20-\x7e]/.test(script)) {
    throw new Error('sandbox bootstrap must be ASCII so its hash is stable');
  }
  const hash = crypto
    .createHash('sha256')
    .update(script, 'utf8')
    .digest('base64');
  const html = [
    '<!doctype html>',
    '<html>',
    '<head><meta charset="utf-8"><title>sandbox</title></head>',
    `<body><script>${script}</script></body>`,
    '</html>',
    '',
  ].join('\n');
  return { html, csp: sandboxCsp(hash), hash, scriptLength: script.length };
}

function toInlineScriptJson(value) {
  return JSON.stringify(value).replace(
    /[<>&\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

// Minimal RGBA PNG encoder so the test sprite needs no binary file.
function encodePng({ width, height, rgba }) {
  const row = Buffer.alloc(1 + width * 4); // leading 0 = filter type None
  for (let x = 0; x < width; x += 1) Buffer.from(rgba).copy(row, 1 + x * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk(
      'IDAT',
      zlib.deflateSync(
        Buffer.concat(Array.from({ length: height }, () => row)),
      ),
    ),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

// --- 127.0.0.1 control target -----------------------------------------------

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function startControlServer() {
  const hits = [];
  const sockets = new Set();
  const record = (req, upgrade) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    hits.push({
      at: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      from: url.searchParams.get('from'),
      origin: req.headers.origin ?? null,
      upgrade,
    });
    return url;
  };
  // Every response allows any origin, so CORS can never be the reason a
  // sandboxed request fails: only the sandbox layers can block it.
  const server = http.createServer((req, res) => {
    const url = record(req, false);
    if (url.pathname === '/ping') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'access-control-allow-origin': '*',
      });
      res.end('pong');
      return;
    }
    if (url.pathname === '/sse') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end('data: hello\n\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket) => {
    const url = record(req, true);
    const key = req.headers['sec-websocket-key'];
    socket.on('error', () => {});
    if (url.pathname !== '/ws' || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + WEBSOCKET_GUID)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    const payload = Buffer.from('hello');
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        hits,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

// Control group: the same target, reached from the main process.
async function runMainControl(net, port) {
  const base = `http://127.0.0.1:${port}`;
  return {
    fetch: await settle(
      async () => {
        const response = await net.fetch(`${base}/ping?from=main-fetch`);
        return {
          via: 'net.fetch',
          status: response.status,
          body: await response.text(),
        };
      },
      (value) => value.status === 200 && value.body === 'pong',
    ),
    xhr: await settle(
      () => netRequest(net, `${base}/ping?from=main-xhr`),
      (value) => value.status === 200 && value.body === 'pong',
    ),
    webSocket: await settle(
      () => openWebSocket(`ws://127.0.0.1:${port}/ws?from=main-websocket`),
      (value) => value.message === 'hello',
    ),
    eventSource: await settle(
      () => readFirstEvent(net, `${base}/sse?from=main-eventsource`),
      (value) =>
        value.status === 200 &&
        String(value.contentType).startsWith('text/event-stream') &&
        value.data === 'hello',
    ),
  };
}

async function settle(task, check) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${CONTROL_TIMEOUT_MS} ms`)),
      CONTROL_TIMEOUT_MS,
    );
  });
  try {
    const value = await Promise.race([task(), timeout]);
    return { ok: check(value), value };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

// XHR has no main-process equivalent; net.request hits the same endpoint
// through Chromium's network stack.
function netRequest(net, url) {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          via: 'net.request',
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('message', (event) => {
      resolve({ via: 'WebSocket (Node)', message: String(event.data) });
      socket.close();
    });
    socket.addEventListener('error', () =>
      reject(new Error('WebSocket error event')),
    );
  });
}

// Node has no EventSource; read the first SSE event over net.fetch instead.
async function readFirstEvent(net, url) {
  const response = await net.fetch(url, {
    headers: { accept: 'text/event-stream' },
  });
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString('utf8');
  }
  await reader.cancel();
  return {
    via: 'net.fetch stream',
    status: response.status,
    contentType: response.headers.get('content-type'),
    data: /^data: (.*)$/m.exec(text)?.[1] ?? null,
  };
}

// --- Verdicts ---------------------------------------------------------------

function evaluateRun(raw) {
  const report = raw.overlay.report;
  if (!report || report.fatal) {
    const problem = raw.overlay.timedOut
      ? `overlay did not report within ${OVERLAY_TIMEOUT_MS} ms`
      : `overlay failed: ${report?.fatal?.message ?? 'no report'}`;
    const failed = { pass: false, problems: [problem] };
    return {
      a: failed,
      b: failed,
      c: failed,
      d: { ...failed, passingModes: [], modes: [] },
    };
  }
  return {
    a: verdictA(report.sandbox),
    b: verdictB(report.sandbox),
    c: verdictC(raw, report.sandbox),
    d: verdictD(report.pixi, report.overlay),
  };
}

const packPayloads = (sandbox, kind) =>
  sandbox.pack
    .filter(
      (message) => message.type === 'pack' && message.payload?.kind === kind,
    )
    .map((message) => message.payload);

function verdictA(sandbox) {
  const problems = [];
  const info = sandbox.iframe.find((message) => message.type === 'iframe-info');
  const created = sandbox.iframe.find(
    (message) => message.type === 'worker-created' && message.worker === 'pack',
  );
  const failures = sandbox.iframe.filter(
    (message) =>
      message.worker === 'pack' &&
      (message.type === 'worker-create-failed' ||
        message.type === 'worker-error'),
  );
  const started = sandbox.pack.find(
    (message) => message.type === 'worker-started',
  );
  if (!info) {
    problems.push(
      'sandbox iframe bootstrap never reported (inline script blocked or iframe not loaded)',
    );
  } else {
    if (info.origin !== 'null') {
      problems.push(
        `iframe origin is ${info.origin}, expected opaque "null" (allow-same-origin leaked?)`,
      );
    }
    if (info.inlineScriptBlocked !== true) {
      problems.push(
        'a non-hashed inline script ran, so the AD-7 CSP is not in effect',
      );
    }
    if (!String(info.parentDocumentAccess).startsWith('blocked')) {
      problems.push('iframe can read the parent document');
    }
  }
  if (!created) problems.push('pack Worker was not created');
  for (const failure of failures) {
    problems.push(
      `${failure.type}: ${failure.error?.message ?? failure.message}`,
    );
  }
  if (!started) {
    problems.push('pack Worker never reported through the MessageChannel port');
  } else {
    if (started.info.importScriptsType !== 'function') {
      problems.push(
        'Worker is not classic (importScripts missing before removal)',
      );
    }
    if (!String(started.info.locationHref).startsWith('blob:')) {
      problems.push(
        `Worker URL is ${started.info.locationHref}, expected blob:`,
      );
    }
  }
  return {
    pass: problems.length === 0,
    problems,
    evidence: {
      iframe: info ?? null,
      workerCreated: created ?? null,
      workerStarted: started?.info ?? null,
      iframeCspViolations: sandbox.iframe.filter(
        (message) => message.type === 'csp-violation',
      ),
    },
  };
}

function verdictB(sandbox) {
  const problems = [];
  if (sandbox.timedOut) problems.push('sandbox run timed out');
  const ses = sandbox.pack.find((message) => message.type === 'ses');
  const evaluated = sandbox.pack.find(
    (message) => message.type === 'pack-evaluated',
  );
  const done = sandbox.pack.find((message) => message.type === 'done');
  const hello = packPayloads(sandbox, 'hello')[0];
  if (!ses) {
    problems.push('Worker sent no SES report');
  } else {
    if (!ses.lockdown.ok)
      problems.push(`lockdown() threw: ${ses.lockdown.error.message}`);
    if (!ses.evaluate.ok) {
      problems.push(
        `Compartment.evaluate threw: ${ses.evaluate.error.message}`,
      );
    } else if (ses.evaluate.value !== EXPECTED_EVALUATE_VALUE) {
      problems.push(
        `Compartment.evaluate returned ${ses.evaluate.value}, expected ${EXPECTED_EVALUATE_VALUE}`,
      );
    }
    if (!ses.intrinsicsFrozen)
      problems.push('intrinsics are not frozen after lockdown()');
  }
  if (!done) problems.push('pack Worker never sent its final report');
  // Union of every console record the Worker reported (the prelude numbers
  // them), so output during lockdown() counts even if `done` never came.
  const recordsBySeq = new Map();
  for (const message of [ses, evaluated, done]) {
    for (const record of message?.consoleRecords ?? []) {
      recordsBySeq.set(record.seq, record);
    }
  }
  const consoleRecords = [...recordsBySeq.values()].sort(
    (left, right) => left.seq - right.seq,
  );
  for (const record of consoleRecords) {
    problems.push(
      `console.${record.level} in Worker: ${record.text.slice(0, 300)}`,
    );
  }
  if (!evaluated) {
    problems.push('pack entry was never evaluated');
  } else if (!evaluated.result.ok) {
    problems.push(
      `pack entry threw inside the Compartment: ${evaluated.result.error.message}`,
    );
  }
  if (!hello || hello.sum !== EXPECTED_EVALUATE_VALUE) {
    problems.push('pack code did not run inside the Compartment');
  }
  // AD-7 (2026-11-05): unknown intrinsics are removed before lockdown().
  // An entry that is already gone is skipped; one that cannot be deleted
  // would make SES warn, which the console check above catches anyway.
  const notes = [];
  for (const entry of ses?.intrinsicRemoval ?? []) {
    if (entry.status === 'not-deletable') {
      problems.push(`could not delete ${entry.path} before lockdown()`);
    } else if (entry.status === 'absent') {
      notes.push(`${entry.path} does not exist here (list entry skipped)`);
    }
  }
  return {
    pass: problems.length === 0,
    problems,
    notes,
    evidence: {
      intrinsicRemoval: ses?.intrinsicRemoval ?? null,
      lockdown: ses?.lockdown ?? null,
      evaluate: ses?.evaluate ?? null,
      intrinsicsFrozen: ses?.intrinsicsFrozen ?? null,
      consoleRecords,
      packEvaluated: evaluated?.result ?? null,
      packHello: hello ?? null,
      packGlobals: packPayloads(sandbox, 'globals')[0] ?? null,
      apiRemoval: ses?.removal ?? null,
    },
  };
}

function verdictC(raw, sandbox) {
  const problems = [];
  const notes = [];
  for (const api of NETWORK_APIS) {
    if (!raw.mainControl[api].ok) {
      problems.push(
        `control: main process could not reach the 127.0.0.1 target via ${api}`,
      );
    }
  }
  const packNetwork = packPayloads(sandbox, 'network')[0];
  if (!packNetwork) {
    problems.push('pack network attempts never reported');
  } else {
    for (const api of NETWORK_APIS) {
      const attempt = packNetwork.attempts[api];
      if (attempt.outcome !== 'threw') {
        problems.push(`pack ${api}: call did not throw (${attempt.outcome})`);
      }
    }
  }
  for (const late of packPayloads(sandbox, 'network-late')) {
    if (late.connected)
      problems.push(`pack ${late.api}: connected (${late.detail})`);
  }
  const probe = sandbox.probe.find(
    (message) => message.type === 'probe-result',
  );
  if (!probe || probe.fatal) {
    problems.push(
      `probe Worker did not report${probe?.fatal ? `: ${probe.fatal.message}` : ''}`,
    );
  } else {
    // Every real API must be blocked by CSP itself: outcome `blocked` plus a
    // connect-src violation for that request, and never seen by webRequest.
    for (const api of NETWORK_APIS) {
      const outcome = probe.results[api].outcome;
      if (outcome !== 'blocked') {
        problems.push(`probe ${api}: outcome ${outcome}, expected blocked`);
      }
      const tag = `from=${PROBE_TAGS[api]}`;
      const violated = probe.violations.some(
        (violation) =>
          violation.directive === 'connect-src' &&
          violation.blockedURI.includes(tag),
      );
      if (!violated) {
        problems.push(`probe ${api}: no connect-src violation recorded`);
      }
    }
    for (const check of ['importScriptsBlob', 'fetchBlob']) {
      const outcome = probe.results.cspInheritance[check].outcome;
      if (outcome !== 'blocked') {
        problems.push(
          `probe ${check}: outcome ${outcome}, expected blocked (CSP not inherited?)`,
        );
      }
    }
  }
  const probeAtWebRequest = raw.ctx.webRequest.filter((entry) =>
    entry.url.includes('from=probe-'),
  );
  if (probeAtWebRequest.length > 0) {
    problems.push(
      `probe request(s) reached webRequest, so CSP did not stop them: ${probeAtWebRequest
        .map((entry) => entry.url)
        .join(', ')}`,
    );
  }
  // Supplementary: the overlay (no connect-src) shows whether the AD-24
  // webRequest allowlist stops a request that CSP lets through.
  const overlayCheck = raw.overlay.report.overlay.webRequestCheck;
  if (overlayCheck?.outcome === 'connected') {
    problems.push(
      'overlay reached 127.0.0.1: webRequest allowlist did not block it',
    );
  } else if (
    !raw.ctx.webRequest.some(
      (entry) =>
        !entry.allowed && entry.url.includes('from=overlay-webrequest-check'),
    )
  ) {
    notes.push('overlay request failed but webRequest never saw it');
  }
  // Each main-process control request must hit exactly once; anything else
  // (including a second request claiming a main-* tag) is a renderer leak.
  for (const tag of MAIN_CONTROL_TAGS) {
    const count = raw.serverHits.filter((hit) => hit.from === tag).length;
    if (count !== 1) {
      problems.push(
        `control server saw from=${tag} ${count} time(s), expected exactly 1`,
      );
    }
  }
  const rendererHits = raw.serverHits.filter(
    (hit) => !MAIN_CONTROL_TAGS.includes(hit.from),
  );
  if (rendererHits.length > 0) {
    problems.push(
      `control server received ${rendererHits.length} request(s) from the renderer side: ${rendererHits
        .map((hit) => `${hit.path}?from=${hit.from}`)
        .join(', ')}`,
    );
  }
  return {
    pass: problems.length === 0,
    problems,
    notes,
    evidence: {
      mainControl: raw.mainControl,
      packAttempts: packNetwork?.attempts ?? null,
      probe: probe ?? null,
      overlayWebRequestCheck: overlayCheck ?? null,
      serverHits: raw.serverHits,
      webRequestBlocked: raw.ctx.webRequest.filter((entry) => !entry.allowed),
    },
  };
}

function verdictD(pixi, overlay) {
  const problems = [];
  if (!overlay.evalBlocked) {
    problems.push(
      "overlay can eval, so its CSP is not the AD-24 one (no 'unsafe-eval')",
    );
  }
  if (!pixi?.init?.ok) {
    problems.push(
      `PixiJS init failed: ${pixi?.init?.error?.message ?? 'no result'}`,
    );
    return { pass: false, problems, passingModes: [], modes: [] };
  }
  if (pixi.init.renderer !== 'webgl') {
    problems.push(
      `PixiJS picked the ${pixi.init.renderer} renderer, expected webgl`,
    );
  }
  const modes = pixi.modes.map((mode) => {
    const reasons = [];
    if (!mode.ok) {
      reasons.push(`${mode.error.name}: ${mode.error.message}`);
    } else {
      if (
        mode.texture.width !== SPRITE.width ||
        mode.texture.height !== SPRITE.height
      ) {
        reasons.push(
          `texture is ${mode.texture.width}x${mode.texture.height}, expected ${SPRITE.width}x${SPRITE.height}`,
        );
      }
      const wrong = mode.extract.samples.filter(
        (pixel) =>
          pixel.length !== 4 ||
          pixel.some(
            (channel, index) =>
              Math.abs(channel - SPRITE.rgba[index]) > PIXEL_TOLERANCE,
          ),
      );
      if (wrong.length > 0) {
        reasons.push(
          `rendered pixels ${JSON.stringify(mode.extract.samples)} != ${JSON.stringify(SPRITE.rgba)}`,
        );
      }
    }
    return {
      id: mode.id,
      pass: reasons.length === 0,
      reasons,
      ms: mode.ms,
      texture: mode.texture ?? null,
      samples: mode.extract?.samples ?? null,
    };
  });
  const passingModes = modes.filter((mode) => mode.pass).map((mode) => mode.id);
  if (passingModes.length === 0)
    problems.push('no PixiJS loader mode could load the pack:// texture');
  return {
    pass: problems.length === 0,
    problems,
    passingModes,
    modes,
    evidence: {
      renderer: pixi.init,
      overlayEvalBlocked: overlay.evalBlocked,
      overlayCspViolations: overlay.cspViolations,
      overlayErrors: overlay.errors,
    },
  };
}

// --- helpers ----------------------------------------------------------------

function describeError(error) {
  return {
    name: String(error?.name ?? typeof error),
    message: String(error?.message ?? error),
  };
}

function shorten(text, max = 240) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function tailLines(text, count) {
  return text.split('\n').filter(Boolean).slice(-count);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
