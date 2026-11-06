/**
 * Which renderer frames may talk to main (AD-24). Shared by invoke handlers
 * (register.ts, for the sender frame) and pushes (push.ts, for the target's
 * top-level frame), so both follow one rule. Which URLs are allowed (`app://`
 * pages, plus the Vite dev server while not packaged) is decided in
 * main/windows/environment.ts, the one place that knows the environment.
 */
import type { WebFrameMain } from 'electron';
import { isAllowedFrameUrl } from '../windows/environment';

/**
 * Why `frame` may not talk to main, or null when it may: it must be a live,
 * top-level frame whose URL is allowed. Never throws.
 */
export function frameRejection(
  frame: Pick<WebFrameMain, 'url' | 'parent'> | null,
): string | null {
  let url: string;
  try {
    if (frame === null) {
      return 'frame is null';
    }
    if (frame.parent !== null) {
      return 'not a top-level frame';
    }
    url = frame.url;
  } catch {
    // WebFrameMain throws when the frame was disposed mid-call.
    return 'frame is no longer available';
  }
  return isAllowedFrameUrl(url) ? null : `origin not allowed (${url})`;
}
