import { expect } from 'vitest';
import type { z } from '../../src/shared/zod-setup';

/**
 * Round trip: the value survives Electron's IPC serialization (structured
 * clone) and parses back to an equal value.
 */
export function expectRoundTrip(schema: z.ZodType, value: unknown): void {
  const parsed = schema.safeParse(structuredClone(value));
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  expect(parsed.data).toStrictEqual(value);
}

export function expectRejected(schema: z.ZodType, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}
