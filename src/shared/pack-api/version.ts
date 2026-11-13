import { z } from '../zod-setup';

/**
 * The character pack API's version and the compatibility rule (Epic 3).
 * Adding a message, a draw command or a field raises the minor; removing one
 * or changing what it means raises the major. The stage sends a pack only
 * the messages and fields of the minor the pack declares, and a pack must
 * ignore anything it does not recognize.
 */

/** A version split into its two numbers. */
export interface ApiVersionParts {
  readonly major: number;
  readonly minor: number;
}

/**
 * The API version this stage implements: 1.0.
 *
 * In 1.0 a `frame` carries only the `enter` and `leave` events and no actor
 * `motion`. Epic 4 adds `motion` and the other events (coming close, a hit,
 * being picked up) as 1.1.
 */
export const PACK_API_VERSION: ApiVersionParts = Object.freeze({
  major: 1,
  minor: 0,
});

/** `<major>.<minor>`, each 1 to 3 digits. */
export const API_VERSION_PATTERN = /^([0-9]{1,3})\.([0-9]{1,3})$/;

/** A manifest's `apiVersion`: the API version the pack is written for. */
export const apiVersionSchema = z.string().regex(API_VERSION_PATTERN);

export type ApiVersion = z.infer<typeof apiVersionSchema>;

/**
 * Takes only `apiVersion` from a manifest and drops every other field, so the
 * version can be checked before the full manifest schema: a manifest for a
 * newer minor may have fields this stage's schema rejects, and the user
 * should be told which API version it needs rather than see a schema error.
 */
export const manifestApiVersionSchema = z.object({
  apiVersion: apiVersionSchema,
});

/**
 * The two numbers of a version that passed apiVersionSchema. Throws a
 * TypeError on anything else.
 */
export function parseApiVersion(version: ApiVersion): ApiVersionParts {
  const match = API_VERSION_PATTERN.exec(version);
  if (match === null) {
    throw new TypeError(`not an API version: ${JSON.stringify(version)}`);
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** `<major>.<minor>` without leading zeros. */
export function formatApiVersion(parts: ApiVersionParts): ApiVersion {
  return `${parts.major}.${parts.minor}`;
}

/**
 * Why a pack cannot run on this stage: its major equals the stage's but its
 * minor is higher (`pack-newer`: the stage needs updating), or its major is
 * another one, older or newer (`major-mismatch`).
 */
export const API_INCOMPATIBILITY_REASONS = [
  'pack-newer',
  'major-mismatch',
] as const;

export type ApiIncompatibilityReason =
  (typeof API_INCOMPATIBILITY_REASONS)[number];

/**
 * Whether a pack can run on this stage; when not, why, and the API version
 * the pack declares (as `<major>.<minor>`), for the message the import
 * shows (3.2).
 */
export type ApiCompatibility =
  | { readonly compatible: true }
  | {
      readonly compatible: false;
      readonly reason: ApiIncompatibilityReason;
      readonly required: ApiVersion;
    };

/**
 * A pack is compatible when its major equals the stage's and its minor is
 * at most the stage's. `packApiVersion` must have passed apiVersionSchema
 * (parseApiVersion throws otherwise). Checked at install and at load.
 */
export function checkApiCompatibility(
  packApiVersion: ApiVersion,
  stageApiVersion: ApiVersionParts = PACK_API_VERSION,
): ApiCompatibility {
  const pack = parseApiVersion(packApiVersion);
  if (pack.major !== stageApiVersion.major) {
    return {
      compatible: false,
      reason: 'major-mismatch',
      required: formatApiVersion(pack),
    };
  }
  if (pack.minor > stageApiVersion.minor) {
    return {
      compatible: false,
      reason: 'pack-newer',
      required: formatApiVersion(pack),
    };
  }
  return { compatible: true };
}
