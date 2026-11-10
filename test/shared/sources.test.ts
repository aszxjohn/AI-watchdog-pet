import { describe, expect, it } from 'vitest';
import {
  SOURCE_CAPABILITIES,
  SOURCE_CODES,
  sourceCodeSchema,
} from '../../src/shared/sources';
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

describe('SOURCE_CAPABILITIES', () => {
  it('has one entry per source, in the same order', () => {
    expect(Object.keys(SOURCE_CAPABILITIES)).toStrictEqual([...SOURCE_CODES]);
  });

  it("follows AD-4's table of what is known to be unreadable", () => {
    expect(SOURCE_CAPABILITIES).toStrictEqual({
      'claude-code': {
        approval: 'exact',
        question: 'exact',
        questionTools: ['AskUserQuestion', 'ExitPlanMode'],
      },
      codex: { approval: 'none', question: 'none', questionTools: [] },
      gemini: { approval: 'none', question: 'exact', questionTools: [] },
      cursor: { approval: 'none', question: 'exact', questionTools: [] },
      copilot: { approval: 'exact', question: 'none', questionTools: [] },
      demo: { approval: 'exact', question: 'exact', questionTools: [] },
    });
  });

  it.each(SOURCE_CODES)('cannot be changed: %s', (source) => {
    const capability = SOURCE_CAPABILITIES[source];
    expect(Object.isFrozen(SOURCE_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.questionTools)).toBe(true);
  });
});
