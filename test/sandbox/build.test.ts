/**
 * The sandbox document's build (Story 3.5): the main build's plugin
 * (scripts/sandbox-plugin.ts) run here for real, with its output checked,
 * and the positive control: the built Worker bootstrap, SES and the
 * contract test pack's entry booted in a child process
 * (test/helpers/sandbox-boot-check.cjs). In Electron's Node mode
 * (ELECTRON_RUN_AS_NODE=1) that is the same V8 as the pack Worker; it is
 * skipped where the Electron binary is not installed (CI installs without
 * it), and the same check also runs under plain Node.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSandboxDocument,
  sandboxDocumentPlugin,
  type SandboxBuild,
} from '../../scripts/sandbox-plugin';
import { sandboxCsp } from '../../src/sandbox/csp';
import {
  normalizeNewlines,
  WORKER_SCRIPT_GLOBAL,
  workerScript,
} from '../../src/sandbox/document';
import {
  REMOVED_WORKER_APIS,
  SES_UNKNOWN_INTRINSICS,
} from '../../src/sandbox/lists';
import {
  SANDBOX_CSP_FILE,
  SANDBOX_DOCUMENT_FILE,
  STAGE_LOG_MAX_LENGTH,
} from '../../src/shared/constants';
import { drawMessageSchema } from '../../src/shared/pack-api';
import { sandboxReportSchema } from '../../src/shared/sandbox';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const CHECK = path.join(ROOT, 'test', 'helpers', 'sandbox-boot-check.cjs');
const CONTRACT_ENTRY = path.join(
  ROOT,
  'test',
  'packs',
  'contract-pack',
  'contract-pack',
  'entry.js',
);
const HANDLER_KEYS = ['init', 'spawn', 'despawn', 'params', 'meta', 'frame'];

/** The Electron binary, or undefined when it is not installed. */
function electronBinary(): string | undefined {
  try {
    const binary: unknown = createRequire(import.meta.url)('electron');
    return typeof binary === 'string' && fs.existsSync(binary)
      ? binary
      : undefined;
  } catch {
    return undefined;
  }
}

const ELECTRON = electronBinary();

let built: SandboxBuild;
let temp: string;

beforeAll(async () => {
  built = await buildSandboxDocument(ROOT);
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-sandbox-build-'));
  fs.writeFileSync(
    path.join(temp, 'bootstrap.js'),
    built.parts.workerBootstrap,
  );
  fs.writeFileSync(path.join(temp, 'ses.js'), built.parts.ses);
}, 60_000);

