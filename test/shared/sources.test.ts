import { describe, expect, it } from 'vitest';
import {
  ADAPTER_HEALTH_CODES,
  ADAPTER_HEALTH_DISPLAY_NAMES,
  adapterHealthSchema,
  DEMO_MODE_LABEL,
  SOURCE_CAPABILITIES,
  SOURCE_CODES,
  SOURCE_DISPLAY_NAMES,
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
    const none = { questionTools: [], noInferTools: [] };
    expect(SOURCE_CAPABILITIES).toStrictEqual({
      'claude-code': {
        approval: 'none',
        question: 'none',
        questionTools: ['AskUserQuestion', 'ExitPlanMode'],
        noInferTools: [
          'Agent',
          'Task',
          'Workflow',
          'WebSearch',
          'Monitor',
          'TaskOutput',
          'ScheduleWakeup',
        ],
      },
      codex: { approval: 'none', question: 'none', ...none },
      gemini: { approval: 'none', question: 'exact', ...none },
      cursor: { approval: 'none', question: 'exact', ...none },
      copilot: { approval: 'exact', question: 'none', ...none },
      demo: { approval: 'exact', question: 'exact', ...none },
    });
  });

  it.each(SOURCE_CODES)('cannot be changed: %s', (source) => {
    const capability = SOURCE_CAPABILITIES[source];
    expect(Object.isFrozen(SOURCE_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.questionTools)).toBe(true);
    expect(Object.isFrozen(capability.noInferTools)).toBe(true);
  });
});

describe('SOURCE_DISPLAY_NAMES', () => {
  it('names every source, in the same order; demo is 示範', () => {
    expect(Object.keys(SOURCE_DISPLAY_NAMES)).toStrictEqual([...SOURCE_CODES]);
    expect(SOURCE_DISPLAY_NAMES).toStrictEqual({
      'claude-code': 'Claude Code',
      codex: 'Codex CLI',
      gemini: 'Gemini CLI',
      cursor: 'Cursor',
      copilot: 'Copilot CLI',
      demo: '示範',
    });
    expect(Object.isFrozen(SOURCE_DISPLAY_NAMES)).toBe(true);
  });

  it('calls demo mode 示範模式', () => {
    expect(DEMO_MODE_LABEL).toBe('示範模式');
  });

  it('gives each source a different name', () => {
    const names = Object.values(SOURCE_DISPLAY_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('adapter health', () => {
  it('has exactly the codes ok, degraded and missing', () => {
    expect([...ADAPTER_HEALTH_CODES]).toStrictEqual([
      'ok',
      'degraded',
      'missing',
    ]);
  });

  it.each(ADAPTER_HEALTH_CODES)('round-trips %s', (code) => {
    expectRoundTrip(adapterHealthSchema, code);
  });

  it.each([
    ['an unknown code', 'broken'],
    ['a display name', '正常'],
    ['wrong case', 'OK'],
    ['empty string', ''],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expectRejected(adapterHealthSchema, value);
  });

  it('names each code in Chinese: 正常, 部分可用, 找不到', () => {
    expect(Object.keys(ADAPTER_HEALTH_DISPLAY_NAMES)).toStrictEqual([
      ...ADAPTER_HEALTH_CODES,
    ]);
    expect(ADAPTER_HEALTH_DISPLAY_NAMES).toStrictEqual({
      ok: '正常',
      degraded: '部分可用',
      missing: '找不到',
    });
    expect(Object.isFrozen(ADAPTER_HEALTH_DISPLAY_NAMES)).toBe(true);
  });
});
