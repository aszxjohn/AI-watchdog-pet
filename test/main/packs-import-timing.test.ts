/**
 * How long checking and installing a pack near the import limits takes
 * (Story 3.2, the measurement put off from the first half's review, B11).
 * Opt-in, since it unpacks and writes about 64 MiB twice:
 *
 *   AWP_MEASURE_IMPORT=1 npx vitest run test/main/packs-import-timing.test.ts
 *
 * It prints the times; it asserts only that the packs install, never how
 * fast (that depends on the machine). The results are in the 3.2 spec's
 * Implementation Notes.
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPack } from '../../src/main/packs/inspect';
import { installPack } from '../../src/main/packs/install';
import { loadPacks } from '../../src/main/packs/store';
import {
  PACK_IMPORT_MAX_FILES,
  PACK_IMPORT_MAX_TOTAL_BYTES,
} from '../../src/shared/constants';
import { contractPackFiles, itemsOf, zipBuffer } from '../helpers/awpet';

vi.mock('electron', () => import('../helpers/fake-electron'));

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-import-timing-'));
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function total(files: ReadonlyMap<string, Buffer>): number {
  let bytes = 0;
  for (const data of files.values()) {
    bytes += data.length;
  }
  return bytes;
}

/** The contract pack with filler files up to the file count and nearly the size limit. */
function manyFiles(): Map<string, Buffer> {
  const files = contractPackFiles();
  const fillers = PACK_IMPORT_MAX_FILES - files.size;
  const room = PACK_IMPORT_MAX_TOTAL_BYTES - total(files) - 64 * 1024;
  const each = Math.floor(room / fillers);
  for (let i = 0; i < fillers; i += 1) {
    files.set(`filler/f${i}.bin`, randomBytes(each));
  }
  return files;
}

/** The contract pack with its entry grown to nearly the size limit. */
function bigEntry(): Map<string, Buffer> {
  const files = contractPackFiles();
  const entry = files.get('entry.js') ?? Buffer.alloc(0);
  const room = PACK_IMPORT_MAX_TOTAL_BYTES - total(files) - 64 * 1024;
  const lines: string[] = [];
  let bytes = 0;
  for (let i = 0; bytes < room; i += 1) {
    const line = `function f${i}(a){return a+${i}}\n`;
    lines.push(line);
    bytes += line.length;
  }
  lines.pop();
  files.set('entry.js', Buffer.concat([Buffer.from(lines.join('')), entry]));
  return files;
}

describe.skipIf(process.env.AWP_MEASURE_IMPORT !== '1')(
  'checking and installing a pack near the limits',
  () => {
    it.each([
      ['512 files, about 64 MiB of filler', manyFiles],
      ['an entry of about 64 MiB of functions', bigEntry],
    ])(
      '%s',
      async (label, build) => {
        const files = build();
        const awpet = path.join(root, 'big.awpet');
        fs.writeFileSync(awpet, await zipBuffer(itemsOf(files)));
        const store = loadPacks({ dir: path.join(root, 'packs') });

        const checking = performance.now();
        const inspection = await inspectPack(awpet, store);
        const checked = performance.now();
        if (!inspection.ok) {
          throw new Error(JSON.stringify(inspection.rejection));
        }
        const result = installPack(store, inspection.plan);
        const installed = performance.now();

        expect(result.ok).toBe(true);
        process.stdout.write(
          `[timing] ${label}: ${files.size} files, ${(total(files) / 1024 / 1024).toFixed(1)} MiB unpacked, ${(fs.statSync(awpet).size / 1024 / 1024).toFixed(1)} MiB zipped; inspectPack ${Math.round(checked - checking)} ms, installPack ${Math.round(installed - checked)} ms\n`,
        );
      },
      120_000,
    );
  },
);
