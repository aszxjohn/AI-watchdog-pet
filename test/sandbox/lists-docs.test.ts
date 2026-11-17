/**
 * The removal lists (src/sandbox/lists.ts) and the pack author docs
 * (docs/pack-api-v1.md, section 10, 「已移除」) name the same things
 * (Story 3.5): the docs' two lines under 「已移除」 each list one of the two
 * lists, in backticks. Changing either side alone fails here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REMOVED_WORKER_APIS,
  SES_UNKNOWN_INTRINSICS,
} from '../../src/sandbox/lists';

const DOCS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'pack-api-v1.md',
);

/** The heading of the section, and the label of the list in it. */
const SECTION_HEADING = /^## 10\. /;
const REMOVED_LABEL = '**已移除：**';

/**
 * The names in backticks on each line of the list under 「已移除」 in
 * section 10 of `markdown`, one array per line. Throws when the section
 * or the label is missing.
 */
function removedLinesOf(markdown: string): string[][] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex((line) => SECTION_HEADING.test(line));
  if (start < 0) {
    throw new Error('docs/pack-api-v1.md has no section 10');
  }
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => line.startsWith('## '));
  const section = end < 0 ? after : after.slice(0, end);
  const label = section.indexOf(REMOVED_LABEL);
  if (label < 0) {
    throw new Error(`section 10 has no ${REMOVED_LABEL}`);
  }
  const rest = section.slice(label + 1);
  const first = rest.findIndex((line) => line.trim() !== '');
  const items: string[][] = [];
  for (const line of rest.slice(first)) {
    if (!line.startsWith('- ')) {
      break;
    }
    items.push([...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ''));
  }
  return items;
}

/** Each line's names sorted, so the order on a line does not count. */
function sortedLines(lines: readonly (readonly string[])[]): string[][] {
  return lines.map((names) => [...names].sort());
}

/** The two removal lists as src/sandbox/lists.ts has them. */
const LISTS: readonly (readonly string[])[] = [
  SES_UNKNOWN_INTRINSICS,
  REMOVED_WORKER_APIS,
];

/** Whether `doc` lists exactly the `lists`, a line each. */
function matchesLists(
  doc: readonly (readonly string[])[],
  lists: readonly (readonly string[])[],
): boolean {
  const expected = sortedLines(lists);
  const actual = sortedLines(doc);
  return (
    actual.length === expected.length &&
    expected.every((list) =>
      actual.some((line) => JSON.stringify(line) === JSON.stringify(list)),
    )
  );
}

const MARKDOWN = fs.readFileSync(DOCS, 'utf8');

describe('I/O matrix', () => {
  it('清單與文件: section 10 「已移除」 lists the two removal lists, one line each, with the same names', () => {
    const doc = removedLinesOf(MARKDOWN);

    expect(doc).toHaveLength(2);
    expect(sortedLines(doc)).toEqual(
      expect.arrayContaining(sortedLines(LISTS)),
    );
    expect(matchesLists(doc, LISTS)).toBe(true);
    for (const names of doc) {
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it.each<[string, (markdown: string) => string]>([
    [
      'a name dropped from the docs',
      (markdown) => markdown.replace('、`caches`', ''),
    ],
    [
      'a name added to the docs',
      (markdown) =>
        markdown.replace('`caches`', '`caches`、`BroadcastChannel`'),
    ],
    [
      'a name renamed in the docs',
      (markdown) =>
        markdown.replace(
          '`Iterator.prototype.includes`',
          '`Iterator.prototype.find`',
        ),
    ],
    [
      'a third line under 「已移除」',
      (markdown) =>
        markdown.replace(
          '`indexedDB`、`caches`。',
          '`indexedDB`、`caches`。\n- `WeakRef`：另外拿掉。',
        ),
    ],
  ])('清單與文件: %s no longer matches the lists', (_label, change) => {
    const changed = change(MARKDOWN);

    expect(changed).not.toBe(MARKDOWN);
    expect(matchesLists(removedLinesOf(changed), LISTS)).toBe(false);
  });

  it.each<[string, readonly (readonly string[])[]]>([
    [
      'a list has one more name',
      [SES_UNKNOWN_INTRINSICS, [...REMOVED_WORKER_APIS, 'BroadcastChannel']],
    ],
    [
      'a list lacks a name',
      [SES_UNKNOWN_INTRINSICS.slice(1), REMOVED_WORKER_APIS],
    ],
  ])(
    '清單與文件: %s, the docs unchanged, no longer matches',
    (_label, lists) => {
      expect(matchesLists(removedLinesOf(MARKDOWN), lists)).toBe(false);
    },
  );
});
