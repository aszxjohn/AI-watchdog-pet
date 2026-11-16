/**
 * main/packs: the size of a PNG from its header, without decoding it. The
 * import takes only PNG images (Story 3.2) and checks their width and
 * height against the import limits before anything draws them.
 */

/** The 8 bytes every PNG starts with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Signature, IHDR chunk length and type, width, height. */
const HEADER_BYTES = 24;

export interface PngSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The width and height in a PNG's IHDR chunk (which a PNG must start with),
 * or null when `data` does not start like a PNG or says it is 0 pixels wide
 * or high.
 */
export function pngSize(data: Uint8Array): PngSize | null {
  if (data.length < HEADER_BYTES) {
    return null;
  }
  if (!PNG_SIGNATURE.every((byte, i) => data[i] === byte)) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // The IHDR chunk: 4 bytes of length (13), then its type.
  const type = String.fromCharCode(data[12]!, data[13]!, data[14]!, data[15]!);
  if (view.getUint32(8) !== 13 || type !== 'IHDR') {
    return null;
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) {
    return null;
  }
  return { width, height };
}
