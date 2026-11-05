import { describe, expect, it } from 'vitest';
import { z } from '../../src/shared/zod-setup';

describe('zod-setup', () => {
  it('sets jitless on the z that every shared module uses', () => {
    expect(z.config().jitless).toBe(true);
  });
});