afterAll(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

/** The one inline script of `html`. */
function inlineScriptOf(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  return scripts[0]?.[1] ?? '';
}

interface BootCheck {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: {
    readonly report?: unknown;
    readonly handlerKeys?: readonly string[] | null;
    readonly posted?: readonly unknown[];
    readonly consoleLines?: number;
    readonly replies?: readonly unknown[];
    readonly ownActors?: readonly string[];
    readonly electron?: string | null;
    readonly error?: unknown;
  };
}

/** Runs the boot check with `binary` (Electron in Node mode, or Node). */
function bootCheck(binary: string, entry: string, mode?: 'print'): BootCheck {
  const out = path.join(
    temp,
    `out-${Math.random().toString(36).slice(2)}.json`,
  );
  const run = spawnSync(
    binary,
    [
      CHECK,
      path.join(temp, 'bootstrap.js'),
      path.join(temp, 'ses.js'),
      entry,
      out,
      ...(mode === undefined ? [] : [mode]),
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    result: JSON.parse(fs.readFileSync(out, 'utf8')) as BootCheck['result'],
  };
}

/**
 * The contract test pack's answer to the boot check's init and frame: one
 * draw for seq 0 with probe-two's sprite (busy: rotated), which passes the
 * pack API's drawMessageSchema; its own actor known to stage.random.
 */
function expectContractDraw(run: BootCheck): void {
  expect(run.result.report).toMatchObject({ type: 'sandbox.ready' });
  expect(run.result.ownActors).toStrictEqual(['a1']);
  expect(run.result.replies).toHaveLength(1);
  const draw = drawMessageSchema.parse(run.result.replies?.[0]);
  expect(draw.seq).toBe(0);
  expect(Object.keys(draw.actors)).toStrictEqual(['a1']);
  expect(draw.actors.a1).toStrictEqual([
    expect.objectContaining({
      type: 'sprite',
      asset: 'probe-two-sheet',
      x: -25,
      y: -96,
      scaleX: 25,
      scaleY: 48,
      rotation: expect.any(Number) as unknown,
    }),
  ]);
  expect(['eyes-open', 'eyes-shut']).toContain(
    (draw.actors.a1?.[0] as { frame?: string } | undefined)?.frame,
  );
}

function writeEntry(name: string, source: string): string {
  const file = path.join(temp, name);
  fs.writeFileSync(file, source);
  return file;
}

describe('I/O matrix', () => {
  it("建置: the CSP's hash is the SHA-256 of the document's one inline script", () => {
    const script = inlineScriptOf(built.html);
    const sha256 = createHash('sha256').update(script, 'utf8').digest('base64');

    expect(script).toBe(built.script);
    expect(built.sha256).toBe(sha256);
    expect(built.csp).toBe(sandboxCsp(sha256));
    expect(built.csp).toContain(`'sha256-${sha256}'`);
  });

  it('建置: the document is ASCII, inlines SES and the bootstrap, and loads nothing from anywhere', () => {
    const script = inlineScriptOf(built.html);
    const prefix = `const ${WORKER_SCRIPT_GLOBAL} = `;
    const firstStatement = script.slice(0, script.indexOf(';\n'));

    expect(built.html).toMatch(/^[\t\n\x20-\x7e]*$/);
    // Around the script, only the skeleton: no src, no link, no other tag.
    expect(built.html.replace(script, '')).toBe(
      [
        '<!doctype html>',
        '<html>',
        '<head><meta charset="utf-8"><title>sandbox</title></head>',
        '<body><script></script></body>',
        '</html>',
        '',
      ].join('\n'),
    );
    expect(firstStatement.startsWith(prefix)).toBe(true);
    expect(JSON.parse(firstStatement.slice(prefix.length))).toBe(
      workerScript(built.parts.workerBootstrap, built.parts.ses),
    );
    // SES itself, as the package ships it (read at build time only).
    const sesFile = path.join(
      path.dirname(createRequire(import.meta.url).resolve('ses/package.json')),
      'dist',
      'ses.umd.min.js',
    );
    expect(built.parts.ses).toBe(fs.readFileSync(sesFile, 'utf8'));
    expect(normalizeNewlines(built.parts.ses)).toContain('lockdown');
  });

  it('建置: the same sources build the same document, hash included', async () => {
    const again = await buildSandboxDocument(ROOT);

    expect(again.html).toBe(built.html);
    expect(again.sha256).toBe(built.sha256);
  }, 60_000);

  it('建置: the main build (npm start and the packaged app alike) runs the plugin, which emits sandbox.html and its CSP next to main.cjs', async () => {
    // Forge's typings add its own fields to ConfigEnv; the file reads none.
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' } as Parameters<
        typeof loadConfigFromFile
      >[0],
      path.join(ROOT, 'vite.main.config.mts'),
      ROOT,
      'silent',
    );
    const plugins = (loaded?.config.plugins ?? []).flat() as Plugin[];
    expect(plugins.map((plugin) => plugin.name)).toContain(
      'awp-sandbox-document',
    );

    const plugin = sandboxDocumentPlugin();
    const emitted: { fileName: string; source: string }[] = [];
    const watched: string[] = [];
    (plugin.configResolved as (config: { root: string }) => void)({
      root: ROOT,
    });
    await (plugin.buildStart as (this: unknown) => Promise<void>).call({
      addWatchFile: (file: string) => {
        watched.push(file);
      },
      emitFile: (file: { fileName: string; source: string }) => {
        emitted.push(file);
        return file.fileName;
      },
    });

    expect(plugin.apply).toBe('build');
    expect(emitted.map((file) => file.fileName)).toStrictEqual([
      SANDBOX_DOCUMENT_FILE,
      SANDBOX_CSP_FILE,
    ]);
    expect(emitted[0]?.source).toBe(built.html);
    expect(JSON.parse(emitted[1]?.source ?? '')).toStrictEqual({
      csp: built.csp,
      sha256: built.sha256,
    });
    const normalized = watched.map((file) => path.normalize(file));
    for (const file of ['worker-bootstrap.ts', 'iframe.ts', 'lists.ts']) {
      expect(normalized).toContain(
        path.normalize(path.join(ROOT, 'src', 'sandbox', file)),
      );
    }
  }, 60_000);
});

/** The removal names, in order, as the bootstrap reports them. */
const REMOVAL_NAMES = [...REMOVED_WORKER_APIS, ...SES_UNKNOWN_INTRINSICS];

// In Electron's Node mode: the pack Worker's V8.
describe.skipIf(ELECTRON === undefined)('I/O matrix', () => {
  it("移除清單: every API and intrinsic of the lists is reported, each removed or never there; Electron 45's Iterator.prototype.join and includes are removed", () => {
    const run = bootCheck(ELECTRON as string, CONTRACT_ENTRY);
    const report = sandboxReportSchema.parse(run.result.report);

    expect(run.result.electron).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.type).toBe('sandbox.ready');
    if (report.type !== 'sandbox.ready') {
      return;
    }
    expect(report.removals.map((removal) => removal.name)).toStrictEqual(
      REMOVAL_NAMES,
    );
    for (const removal of report.removals) {
      expect(['removed', 'absent']).toContain(removal.status);
    }
    expect(
      report.removals.filter((removal) =>
        SES_UNKNOWN_INTRINSICS.includes(removal.name),
      ),
    ).toStrictEqual(
      SES_UNKNOWN_INTRINSICS.map((name) => ({ name, status: 'removed' })),
    );
  });

  it("出現: after lockdown, the bootstrap hands the contract test pack an init and a frame (stageMessageSchema checks them) and wraps the frame's answer as its draw", () => {
    const run = bootCheck(ELECTRON as string, CONTRACT_ENTRY);

    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expectContractDraw(run);
  });

  it('lockdown: loading SES and lockdown() print nothing (0 console lines, empty stdout and stderr)', () => {
    const run = bootCheck(ELECTRON as string, CONTRACT_ENTRY);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(run.result.consoleLines).toBe(0);
    expect(run.result.report).toMatchObject({ consoleLines: 0 });
  });
});

