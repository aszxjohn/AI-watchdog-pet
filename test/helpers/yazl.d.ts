/**
 * The part of yazl 3.3.1 the tests use to build `.awpet` files. yazl ships
 * no types, and only the tests need it, so this stands in for a types
 * package.
 */
declare module 'yazl' {
  import type { Buffer } from 'node:buffer';
  import type { Readable } from 'node:stream';

  export interface EntryOptions {
    mtime?: Date;
    /** Unix mode bits, stored in the entry's external attributes. */
    mode?: number;
    /** false stores the entry; it is deflated otherwise. */
    compress?: boolean;
  }

  export class ZipFile {
    readonly outputStream: Readable;
    addBuffer(
      buffer: Buffer,
      metadataPath: string,
      options?: EntryOptions,
    ): void;
    addEmptyDirectory(
      metadataPath: string,
      options?: { mtime?: Date; mode?: number },
    ): void;
    end(): void;
  }
}
