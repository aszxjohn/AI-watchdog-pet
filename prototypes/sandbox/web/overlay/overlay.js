// Overlay page of the Story 1.2 sandbox prototype. Served from app://overlay/
// with CSP `script-src 'self'` (AD-24, no 'unsafe-eval'), so PixiJS needs its
// unsafe-eval polyfill: keep that import first.
import 'pixi.js/unsafe-eval';
import { Application, Assets, Sprite } from 'pixi.js';
import entrySource from '../test-pack/entry.js?raw';

const SANDBOX_URL = 'pack://_stage/sandbox.html';
const PACK_ASSET_BASE = 'pack://test-pack/1.0.0';
const SANDBOX_TIMEOUT_MS = 20000;
const LOAD_TIMEOUT_MS = 5000;

// PixiJS texture loader strategies tried in order via Assets.setPreferences:
// default = blob Worker + fetch + createImageBitmap,
// no-workers = fetch + createImageBitmap on the page,
// image-element = HTMLImageElement with crossOrigin 'anonymous'.
const LOADER_MODES = [
  {
    id: 'default',
    preferences: { preferWorkers: true, preferCreateImageBitmap: true },
  },
  {
    id: 'no-workers',
    preferences: { preferWorkers: false, preferCreateImageBitmap: true },
  },
  {
    id: 'image-element',
    preferences: { preferWorkers: false, preferCreateImageBitmap: false },
  },
];

const cspViolations = [];
const pageErrors = [];

addEventListener('securitypolicyviolation', (event) => {
  cspViolations.push({
    directive: event.effectiveDirective,
    blockedURI: String(event.blockedURI).slice(0, 200),
    sourceFile: String(event.sourceFile).slice(0, 200),
  });
});
addEventListener('error', (event) => {
  pageErrors.push({ type: 'error', message: String(event.message) });
});
addEventListener('unhandledrejection', (event) => {
  pageErrors.push({
    type: 'unhandledrejection',
    message: describeError(event.reason).message,
  });
});

run().catch((error) => {
  window.protoHost.report({ fatal: describeError(error) });
});

async function run() {
  const port = new URLSearchParams(location.search).get('port');
  const targets = {
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
  };
  const overlay = {
    href: location.href,
    origin: location.origin,
    evalBlocked: isEvalBlocked(),
    // The overlay CSP has no connect-src, so only the main-process
    // webRequest allowlist (AD-24) can stop this request.
    webRequestCheck: await tryFetch(
      `${targets.http}/ping?from=overlay-webrequest-check`,
    ),
  };
  const sandbox = await runSandbox(targets);
  const pixi = await runPixi();
  window.protoHost.report({
    overlay: { ...overlay, cspViolations, errors: pageErrors },
    sandbox,
    pixi,
  });
}

// (a)-(c): one sandbox iframe per pack (AD-7 rule 1). The overlay hands the
// iframe three ports: `pack` goes straight to the pack Worker (AD-7 rule 5),
// `iframe` and `probe` are prototype-only diagnostics channels.
function runSandbox(targets) {
  const log = { iframe: [], pack: [], probe: [], timedOut: false };
  return new Promise((resolve) => {
    let finished = false;
    const finish = (timedOut) => {
      if (finished) return;
      finished = true;
      log.timedOut = timedOut;
      resolve(log);
    };
    const workerGaveUp = (name) =>
      log.iframe.some(
        (message) =>
          message.worker === name &&
          (message.type === 'worker-create-failed' ||
            message.type === 'worker-error'),
      );
    const check = () => {
      const packDone =
        log.pack.some((message) => message.type === 'done') ||
        workerGaveUp('pack');
      const probeDone =
        log.probe.some((message) => message.type === 'probe-result') ||
        workerGaveUp('probe');
      if (packDone && probeDone) finish(false);
    };

    const channels = {
      pack: new MessageChannel(),
      iframe: new MessageChannel(),
      probe: new MessageChannel(),
    };
    for (const [name, channel] of Object.entries(channels)) {
      channel.port1.onmessage = (event) => {
        log[name].push(event.data);
        check();
      };
    }

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.src = SANDBOX_URL;
    iframe.addEventListener(
      'load',
      () => {
        iframe.contentWindow.postMessage(
          { type: 'load', entry: entrySource, targets },
          '*',
          [channels.pack.port2, channels.iframe.port2, channels.probe.port2],
        );
      },
      { once: true },
    );
    document.body.append(iframe);
    setTimeout(() => finish(true), SANDBOX_TIMEOUT_MS);
  });
}

// (d): PixiJS (WebGL) loads a texture from pack:// with each loader mode.
async function runPixi() {
  const result = { init: null, modes: [] };
  const app = new Application();
  try {
    await app.init({
      preference: 'webgl',
      backgroundAlpha: 0,
      width: 96,
      height: 64,
      autoStart: false,
    });
    document.body.append(app.canvas);
    result.init = {
      ok: true,
      renderer: app.renderer.name,
      rendererType: app.renderer.type,
    };
  } catch (error) {
    result.init = { ok: false, error: describeError(error) };
    return result;
  }
  for (const mode of LOADER_MODES) {
    result.modes.push(await loadWithMode(app, mode));
  }
  return result;
}

async function loadWithMode(app, mode) {
  const url = `${PACK_ASSET_BASE}/sprite-${mode.id}.png`;
  const startedAt = performance.now();
  const base = { id: mode.id, url, preferences: mode.preferences };
  try {
    Assets.setPreferences(mode.preferences);
    const texture = await withTimeout(Assets.load(url), LOAD_TIMEOUT_MS);
    const sprite = new Sprite(texture);
    app.stage.addChild(sprite);
    app.render();
    // Reading the pixels back proves the image reached the GPU untainted.
    const { pixels, width, height } = app.renderer.extract.pixels(sprite);
    const sample = (x, y) => {
      const offset = (y * width + x) * 4;
      return Array.from(pixels.subarray(offset, offset + 4));
    };
    app.stage.removeChild(sprite);
    return {
      ...base,
      ok: true,
      ms: Math.round(performance.now() - startedAt),
      texture: {
        width: texture.width,
        height: texture.height,
        resource: texture.source?.resource?.constructor?.name ?? null,
      },
      extract: {
        width,
        height,
        samples: [
          sample(1, 1),
          sample(width >> 1, height >> 1),
          sample(width - 2, height - 2),
        ],
      },
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      ms: Math.round(performance.now() - startedAt),
      error: describeError(error),
    };
  }
}

async function tryFetch(url) {
  try {
    const response = await withTimeout(fetch(url), LOAD_TIMEOUT_MS);
    return { outcome: 'connected', status: response.status };
  } catch (error) {
    return { outcome: 'blocked', error: describeError(error) };
  }
}

function isEvalBlocked() {
  try {
    return Function('return 1')() !== 1;
  } catch {
    return true;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeError(error) {
  if (error instanceof Event) {
    return { name: 'Event', message: `${error.type} event` };
  }
  return {
    name: String(error?.name ?? typeof error),
    message: String(error?.message ?? error),
  };
}
