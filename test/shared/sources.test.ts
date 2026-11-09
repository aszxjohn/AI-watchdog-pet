import { describe, expect, it } from 'vitest';
import { SOURCE_CODES, sourceCodeSchema } from '../../src/shared/sources';
import { expectRejected, expectRoundTrip } from './schema-helpers';

describe('source codes', () => {
  it('are exactly the sources of AD-21', () => {
    expect([...SOURCE_CODES]).toStrictEqual([
      'claude-code',
      'codex',
      'gemini',
      'cursor',
      'copilot',
      'demo',
    ]);
  });
});

describe('sourceCodeSchema', () => {
  it.each(SOURCE_CODES)('round-trips %s', (code) => {
    expectRoundTrip(sourceCodeSchema, code);
  });

  it.each([
    ['an unknown source', 'claude'],
    ['wrong case', 'Codex'],
    ['a display name', 'Claude Code'],
    ['an underscore instead of a hyphen', 'claude_code'],
    ['a session key', 'codex:abc'],
    ['empty string', ''],
    ['number', 0],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expectRejected(sourceCodeSchema, value);
  });
});
