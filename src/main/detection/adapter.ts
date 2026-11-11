/**
 * main/detection/adapter: what main/detection and a source's adapter know
 * of each other (AD-5, AD-21). createDetection starts every adapter it is
 * given once, hands it a context, and stops it when detection stops. The
 * demo adapter is not one of these: demo mode turns it on and off itself.
 */
import type { AdapterOutput } from '../../shared/detection-events';
import type { DetectionTimings } from '../../shared/settings';
import type { AdapterHealth, SourceCode } from '../../shared/sources';

/** What main/detection gives an adapter it starts. */
export interface AdapterContext {
  /**
   * Hands what one read produced to main/detection/sessions, in order, as
   * one change: the panel hears about the outcome once. With `health`, the
   * adapter's health changes in the same change. Nothing after stop().
   */
  readonly emit: (
    outputs: readonly AdapterOutput[],
    health?: AdapterHealth,
  ) => void;
  /** The timings in force (main/settings' current values). */
  readonly timings: () => DetectionTimings;
  /** The wall clock in epoch ms, the one sessions dates replays with. */
  readonly wallNow: () => number;
  /** Runs `run` once after `delayMs`: detection's timer. */
  readonly setTimer: (run: () => void, delayMs: number) => unknown;
  /** Cancels a timer setTimer returned. */
  readonly clearTimer: (handle: unknown) => void;
}

/** A source's adapter, as createDetection runs it. */
export interface DetectionAdapter {
  /** The source it reads; its health is published under this code. */
  readonly source: SourceCode;
  /**
   * Starts reading. Called once; it reports its first health through
   * `context.emit` (until then the source has no row in `adapters`).
   */
  start(context: AdapterContext): void;
  /** Stops reading (closes its watcher). Afterwards it emits nothing. */
  stop(): void;
}
