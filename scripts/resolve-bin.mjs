// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Absolute path of an installed package's bin script, read from the `bin`
 * field of its package.json. Looks the package up along Node's module search
 * paths directly, because some packages (dependency-cruiser) do not export
 * `./package.json`.
 *
 * @param {string} pkg package name
 * @param {string} [name] bin name; defaults to the package name
 * @returns {string}
 */
export function resolveBin(pkg, name = pkg) {
  for (const dir of require.resolve.paths(pkg) ?? []) {
    const manifest = path.join(dir, pkg, 'package.json');
    if (!existsSync(manifest)) {
      continue;
    }
    /** @type {{ bin?: string | Record<string, string> }} */
    const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
    const relative = typeof bin === 'string' ? bin : bin?.[name];
    if (relative === undefined) {
      throw new Error(`${pkg} has no "${name}" bin in ${manifest}`);
    }
    return path.join(dir, pkg, relative);
  }
  throw new Error(`Cannot find package ${pkg}`);
}
