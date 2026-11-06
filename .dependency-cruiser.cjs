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
    // Count `import type` too: a type-only import of src/main from a renderer
    // is still a dependency in the wrong direction.
    tsPreCompilationDeps: true,
  },
};
