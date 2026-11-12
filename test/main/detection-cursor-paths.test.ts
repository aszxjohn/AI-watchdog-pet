/**
 * Which paths under Cursor's projects folder the adapter opens and watches
 * (Story 2.7): only `<slug>/agent-transcripts/<id>/<id>.jsonl` and
 * `<slug>/agent-transcripts/<id>/subagents/*.jsonl`; never the files beside
 * the project folders, nor a project's canvases, MCP descriptions, assets,
 * agent tools or terminals. Pure: no file is touched.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isSubagentTranscript,
  sessionTranscriptName,
  shouldWatch,
  transcriptAt,
  WATCH_DEPTH,
} from '../../src/main/detection/adapters/cursor/paths';

const root = path.join(path.sep, 'home-dir', '.cursor', 'projects');
const SLUG = 'home-dir-code-gundam-pet';
const ID = '0a1b2c3d-0000-4000-8000-00000000abcd';
const SUB = '9f8e7d6c-0000-4000-8000-00000000dcba';
const AT = 'agent-transcripts';
const at = (...parts: string[]) => path.join(root, ...parts);

describe('transcriptAt', () => {
  it("a session's transcript: its slug and id", () => {
    expect(transcriptAt(root, at(SLUG, AT, ID, `${ID}.jsonl`))).toStrictEqual({
      kind: 'main',
      slug: SLUG,
      id: ID,
    });
  });

  it("a subagent's transcript: its slug and its session's id", () => {
    expect(
      transcriptAt(root, at(SLUG, AT, ID, 'subagents', `${SUB}.jsonl`)),
    ).toStrictEqual({ kind: 'subagent', slug: SLUG, id: ID });
  });

  it.each([
    ['the root', []],
    ['a project folder', [SLUG]],
    ['the agent-transcripts folder', [SLUG, AT]],
    ['a session folder', [SLUG, AT, ID]],
    ['a subagents folder', [SLUG, AT, ID, 'subagents']],
    ['a transcript named after another id', [SLUG, AT, ID, `${SUB}.jsonl`]],
    ['a transcript not in its folder', [SLUG, AT, `${ID}.jsonl`]],
    ['a legacy .txt transcript', [SLUG, AT, ID, `${ID}.txt`]],
    ['a subagent file not .jsonl', [SLUG, AT, ID, 'subagents', `${SUB}.json`]],
    ['a bare .jsonl subagent', [SLUG, AT, ID, 'subagents', '.jsonl']],
    ['too deep', [SLUG, AT, ID, 'subagents', 'x', `${SUB}.jsonl`]],
    ['a canvas', [SLUG, 'canvases', ID, `${ID}.jsonl`]],
    ['an MCP description', [SLUG, 'mcps', 'x', 'tools.jsonl']],
    ['a terminal', [SLUG, 'terminals', '1.txt']],
    ['agent tools', [SLUG, 'agent-tools', ID, `${ID}.jsonl`]],
    ['a file at the root', ['cli-config.json']],
  ])('not a transcript: %s', (_label, parts) => {
    expect(transcriptAt(root, at(...parts))).toBeNull();
  });

  it('not below the root', () => {
    expect(
      transcriptAt(root, path.join(path.dirname(root), 'argv.json')),
    ).toBeNull();
    expect(
      transcriptAt(root, path.join(root, '..', 'x', AT, ID, `${ID}.jsonl`)),
    ).toBeNull();
  });

  it('names', () => {
    expect(sessionTranscriptName(ID)).toBe(`${ID}.jsonl`);
    expect(isSubagentTranscript('a.jsonl')).toBe(true);
    expect(isSubagentTranscript('.jsonl')).toBe(false);
    expect(isSubagentTranscript('a.json')).toBe(false);
    expect(WATCH_DEPTH).toBe(4);
  });
});

describe('shouldWatch', () => {
  const file = (mtimeMs: number) => ({
    isFile: () => true,
    isDirectory: () => false,
    mtimeMs,
  });
  const dir = { isFile: () => false, isDirectory: () => true, mtimeMs: 0 };
  const recent = (mtimeMs: number) => mtimeMs >= 100;
  const transcripts = [
    at(SLUG, AT, ID, `${ID}.jsonl`),
    at(SLUG, AT, ID, 'subagents', `${SUB}.jsonl`),
  ];

  it('follows the root and the folders transcripts live in', () => {
    for (const entry of [
      root,
      at(SLUG),
      at(SLUG, AT),
      at(SLUG, AT, ID),
      at(SLUG, AT, ID, 'subagents'),
    ]) {
      expect(shouldWatch(root, entry, dir, recent)).toBe(true);
      expect(shouldWatch(root, entry, undefined, recent)).toBe(true);
    }
  });

  it('follows transcripts only while they are recent', () => {
    for (const entry of transcripts) {
      expect(shouldWatch(root, entry, file(100), recent)).toBe(true);
      expect(shouldWatch(root, entry, file(99), recent)).toBe(false);
      // Asked by name first: kept until the stats say otherwise.
      expect(shouldWatch(root, entry, undefined, recent)).toBe(true);
    }
  });

  it('takes the BigInt modification time chokidar gives on Windows', () => {
    // readdirp asks for BigInt stats on Windows; mixing a BigInt with the
    // numbers recent() compares would throw a TypeError and stop the
    // watcher's first scan.
    const bigFile = (mtimeMs: bigint) => ({
      isFile: () => true,
      isDirectory: () => false,
      mtimeMs,
    });
    for (const entry of transcripts) {
      expect(shouldWatch(root, entry, bigFile(100n), recent)).toBe(true);
      expect(shouldWatch(root, entry, bigFile(99n), recent)).toBe(false);
      expect(
        shouldWatch(
          root,
          entry,
          bigFile(100n),
          (mtimeMs) => Date.now() - mtimeMs < 1,
        ),
      ).toBe(false);
    }
  });

  it.each([
    ['a file at the root', ['cli-config.json'], file(100)],
    ['another folder in a project', [SLUG, 'canvases'], dir],
    ['the MCP descriptions', [SLUG, 'mcps'], dir],
    ['the terminals', [SLUG, 'terminals'], dir],
    ['the agent tools', [SLUG, 'agent-tools'], dir],
    ['a file in a project folder', [SLUG, 'repo.json'], file(100)],
    ['a file in agent-transcripts', [SLUG, AT, `${ID}.jsonl`], file(100)],
    [
      'another file in a session folder',
      [SLUG, AT, ID, `${ID}.txt`],
      file(100),
    ],
    ['another folder in a session folder', [SLUG, AT, ID, 'assets'], dir],
    ['anything deeper', [SLUG, AT, ID, 'subagents', 'x'], dir],
    ['a transcript name that is a folder', [SLUG, AT, ID, `${ID}.jsonl`], dir],
  ])('leaves alone %s', (_label, parts, stats) => {
    expect(shouldWatch(root, at(...parts), stats, recent)).toBe(false);
  });

  it('leaves alone what is outside the root, the folder holding it included', () => {
    expect(shouldWatch(root, path.dirname(root), dir, recent)).toBe(false);
    expect(
      shouldWatch(
        root,
        path.join(path.dirname(root), 'statsig-cache.json'),
        file(100),
        recent,
      ),
    ).toBe(false);
  });
});
