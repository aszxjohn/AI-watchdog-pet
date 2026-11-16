/**
 * main/packs' small helpers (Story 3.2): ordering pack versions (to tell a
 * downgrade) and reading a PNG's size from its header.
 */
import { describe, expect, it } from 'vitest';
import { pngSize } from '../../src/main/packs/png';
import { comparePackVersions } from '../../src/main/packs/version';
import { contractPackFiles, pngHeader } from '../helpers/awpet';

describe('comparePackVersions', () => {
  it.each<[string, string, number]>([
    ['1.0.0', '1.0.0', 0],
    ['1.0.0', '1.0.1', -1],
    ['1.0.1', '1.0.0', 1],
    ['1.9.0', '1.10.0', -1],
    ['2.0.0', '1.99.99', 1],
    ['0.0.9', '0.1.0', -1],
    ['10.0.0', '9.0.0', 1],
    // Past Number.MAX_SAFE_INTEGER: compared as digits, not as numbers.
    ['1.0.9007199254740993', '1.0.9007199254740992', 1],
    ['99999999999999999999.0.0', '99999999999999999998.9.9', 1],
  ])('%s against %s is %i', (a, b, sign) => {
    expect(Math.sign(comparePackVersions(a, b))).toBe(sign);
  });
});

describe('pngSize', () => {
  it("reads the contract pack's PNGs", () => {
    const files = contractPackFiles();
    expect(pngSize(files.get('img/probe-one-plain.png')!)).toStrictEqual({
      width: 2,
      height: 2,
    });
    expect(pngSize(files.get('img/probe-two-sheet.png')!)).toStrictEqual({
      width: 4,
      height: 2,
    });
  });

  it('reads a header alone, at any offset into a larger buffer', () => {
    const header = pngHeader(4096, 300);
    const inside = Buffer.concat([Buffer.alloc(5), header]).subarray(5);

    expect(pngSize(header)).toStrictEqual({ width: 4096, height: 300 });
    expect(pngSize(inside)).toStrictEqual({ width: 4096, height: 300 });
  });

  it.each<[string, Uint8Array]>([
    ['empty', new Uint8Array(0)],
    ['too short', pngHeader(1, 1).subarray(0, 23)],
    [
      'a wrong signature',
      Buffer.concat([Buffer.from('GIF89a..'), pngHeader(1, 1).subarray(8)]),
    ],
    [
      'a first chunk that is not IHDR',
      Buffer.from(pngHeader(1, 1)).fill(0x41, 12, 16),
    ],
    [
      'an IHDR of the wrong length',
      (() => {
        const data = Buffer.from(pngHeader(1, 1));
        data.writeUInt32BE(12, 8);
        return data;
      })(),
    ],
    ['0 pixels wide', pngHeader(0, 1)],
    ['0 pixels high', pngHeader(1, 0)],
  ])('answers null for %s', (_label, data) => {
    expect(pngSize(data)).toBeNull();
  });
});
