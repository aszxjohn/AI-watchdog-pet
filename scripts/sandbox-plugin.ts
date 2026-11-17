/**
 * The sandbox document's build (AD-7, Story 3.5): a plugin of the main
 * process's Vite build (vite.main.config.mts), so `npm start` and the
 * packaged app both get the same file, next to main.cjs in `.vite/build/`:
 *
 * - `sandbox.html`: src/sandbox/iframe.ts and worker-bootstrap.ts, each
 *   bundled as a classic script, and SES's `dist/ses.umd.min.js`, put
 *   together by src/sandbox/document.ts into one inline script;
 * - `sandbox-csp.json`: `{ csp, sha256 }`, the policy src/sandbox/csp.ts
 *   builds from that script's SHA-256.
 *
 * main serves the two as `pack://_stage/sandbox.html` and never reads
 * node_modules or src/sandbox at run time (dependency-cruiser keeps
 * src/main from importing src/sandbox). SES's package `exports` do not list
 * its dist files, so the file is found from its package.json's folder.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build, type Plugin } from 'vite';
import { sandboxCsp } from '../src/sandbox/csp';
import {
  composeSandboxDocument,
  IFRAME_BUNDLE_GLOBAL,
  type SandboxDocumentParts,
  WORKER_BUNDLE_GLOBAL,
} from '../src/sandbox/document';
import {
  SANDBOX_CSP_FILE,
  SANDBOX_DOCUMENT_FILE,
} from '../src/shared/constants';

/** What one build of the sandbox document gives. */
export interface SandboxBuild {
  /** `sandbox.html`. */
  readonly html: string;
  /** Its one inline script. */
  readonly script: string;
  /** The SHA-256 of `script` (UTF-8), base64. */
  readonly sha256: string;
  /** The policy for `script`. */
  readonly csp: string;
  /** The bundles and SES, as put together. */
  readonly parts: SandboxDocumentParts;
  /** The source files the bundles were made from (for watch mode). */
  readonly watchFiles: readonly string[];
}

/** SES's `dist/ses.umd.min.js`, read through its package.json's folder. */
function readSes(root: string): {
  readonly code: string;
  readonly file: string;
} {
  const require = createRequire(path.join(root, 'package.json'));
  const file = path.join(
    path.dirname(require.resolve('ses/package.json')),
    'dist',
    'ses.umd.min.js',
  );
  return { code: readFileSync(file, 'utf8'), file };
}

/**
 * `src/sandbox/<file>` bundled as one classic script (IIFE) that defines
 * the global `name`, unminified and without source maps, with the files it
 * was made from.
 */
async function bundle(
  root: string,
  file: string,
  name: string,
): Promise<{ readonly code: string; readonly files: readonly string[] }> {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'warn',
    publicDir: false,
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      sourcemap: false,
      target: 'esnext',
      reportCompressedSize: false,
      lib: {
        entry: path.join(root, 'src', 'sandbox', file),
        formats: ['iife'],
        name,
        fileName: () => `${name}.js`,
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!('output' in output)) {
      continue;
    }
    for (const item of output.output) {
      if (item.type === 'chunk' && item.isEntry) {
        return {
          code: item.code,
          // Vite's module ids use `/`; the platform's separators from here.
          files: item.moduleIds
            .filter((id) => path.isAbsolute(id))
            .map((id) => path.normalize(id)),
        };
      }
    }
  }
  throw new Error(`bundling src/sandbox/${file} gave no entry chunk`);
}

/** Builds the sandbox document from the sources under `root`. */
export async function buildSandboxDocument(
  root: string,
): Promise<SandboxBuild> {
  const [worker, iframe] = await Promise.all([
    bundle(root, 'worker-bootstrap.ts', WORKER_BUNDLE_GLOBAL),
    bundle(root, 'iframe.ts', IFRAME_BUNDLE_GLOBAL),
  ]);
  const ses = readSes(root);
  const parts: SandboxDocumentParts = {
    workerBootstrap: worker.code,
    ses: ses.code,
    iframe: iframe.code,
  };
  const { html, script } = composeSandboxDocument(parts);
  const sha256 = createHash('sha256').update(script, 'utf8').digest('base64');
  return {
    html,
    script,
    sha256,
    csp: sandboxCsp(sha256),
    parts,
    watchFiles: [...new Set([...worker.files, ...iframe.files, ses.file])],
  };
}

/**
 * The plugin: at each build start (each rebuild too, under `npm start`)
 * it builds the document and emits `sandbox.html` and `sandbox-csp.json`
 * into the main build's output folder. A failure fails the build.
 */
export function sandboxDocumentPlugin(): Plugin {
  let root = process.cwd();
  return {
    name: 'awp-sandbox-document',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    async buildStart() {
      const built = await buildSandboxDocument(root);
      for (const file of built.watchFiles) {
        this.addWatchFile(file);
      }
      this.emitFile({
        type: 'asset',
        fileName: SANDBOX_DOCUMENT_FILE,
        source: built.html,
      });
      this.emitFile({
        type: 'asset',
        fileName: SANDBOX_CSP_FILE,
        source: `${JSON.stringify({ csp: built.csp, sha256: built.sha256 }, null, 2)}\n`,
      });
    },
  };
}
