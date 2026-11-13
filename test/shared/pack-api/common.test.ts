import { describe, expect, it } from 'vitest';
import {
  ID_PATTERN,
  idSchema,
  LABEL_MAX_LENGTH,
  labelSchema,
  PACK_API_ISSUE_RULES,
} from '../../../src/shared/pack-api';
import { expectRejected, expectRoundTrip } from '../schema-helpers';
import { expectRuleIssue } from './issues';

describe('I/O matrix', () => {
  it.each(['ab', 'a-', '0x'])('id: %s is an id', (id) => {
    expectRoundTrip(idSchema, id);
  });

  it.each([
    ['a', 'one character'],
    ['-a', 'a leading -'],
    ['A1', 'an uppercase letter'],
    ['_x', 'a leading _'],
    ['a'.repeat(65), '65 characters'],
  ])('id: %s is not an id (%s)', (id) => {
    expectRejected(idSchema, id);
  });
});

describe('idSchema', () => {
  it('follows ^[a-z0-9][a-z0-9-]{1,63}$', () => {
    expect(ID_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]{1,63}$');
  });

  it.each([
    ['64 characters', 'a'.repeat(64)],
    ['digits only', '00'],
    ['inner and trailing dashes', 'a--b-'],
  ])('accepts %s', (_label, id) => {
    expectRoundTrip(idSchema, id);
  });

  it.each([
    ['empty', ''],
    ['a space', 'a b'],
    ['a dot', 'a.b'],
    ['a slash', 'a/b'],
    ['an underscore inside', 'a_b'],
    ['a non-ASCII letter', 'aé'],
    ['a trailing newline', 'ab\n'],
    ['a number', 12],
    ['null', null],
  ])('rejects %s', (_label, id) => {
    expectRejected(idSchema, id);
  });
});

describe('labelSchema', () => {
  it.each([
    ['one character', 'x'],
    ['the longest', '字'.repeat(LABEL_MAX_LENGTH)],
    ['inner and outer spaces', ' 探針 甲 '],
  ])('round-trips %s', (_label, value) => {
    expectRoundTrip(labelSchema, value);
  });

  it.each([
    ['empty', ''],
    ['past the longest', 'x'.repeat(LABEL_MAX_LENGTH + 1)],
    ['a number', 1],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(labelSchema, value);
  });

  it.each([
    ['spaces', '   '],
    ['an ideographic space', '　'],
    ['tabs and newlines', '\t\n'],
  ])('rejects a label of only %s as blank-label', (_label, value) => {
    expectRuleIssue(labelSchema, value, 'blank-label', []);
  });
});

describe('PACK_API_ISSUE_RULES', () => {
  it('lists each rule once, in kebab-case', () => {
    expect(new Set(PACK_API_ISSUE_RULES).size).toBe(
      PACK_API_ISSUE_RULES.length,
    );
    for (const rule of PACK_API_ISSUE_RULES) {
      expect(rule).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    }
  });
});
