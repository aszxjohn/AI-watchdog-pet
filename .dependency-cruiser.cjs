// Dependency rules (AD-2) and the static half of "no network" (AD-26, NFR5).
// `npm run depcruise` fails on any violation.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'shared-depends-on-no-layer',
      comment:
        'src/shared is the contract layer: it must not depend on any other layer (AD-2).',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/', pathNot: '^src/shared/' },
    },
    {
      name: 'pack-api-only-zod-setup-and-states',
      comment:
        'The character pack API contract depends on nothing but zod (through zod-setup) and the state codes (Story 3.1): no other src/shared module, no other package, no Node built-in.',
      severity: 'error',
      from: { path: '^src/shared/pack-api/' },
      to: {
        pathNot: [
          '^src/shared/pack-api/',
          '^src/shared/zod-setup\\.ts$',
          '^src/shared/states\\.ts$',
        ],
      },
    },
    {
      name: 'layers-depend-only-on-shared',
      comment:
        'main, preload, overlay, panels and sandbox may depend on their own folder and src/shared only (AD-2).',
      severity: 'error',
      from: { path: '^src/(main|preload|overlay|panels|sandbox)/' },
      to: { path: '^src/', pathNot: ['^src/$1/', '^src/shared/'] },
    },
    {
      name: 'renderers-not-to-main',
      comment:
        'overlay and panels reach main only through their preload API, never by importing src/main (AD-2).',
      severity: 'error',
      from: { path: '^src/(overlay|panels)/' },
      to: { path: '^src/main/' },
    },
    {
      name: 'src-not-to-prototypes-or-test',
      comment: 'Code in src/ must not import prototypes/ or test/.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^(prototypes|test)/' },
    },
    {
      name: 'src-no-network-modules',
      comment:
        'The app never makes network requests (AD-26, NFR5): src/ must not import Node network modules.',
      severity: 'error',
      from: { path: '^src/' },
      // Node core modules plus the undici package (resolved or not).
      to: {
        path: [
          '^(node:)?(http|https|http2|net|tls|dgram|dns|undici)(/|$)',
          '^node_modules/undici/',
        ],
      },
    },
    {
      name: 'adapters-no-processes-or-electron',
      comment:
        "Adapters only read the AI tools' records (AD-21, Story 2.4): src/main/detection/adapters must not run commands or other processes or threads (child_process, worker_threads, cluster), nor reach Electron.",
      severity: 'error',
      from: { path: '^src/main/detection/adapters/' },
      to: {
        path: [
          '^(node:)?(child_process|worker_threads|cluster)$',
          '^(node_modules/)?electron(/|$)',
        ],
      },
    },
    {
      name: 'jsonl-core-not-to-source-adapters',
      comment:
        "The shared JSON Lines adapter core is source-agnostic (Story 2.6): src/main/detection/adapters/jsonl must not import any source's adapter folder; each source hands its own rules in as options.",
      severity: 'error',
      from: { path: '^src/main/detection/adapters/jsonl/' },
      to: {
        path: '^src/main/detection/adapters/',
        pathNot: '^src/main/detection/adapters/jsonl/',
      },
    },
    {
      name: 'detection-not-to-pool',
      comment:
        'main/detection does not depend on main/pool (Story 2.8): the pool hears the start-up sync through main.ts, and releases never join the sections detection owns.',
      severity: 'error',
      from: { path: '^src/main/detection/' },
      to: { path: '^src/main/pool/' },
    },
    {
      name: 'persist-not-to-owners',
      comment:
        'main/persist is the file handling main/settings and main/pool share (Story 2.8): it must not depend on either of them.',
      severity: 'error',
      from: { path: '^src/main/persist/' },
      to: { path: '^src/main/(settings|pool)/' },
    },
    {
      name: 'preload-only-electron-and-shared',
      comment:
        'Sandboxed preloads can load only electron and their own bundle (AD-2, AD-24): no Node built-ins, no other packages.',
      severity: 'error',
      from: { path: '^src/preload/' },
      to: { pathNot: ['^src/(preload|shared)/', '^node_modules/electron/'] },
    },
    {
      name: 'overlay-no-react',
      comment: 'The overlay canvas does not use React (AD-9).',
      severity: 'error',
      from: { path: '^src/overlay/' },
      to: { path: '^(node_modules/)?(react|react-dom)(/|$)' },
    },
    {
      name: 'react-only-in-panels',
      comment:
        'React and react-dom are used in src/panels only (Story 1.5): main, preload, shared, overlay and sandbox never import them.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/panels/' },
      to: { path: '^(node_modules/)?(react|react-dom)(/|$)' },
    },
    {
      name: 'web-side-no-node-builtins',
      comment:
        'shared, overlay, panels and sandbox also run in renderers, where Node built-ins do not exist.',
      severity: 'error',
      from: { path: '^src/(shared|overlay|panels|sandbox)/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'web-side-no-electron',
      comment:
        'Only main and the preloads import electron (AD-2). It would also pull Node types into tsconfig.web.json.',
      severity: 'error',
      from: { path: '^src/(shared|overlay|panels|sandbox)/' },
      to: { path: '^node_modules/electron/' },
    },
    {
      name: 'no-circular',
      comment:
        'No import cycles between files in src/, type-only imports included (tsPreCompilationDeps below) (Epic 1 retro R5). It sees file-level cycles only; the direction between main/ipc and main/windows is held by main-ipc-only-windows-environment.',
      severity: 'error',
      from: { path: '^src/' },
      to: { circular: true },
    },
    {
      name: 'main-ipc-only-windows-environment',
      comment:
        'main/windows builds on main/ipc (it registers its own handlers), so main/ipc may import from main/windows only environment.ts, the one place that knows which renderer a URL is (Epic 1 retro R5).',
      severity: 'error',
      from: { path: '^src/main/ipc/' },
      to: {
        path: '^src/main/windows/',
        pathNot: '^src/main/windows/environment\\.ts$',
      },
    },
    {
      name: 'not-to-unresolvable',
      comment:
        'An import that cannot be resolved would slip past the path rules above.',
      severity: 'error',
      from: { path: '^src/' },
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Resolve package subpaths through their `exports` map, for every layer
    // alike, matching the first of the `import`, `require`, `node` or
    // `default` conditions a package lists. dependency-cruiser ignores
    // `exports` by default, and `pixi.js/unsafe-eval` (the overlay's first
    // import) exists only there, so it would be reported as unresolvable.
    // This is not the per-target resolution Vite does (it would pick
    // `browser` entries for renderers), but the rules below only look at
    // which package or folder an import lands in, and that is the same
    // whichever condition matches; `doNotFollow` keeps cruising out of
    // node_modules.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    // Count `import type` too: a type-only import of src/main from a renderer
    // is still a dependency in the wrong direction.
    tsPreCompilationDeps: true,
  },
};
