/**
 * Which paths under Gemini CLI's tmp folder the adapter opens and watches
 * (Story 2.6): only `<project>/chats/session-*.jsonl` and
 * `<project>/chats/<id>/*.jsonl`; never the credentials, settings, project
 * lists, `logs.json`, `.project_root` or legacy `session-*.json` beside
 * them. Pure: no file is touched.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chatAt,
  isSessionLog,
  isSubagentLog,
  shouldWatch,
  WATCH_DEPTH,
} from '../../src/main/detection/adapters/gemini/paths';

const root = path.join(path.sep, 'home-dir', '.gemini', 'tmp');
const ID = '0a1b2c3d-0000-4000-8000-00000000abcd';
const LOG = 'session-2026-03-01T10-00-0a1b2c3d.jsonl';
const at = (...parts: string[]) => path.join(root, ...parts);

describe('chatAt', () => {
  it('a session chat log: its project folder', () => {
    expect(chatAt(root, at('gundam', 'chats', LOG))).toStrictEqual({
      kind: 'main',
      project: 'gundam',
    });
  });

  it("a subagent's chat log: its project folder and its parent's id", () => {
    expect(
      chatAt(root, at('gundam', 'chats', ID, 'agent-1.jsonl')),
    ).toStrictEqual({
      kind: 'subagent',
      project: 'gundam',
      parentId: ID,
    });
  });

  it.each([
    ['the root', []],
    ['a project folder', ['gundam']],
    ['the chats folder', ['gundam', 'chats']],
    [
      'a legacy session-*.json',
      ['gundam', 'chats', 'session-2025-01-01T00-00-a.json'],
    ],
    ['a .jsonl not named session-*', ['gundam', 'chats', 'notes.jsonl']],
    ['a bare session-.jsonl', ['gundam', 'chats', 'session-.jsonl']],
    ['logs.json', ['gundam', 'logs.json']],
    ['.project_root', ['gundam', '.project_root']],
    ['a chat log not in chats', ['gundam', 'checkpoints', LOG]],
    ['a chat log at the root', [LOG]],
    ['a subagent file not .jsonl', ['gundam', 'chats', ID, 'agent-1.json']],
    ['too deep', ['gundam', 'chats', ID, 'x', 'agent-1.jsonl']],
  ])('not a chat log: %s', (_label, parts) => {
    expect(chatAt(root, at(...parts))).toBeNull();
  });

  it('not below the root', () => {
    expect(
      chatAt(root, path.join(path.dirname(root), 'oauth_creds.json')),
    ).toBeNull();
    expect(chatAt(root, path.join(root, '..', 'x', 'chats', LOG))).toBeNull();
  });

  it('names', () => {
    expect(isSessionLog(LOG)).toBe(true);
    expect(isSessionLog('session-x.json')).toBe(false);
    expect(isSubagentLog('a.jsonl')).toBe(true);
    expect(isSubagentLog('.jsonl')).toBe(false);
    expect(WATCH_DEPTH).toBe(3);
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

  it('follows the root and the folders chat logs live in', () => {
    for (const entry of [
      root,
      at('gundam'),
      at('gundam', 'chats'),
      at('gundam', 'chats', ID),
    ]) {
      expect(shouldWatch(root, entry, dir, recent)).toBe(true);
      expect(shouldWatch(root, entry, undefined, recent)).toBe(true);
    }
  });

  it('follows chat logs only while they are recent', () => {
    for (const entry of [
      at('gundam', 'chats', LOG),
      at('gundam', 'chats', ID, 'agent-1.jsonl'),
    ]) {
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
    for (const entry of [
      at('gundam', 'chats', LOG),
      at('gundam', 'chats', ID, 'agent-1.jsonl'),
    ]) {
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
    ['logs.json', ['gundam', 'logs.json'], file(100)],
    ['.project_root', ['gundam', '.project_root'], file(100)],
    ['another folder in a project', ['gundam', 'checkpoints'], dir],
    [
      'a legacy chat file',
      ['gundam', 'chats', 'session-2025-01-01T00-00-a.json'],
      file(100),
    ],
    ['another file in chats', ['gundam', 'chats', 'notes.txt'], file(100)],
    ['a file at the root', ['projects.json'], file(100)],
    [
      'a meta file next to a subagent',
      ['gundam', 'chats', ID, 'a.meta.json'],
      file(100),
    ],
    ['anything deeper', ['gundam', 'chats', ID, 'x'], dir],
    ['a chat log name that is a folder', ['gundam', 'chats', LOG], dir],
  ])('leaves alone %s', (_label, parts, stats) => {
    expect(shouldWatch(root, at(...parts), stats, recent)).toBe(false);
  });

  it('leaves alone what is outside the root, the folder holding it included', () => {
    expect(shouldWatch(root, path.dirname(root), dir, recent)).toBe(false);
    expect(
      shouldWatch(
        root,
        path.join(path.dirname(root), 'settings.json'),
        file(100),
        recent,
      ),
    ).toBe(false);
  });
});
