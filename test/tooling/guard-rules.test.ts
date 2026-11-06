/**
 * Reverse tests for the guard rules: every oxlint restriction in
 * .oxlintrc.json and every dependency-cruiser rule in .dependency-cruiser.cjs
 * must fire on a fixture that breaks it. Without these, a rule that silently
 * stops matching (a typo in a glob or regex, an override replacing another)
 * would still let CI pass.
 *
 * Fixtures live in a fresh temp directory with copies of both config files
 * and a fake `node_modules/electron` package (plus fake packages where a rule
 * needs one), so nothing here depends on what is installed in the repo.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBin } from '../../scripts/resolve-bin.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

type Files = Record<string, string>;

function writeTree(root: string, files: Files): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function fakePackage(name: string, extraFiles: Files = {}): Files {
  const files: Files = {
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      version: '0.0.0',
      main: 'index.js',
    }),
    [`node_modules/${name}/index.js`]: 'module.exports = {};\n',
  };
  for (const [file, content] of Object.entries(extraFiles)) {
    files[`node_modules/${name}/${file}`] = content;
  }
  return files;
}

function run(cwd: string, bin: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

let tempRoot: string;

beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'awp-guard-rules-'));
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('oxlint guard rules', () => {
  const ELECTRON_ALL =
    "import { ipcMain, ipcRenderer, net } from 'electron';\nexport { ipcMain, ipcRenderer, net };\n";
  const ZOD = "import { z } from 'zod';\nexport const s = z.string();\n";
  const NETWORK_GLOBALS = [
    'fetch',
    'WebSocket',
    'XMLHttpRequest',
    'EventSource',
  ];
  const NODE_GLOBALS = [
    'Buffer',
    'process',
    'global',
    'setImmediate',
    'clearImmediate',
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
  ];
  const useGlobals = (names: string[]) =>
    names.map((name, i) => `export const g${i} = ${name};\n`).join('');

  let status: number | null;
  let diagnostics: { filename: string; code: string; message: string }[];

  /** Messages of `rule` reported for `file`. */
  function hits(file: string, rule: string): string[] {
    return diagnostics
      .filter((d) => d.filename === file && d.code === `eslint(${rule})`)
      .map((d) => d.message);
  }

  function flags(file: string, rule: string, name: string): boolean {
    return hits(file, rule).some((message) => message.includes(`'${name}'`));
  }

  beforeAll(() => {
    const dir = path.join(tempRoot, 'lint');
    writeTree(dir, {
      'src/main/uses-zod.ts': ZOD,
      'src/main/uses-electron.ts': ELECTRON_ALL,
      'src/main/ipc/register.ts': ELECTRON_ALL + ZOD,
      'src/preload/invoke.ts': ELECTRON_ALL + ZOD,
      'src/preload/stage-view.ts': ELECTRON_ALL + ZOD,
      'src/preload/uses-electron.ts': ELECTRON_ALL,
      'src/shared/zod-setup.ts': ELECTRON_ALL + ZOD,
      'src/panels/uses-network.ts': useGlobals(NETWORK_GLOBALS),
      'src/preload/uses-globals.ts': useGlobals([
        ...NETWORK_GLOBALS,
        ...NODE_GLOBALS,
      ]),
    });
    copyFileSync(
      path.join(REPO_ROOT, '.oxlintrc.json'),
      path.join(dir, '.oxlintrc.json'),
    );

    const result = run(dir, resolveBin('oxlint'), [
      '-c',
      '.oxlintrc.json',
      '--deny-warnings',
      '-f',
      'json',
      'src',
    ]);
    status = result.status;
    diagnostics = (
      JSON.parse(result.stdout) as { diagnostics: typeof diagnostics }
    ).diagnostics.map((d) => ({
      ...d,
      filename: d.filename.replaceAll('\\', '/'),
    }));
  });

  it('exits non-zero', () => {
    expect(status).not.toBe(0);
  });

  it('rejects importing zod anywhere but src/shared/zod-setup.ts', () => {
    for (const file of [
      'src/main/uses-zod.ts',
      'src/main/ipc/register.ts',
      'src/preload/invoke.ts',
      'src/preload/stage-view.ts',
    ]) {
      expect(flags(file, 'no-restricted-imports', 'zod'), file).toBe(true);
    }
    expect(
      flags('src/shared/zod-setup.ts', 'no-restricted-imports', 'zod'),
    ).toBe(false);
  });

  it('allows ipcMain only in src/main/ipc/register.ts', () => {
    for (const file of [
      'src/main/uses-electron.ts',
      'src/preload/invoke.ts',
      'src/preload/stage-view.ts',
      'src/preload/uses-electron.ts',
      'src/shared/zod-setup.ts',
    ]) {
      expect(flags(file, 'no-restricted-imports', 'ipcMain'), file).toBe(true);
    }
    expect(
      flags('src/main/ipc/register.ts', 'no-restricted-imports', 'ipcMain'),
    ).toBe(false);
  });

  it('allows ipcRenderer only in src/preload/invoke.ts and src/preload/stage-view.ts', () => {
    for (const file of [
      'src/main/uses-electron.ts',
      'src/main/ipc/register.ts',
      'src/preload/uses-electron.ts',
      'src/shared/zod-setup.ts',
    ]) {
      expect(flags(file, 'no-restricted-imports', 'ipcRenderer'), file).toBe(
        true,
      );
    }
    for (const file of ['src/preload/invoke.ts', 'src/preload/stage-view.ts']) {
      expect(flags(file, 'no-restricted-imports', 'ipcRenderer'), file).toBe(
        false,
      );
    }
  });

  it("rejects electron's net in every src file", () => {
    for (const file of [
      'src/main/uses-electron.ts',
      'src/main/ipc/register.ts',
      'src/preload/invoke.ts',
      'src/preload/stage-view.ts',
      'src/preload/uses-electron.ts',
      'src/shared/zod-setup.ts',
    ]) {
      expect(flags(file, 'no-restricted-imports', 'net'), file).toBe(true);
    }
  });

  it.each(NETWORK_GLOBALS)(
    'rejects the %s global in src and preloads',
    (name) => {
      expect(
        flags('src/panels/uses-network.ts', 'no-restricted-globals', name),
      ).toBe(true);
      expect(
        flags('src/preload/uses-globals.ts', 'no-restricted-globals', name),
      ).toBe(true);
    },
  );

  it.each(NODE_GLOBALS)('rejects the %s global in preloads', (name) => {
    expect(
      flags('src/preload/uses-globals.ts', 'no-restricted-globals', name),
    ).toBe(true);
  });
});

