import { describe, expect, it } from 'vitest';
import { cutText } from '../../src/shared/text';

describe('cutText', () => {
  it('leaves a text that fits as it is', () => {
    expect(cutText('abc', 3)).toBe('abc');
    expect(cutText('', 0)).toBe('');
  });

  it('cuts a longer one to max, ending with …', () => {
    expect(cutText('abcdef', 4)).toBe('abc…');
    expect(cutText('abcdef', 4)).toHaveLength(4);
    expect(cutText('abcdef', 1)).toBe('…');
    expect(cutText('abcdef', 0)).toBe('');
  });

  it('never leaves half of a surrogate pair', () => {
    // 'a' + 😀 (two code units) + 'b': cutting at 3 would split the emoji.
    expect(cutText('a😀b', 3)).toBe('a…');
    expect(cutText('a😀bc', 4)).toBe('a😀…');
  });
});
