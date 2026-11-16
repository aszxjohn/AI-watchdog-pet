/**
 * The part of yazl 3.3.1 main/packs (export.ts, Story 3.3) and the tests
 * (which build `.awpet` files with it) use. yazl ships no types, so this
 * stands in for a types package.
 */
declare module 'yazl' {
  import type { Buffer } from 'node:buffer';
  import type { Readable } from 'node:stream';

  export interface EntryOptions {
    /**
     * Stored as a DOS date and time, read in the local time zone (and, unless
     * forceDosTimestamp, also as UTC seconds in an extra field of the
     * central directory). Now when left out.
     */
    mtime?: Date;
    /** Unix mode bits, stored in the entry's external attributes. */
    mode?: number;
    /** false stores the entry; it is deflated otherwise. */
    compress?: boolean;
    /**
     * true leaves out the extra field with the UTC time, so the DOS date
     * and time are the only time stored.
     */
    forceDosTimestamp?: boolean;
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
