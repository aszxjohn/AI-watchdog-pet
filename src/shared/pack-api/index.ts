/**
 * The character pack API, v1 (Epic 3): the manifest, the messages between
 * stage and pack, draw commands, the API version and the fixed parameters.
 * The contract lives only here; the helpers in common.ts that are not
 * re-exported below are internal to it.
 */
export {
  FLOAT_TOLERANCE,
  ID_PATTERN,
  type Id,
  idSchema,
  LABEL_MAX_LENGTH,
  labelSchema,
  PACK_API_ISSUE_RULES,
  type PackApiIssueRule,
} from './common';
export * from './draw';
export * from './fixed-params';
export * from './manifest';
export * from './messages';
export * from './params';
export * from './version';