describe('dependency-cruiser rules', () => {
  const RULES = [
    'shared-depends-on-no-layer',
    'layers-depend-only-on-shared',
    'renderers-not-to-main',
    'src-not-to-prototypes-or-test',
    'src-no-network-modules',
    'preload-only-electron-and-shared',
    'overlay-no-react',
    'react-only-in-panels',
    'web-side-no-node-builtins',
    'web-side-no-electron',
    'not-to-unresolvable',
  ];

  let status: number | null;
  let output: string;
  let violations: { from: string; to: string; rule: { name: string } }[];

  /** Targets that `from` breaks `rule` with. */
  function targets(rule: string, from: string): string[] {
    return violations
      .filter((v) => v.rule.name === rule && v.from === from)
      .map((v) => v.to);
  }

  beforeAll(() => {
    const dir = path.join(tempRoot, 'deps');
    const target = 'export const target = 1;\n';
    const imports = (...specifiers: string[]) =>
      specifiers.map((s) => `import '${s}';\n`).join('');
    writeTree(dir, {
      ...fakePackage('electron'),
      ...fakePackage('fake-pkg'),
      ...fakePackage('react', { 'jsx-runtime.js': 'module.exports = {};\n' }),
      ...fakePackage('react-dom', { 'client.js': 'module.exports = {};\n' }),
      'src/main/target.ts': target,
      'src/overlay/target.ts': target,
      'src/shared/target.ts': target,
      'test/target.ts': target,
      'prototypes/target.ts': target,
      'src/shared/to-main.ts': imports('../main/target'),
      'src/panels/to-overlay.ts': imports('../overlay/target'),
      'src/panels/to-main.ts': imports('../main/target'),
      'src/main/to-test.ts': imports(
        '../../test/target',
        '../../prototypes/target',
      ),
      'src/main/network.ts': imports(
        'http',
        'node:https',
        'http2',
        'net',
        'tls',
        'dgram',
        'dns',
        'node:dns/promises',
        'undici',
      ),
      'src/shared/to-builtin.ts': imports('node:fs'),
      'src/panels/to-electron.ts': imports('electron'),
      'src/preload/to-others.ts': imports('node:path', 'fake-pkg'),
      'src/preload/allowed.ts': imports(
        'electron',
        '../shared/target',
        './to-others',
      ),
      'src/overlay/to-react.ts': imports('react', 'react-dom/client'),
      'src/main/to-react.ts': imports('react', 'react-dom/client'),
      'src/shared/to-react.ts': imports('react/jsx-runtime'),
      'src/panels/uses-react.ts': imports(
        'react',
        'react/jsx-runtime',
        'react-dom/client',
      ),
      'src/main/to-missing.ts': imports('./missing'),
    });
    copyFileSync(
      path.join(REPO_ROOT, '.dependency-cruiser.cjs'),
      path.join(dir, '.dependency-cruiser.cjs'),
    );

    const bin = resolveBin('dependency-cruiser');
    // The default (err) reporter sets the exit code; the json one does not.
    const plain = run(dir, bin, ['--config', '.dependency-cruiser.cjs', 'src']);
    status = plain.status;
    output = plain.stdout + plain.stderr;
    const json = run(dir, bin, [
      '--config',
      '.dependency-cruiser.cjs',
      '--output-type',
      'json',
      'src',
    ]);
    violations = (
      JSON.parse(json.stdout) as { summary: { violations: typeof violations } }
    ).summary.violations;
  });

  it('exits non-zero', () => {
    expect(status).not.toBe(0);
  });

  it.each(RULES)('names %s in its report', (rule) => {
    expect(output).toContain(`${rule}:`);
  });

  it.each([
    [
      'shared-depends-on-no-layer',
      'src/shared/to-main.ts',
      'src/main/target.ts',
    ],
    [
      'layers-depend-only-on-shared',
      'src/panels/to-overlay.ts',
      'src/overlay/target.ts',
    ],
    ['renderers-not-to-main', 'src/panels/to-main.ts', 'src/main/target.ts'],
    ['src-not-to-prototypes-or-test', 'src/main/to-test.ts', 'test/target.ts'],
    [
      'src-not-to-prototypes-or-test',
      'src/main/to-test.ts',
      'prototypes/target.ts',
    ],
    ['web-side-no-node-builtins', 'src/shared/to-builtin.ts', 'fs'],
    [
      'web-side-no-electron',
      'src/panels/to-electron.ts',
      'node_modules/electron/index.js',
    ],
    ['preload-only-electron-and-shared', 'src/preload/to-others.ts', 'path'],
    [
      'preload-only-electron-and-shared',
      'src/preload/to-others.ts',
      'node_modules/fake-pkg/index.js',
    ],
    [
      'overlay-no-react',
      'src/overlay/to-react.ts',
      'node_modules/react/index.js',
    ],
    [
      'overlay-no-react',
      'src/overlay/to-react.ts',
      'node_modules/react-dom/client.js',
    ],
    [
      'react-only-in-panels',
      'src/main/to-react.ts',
      'node_modules/react/index.js',
    ],
    [
      'react-only-in-panels',
      'src/main/to-react.ts',
      'node_modules/react-dom/client.js',
    ],
    [
      'react-only-in-panels',
      'src/shared/to-react.ts',
      'node_modules/react/jsx-runtime.js',
    ],
    [
      'react-only-in-panels',
      'src/overlay/to-react.ts',
      'node_modules/react-dom/client.js',
    ],
    ['not-to-unresolvable', 'src/main/to-missing.ts', './missing'],
  ])('%s: %s -> %s', (rule, from, to) => {
    expect(targets(rule, from)).toContain(to);
  });

  it.each([
    'http',
    'https',
    'http2',
    'net',
    'tls',
    'dgram',
    'dns',
    'dns/promises',
    'undici',
  ])('src-no-network-modules rejects %s', (module) => {
    expect(targets('src-no-network-modules', 'src/main/network.ts')).toContain(
      module,
    );
  });

  it('lets src/panels import react and react-dom', () => {
    expect(
      violations.filter((v) => v.from === 'src/panels/uses-react.ts'),
    ).toStrictEqual([]);
  });

  it('lets a preload import electron, src/shared and other preload files', () => {
    expect(
      violations.filter((v) => v.from === 'src/preload/allowed.ts'),
    ).toStrictEqual([]);
  });
});