// The same boot under plain Node, which CI has (it installs without the
// Electron binary): everything that does not depend on Electron's V8.
describe('I/O matrix', () => {
  it('移除清單: every list entry is reported, each removed or never there; lockdown prints nothing; the handlers come back', () => {
    const run = bootCheck(process.execPath, CONTRACT_ENTRY);
    const report = sandboxReportSchema.parse(run.result.report);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(report).toMatchObject({ type: 'sandbox.ready', consoleLines: 0 });
    expect(
      report.type === 'sandbox.ready'
        ? report.removals.map((removal) => removal.name)
        : [],
    ).toStrictEqual(REMOVAL_NAMES);
    for (const removal of report.type === 'sandbox.ready'
      ? report.removals
      : []) {
      expect(['removed', 'absent']).toContain(removal.status);
    }
    expect(run.result.handlerKeys).toStrictEqual(HANDLER_KEYS);
  });

  it('lockdown: a console line between loading SES and the end of lockdown() fails the boot (negative control)', () => {
    const run = bootCheck(process.execPath, CONTRACT_ENTRY, 'print');

    expect(run.result.report).toMatchObject({
      type: 'sandbox.failed',
      reason: 'lockdown-output',
      consoleLines: 1,
    });
    expect(run.result.handlerKeys).toBeNull();
  });

  it("出現: after lockdown, the bootstrap hands the contract test pack an init and a frame (stageMessageSchema checks them) and wraps the frame's answer as its draw", () => {
    const run = bootCheck(process.execPath, CONTRACT_ENTRY);

    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expectContractDraw(run);
  });

  it("入口: the contract test pack's entry is a factory; called with stage, it returns its handlers", () => {
    const run = bootCheck(process.execPath, CONTRACT_ENTRY);

    expect(run.result.report).toMatchObject({ type: 'sandbox.ready' });
    expect(run.result.handlerKeys).toStrictEqual(HANDLER_KEYS);
    expect(run.result.posted).toStrictEqual([]);
  });

  it.each<[string, string, string]>([
    ['not a function', '({ frame() {} });', 'entry-not-factory'],
    ['a syntax error', '(function (stage) {', 'entry-threw'],
    ['a factory that throws', '(function () { throw 1; });', 'factory-threw'],
    [
      'a factory that returns no object',
      '(function () { return 1; });',
      'handlers-not-object',
    ],
    [
      'a factory that returns an array',
      '(function () { return []; });',
      'handlers-not-object',
    ],
    [
      'an async factory',
      '(async function () { return { frame() {} }; });',
      'handlers-not-object',
    ],
    [
      'a factory reaching for Date.now',
      '(function () { return { t: Date.now() }; });',
      'factory-threw',
    ],
    [
      'a factory reaching for Math.random',
      '(function () { return { r: Math.random() }; });',
      'factory-threw',
    ],
    [
      'a factory reaching for console',
      '(function () { console.log(1); return {}; });',
      'factory-threw',
    ],
    [
      'a factory reaching for fetch',
      "(function () { fetch('x'); return {}; });",
      'factory-threw',
    ],
  ])('入口: an entry that is %s is not ready (%s)', (label, source, reason) => {
    const run = bootCheck(
      process.execPath,
      writeEntry(`${label.replaceAll(' ', '-')}.js`, source),
    );

    expect(run.result.report).toMatchObject({
      type: 'sandbox.failed',
      reason,
      consoleLines: 0,
    });
  });

  it('入口: a stage.log in the factory goes out as a stage.log call, cut to its limit', () => {
    const run = bootCheck(
      process.execPath,
      writeEntry(
        'log.js',
        "(function (stage) { stage.log('hello', 1, { a: 2 }); stage.log('x'.repeat(5000)); return {}; });",
      ),
    );

    expect(run.result.report).toMatchObject({ type: 'sandbox.ready' });
    expect(run.result.posted).toHaveLength(2);
    expect(run.result.posted?.[0]).toStrictEqual({
      type: 'stage.log',
      text: 'hello 1 {"a":2}',
    });
    expect(run.result.posted?.[1]).toStrictEqual({
      type: 'stage.log',
      text: `${'x'.repeat(STAGE_LOG_MAX_LENGTH - 1)}…`,
    });
  });
});
