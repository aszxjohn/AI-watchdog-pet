/**
 * Why a pack's sandbox failed (Stories 3.5, 3.9), as the English codes the
 * overlay reports and main marks a pack with. No imports: shared/packs.ts
 * (a StagePack's `runtimeFailed`) and shared/sandbox.ts (which imports
 * shared/packs.ts) both take them from here, so neither imports the other
 * for them. shared/sandbox.ts exports them too.
 */

/**
 * Why the bootstrap did not get the pack's `handlers`, in its order:
 * - `api-removal-failed`, `intrinsic-removal-failed`: a listed API or
 *   intrinsic is still there after removal;
 * - `ses-missing`: SES's `lockdown` is not there (or, after `lockdown()`,
 *   its `harden` or `Compartment`);
 * - `lockdown-threw`;
 * - `lockdown-output`: something was printed on the console from loading
 *   SES to the end of `lockdown()`;
 * - `entry-threw`: evaluating the entry threw (a syntax error included);
 * - `entry-not-factory`: the entry's value is not a function;
 * - `factory-threw`;
 * - `handlers-not-object`: the factory did not return an object (an array
 *   or a promise, from an async factory, does not count).
 * The pack's code runs only after the first four passed.
 */
export const SANDBOX_BOOT_FAILURES = [
  'api-removal-failed',
  'intrinsic-removal-failed',
  'ses-missing',
  'lockdown-threw',
  'lockdown-output',
  'entry-threw',
  'entry-not-factory',
  'factory-threw',
  'handlers-not-object',
] as const;

export type SandboxBootFailure = (typeof SANDBOX_BOOT_FAILURES)[number];

/**
 * Why a pack's sandbox was taken down: the bootstrap's own reasons, plus
 * the Worker failing (`worker-error`, its iframe or bootstrap says so), an
 * unhandled rejection in it, a report that does not fit the protocol
 * (`bad-report`), and no `sandbox.ready` or `sandbox.failed` within
 * SANDBOX_BOOT_TIMEOUT_MS of adding its iframe (`boot-timeout`). And
 * (Story 3.9), once ready: no `sandbox.pong` in HEARTBEAT_TIMEOUT_TICKS
 * of the ticks the overlay handled it in (`heartbeat-timeout`), and no
 * valid `draw` in DRAW_TIMEOUT_MS of them while the pack had an own actor
 * (`draw-timeout`).
 */
export const SANDBOX_FAILURE_REASONS = [
  ...SANDBOX_BOOT_FAILURES,
  'worker-error',
  'unhandled-rejection',
  'bad-report',
  'boot-timeout',
  'heartbeat-timeout',
  'draw-timeout',
] as const;

export type SandboxFailureReason = (typeof SANDBOX_FAILURE_REASONS)[number];
