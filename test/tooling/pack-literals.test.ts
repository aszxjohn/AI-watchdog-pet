/**
 * The contract test pack's pack id and character ids must not appear in
 * src/ (Epic 3, NFR7): CI scans every file under src/ for them, ignoring
 * case, `-` and `_`, so `probeOne` and `PROBE_ONE` count as `probe-one`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestSchema } from '../../src/shared/pack-api';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** The contract pack's pack id, then its character ids. */
function contractPackIds(): string[] {
  const manifest = manifestSchema.parse(
    JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          'test/packs/contract-pack/contract-pack/manifest.json',
        ),
        'utf8',
      ),
    ),
  );
  return [manifest.id, ...manifest.characters.map((character) => character.id)];
}

/** One place a text contains one of the literals looked for. */
interface LiteralHit {
  readonly literal: string;
  /** 1-based. */
  readonly line: number;
}

/** `text` in lower case without `-` and `_`. */
function loose(text: string): string {
  return text.toLowerCase().replaceAll(/[-_]/g, '');
}

/**
 * Every line of `text` that contains one of `literals`, per literal,
 * compared without case, `-` and `_`.
 */
function findLiterals(text: string, literals: readonly string[]): LiteralHit[] {
  return text.split(/\r?\n/).flatMap((content, i) => {
    const line = loose(content);
    return literals
      .filter((literal) => line.includes(loose(literal)))
      .map((literal) => ({ literal, line: i + 1 }));
  });
}

/** Every file under `dir`, as a `/`-separated path from the repo root. */
function filesUnder(dir: string): string[] {
  return readdirSync(path.join(REPO_ROOT, dir), { recursive: true })
    .map((file) => `${dir}/${String(file).replaceAll('\\', '/')}`)
    .filter((file) => statSync(path.join(REPO_ROOT, file)).isFile());
}

describe('I/O matrix', () => {
  it('掃描: no file under src/ contains the contract pack id or a character id', () => {
    const ids = contractPackIds();
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const files = filesUnder('src');
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((file) =>
      findLiterals(readFileSync(path.join(REPO_ROOT, file), 'utf8'), ids).map(
        ({ literal, line }) => `${file}:${line}: ${literal}`,
      ),
    );
    expect(hits).toStrictEqual([]);
  });

  it('掃描本身: findLiterals reports a text with one of the ids (also as camelCase or UPPER_SNAKE), at its line, and nothing for a text without', () => {
    const ids = contractPackIds();
    for (const id of ids) {
      const camel = id.replaceAll(/-([a-z0-9])/g, (_, c: string) =>
        c.toUpperCase(),
      );
      const upperSnake = id.toUpperCase().replaceAll('-', '_');
      expect(
        findLiterals(
          `// first line\nconst key = '${id}/x';\nconst ${camel} = 1;\nconst ${upperSnake} = 2;\n`,
          ids,
        ),
      ).toStrictEqual([2, 3, 4].map((line) => ({ literal: id, line })));
    }
    expect(
      findLiterals('const ids = ["probe", "contract", "pack-one"];', ids),
    ).toStrictEqual([]);
  });
});
