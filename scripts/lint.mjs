// @ts-check
/**
 * `npm run lint` / `npm run lint:fix`, on macOS and Windows alike.
 *
 * oxlint does not expand globs, and neither does Windows cmd, so this script
 * builds the target list itself: the code folders plus every JS/TS config
 * file at the repo root. A new root config file is picked up without editing
 * any list. Each tool runs through `node <its bin script>` (path read from the
 * package's `bin` field), which needs no shell and no `.cmd` shim.
 *
 *   node scripts/lint.mjs         oxlint --deny-warnings, then oxfmt --check
 *   node scripts/lint.mjs --fix   oxlint --fix, then oxfmt --write
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBin } from './resolve-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_DIRS = ['src', 'test', 'prototypes', 'scripts'];
const ROOT_CONFIG_FILE = /\.(?:[cm]?[jt]s)$/;

const fix = process.argv.slice(2).includes('--fix');

const rootConfigFiles = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isFile() && ROOT_CONFIG_FILE.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const targets = [
  ...CODE_DIRS.filter((dir) => existsSync(path.join(ROOT, dir))),
  ...rootConfigFiles,
];

/**
 * @param {string} pkg
 * @param {string[]} args
 * @returns {boolean} whether the tool exited with 0
 */
function run(pkg, args) {
  const result = spawnSync(process.execPath, [resolveBin(pkg), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`[lint] cannot run ${pkg}:`, result.error);
    return false;
  }
  return result.status === 0;
}

const linted = fix
  ? run('oxlint', ['--fix', ...targets])
  : run('oxlint', ['--deny-warnings', ...targets]);
const formatted = run('oxfmt', [fix ? '--write' : '--check', ...targets]);

process.exitCode = linted && formatted ? 0 : 1;
