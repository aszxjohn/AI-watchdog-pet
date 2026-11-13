import { expect } from 'vitest';
import type { PackApiIssueRule } from '../../../src/shared/pack-api';
import type { z } from '../../../src/shared/zod-setup';

/** One pack API rule issue: its rule code and where it points. */
export interface RuleIssue {
  readonly rule: unknown;
  readonly path: PropertyKey[];
}

/** The rule issues (zod code `custom`) `schema` reports for `value`. */
export function ruleIssues(schema: z.ZodType, value: unknown): RuleIssue[] {
  const result = schema.safeParse(value);
  expect(result.success, 'the value is rejected').toBe(false);
  return (result.error?.issues ?? [])
    .filter((issue) => issue.code === 'custom')
    .map((issue) => ({
      rule: (issue as { params?: { rule?: unknown } }).params?.rule,
      path: issue.path,
    }));
}

/**
 * `schema` rejects `value` with an issue of `rule`, at `path` when one is
 * given.
 */
export function expectRuleIssue(
  schema: z.ZodType,
  value: unknown,
  rule: PackApiIssueRule,
  path?: PropertyKey[],
): void {
  const issues = ruleIssues(schema, value);
  const ofRule = issues.filter((issue) => issue.rule === rule);
  expect(ofRule.length, JSON.stringify(issues)).toBeGreaterThan(0);
  if (path !== undefined) {
    expect(ofRule.map((issue) => issue.path)).toContainEqual(path);
  }
}