describe('JSX placement', () => {
  // Only tsconfig.web.json enables JSX, but the compiler's own
  // `react/jsx-runtime` import never shows up in the source, so
  // dependency-cruiser cannot see it: a .tsx file elsewhere in src/ would
  // slip React past react-only-in-panels and overlay-no-react.
  it('has .tsx files only under src/panels/', () => {
    const tsx = readdirSync(path.join(REPO_ROOT, 'src'), { recursive: true })
      .map((file) => `src/${String(file).replaceAll('\\', '/')}`)
      .filter((file) => file.endsWith('.tsx'));
    expect(tsx.length).toBeGreaterThan(0);
    expect(tsx.filter((file) => !file.startsWith('src/panels/'))).toStrictEqual(
      [],
    );
  });
});

describe('overlay entry', () => {
  // The overlay CSP has no 'unsafe-eval' (AD-24), so PixiJS must load its
  // polyfill before any other PixiJS module builds a shader or a parser with
  // `new Function`; an import above it (formatting, a comment block, a new
  // import sorted first) would break the canvas only at run time.
  it("starts src/overlay/main.ts with import 'pixi.js/unsafe-eval'", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/overlay/main.ts'),
      'utf8',
    );
    const [first] = source.split(/\r?\n/);
    expect(first).toBe("import 'pixi.js/unsafe-eval';");
  });

  it('sets the texture loader preferences before anything loads', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/overlay/main.ts'),
      'utf8',
    );
    expect(source).toContain(
      'Assets.setPreferences({ preferCreateImageBitmap: false });',
    );
    expect(source.indexOf('Assets.setPreferences(')).toBeLessThan(
      source.indexOf('new Application('),
    );
  });
});
