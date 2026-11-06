/**
 * Which renderer frames may talk to main (AD-24). Shared by invoke handlers
 * (register.ts, for the sender frame) and pushes (push.ts, for the target's
 * top-level frame), so both follow one rule.
 */
import { app, type WebFrameMain } from 'electron';
import { APP_SCHEME } from '../../shared/constants';

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

/**
 * `app://` pages, plus the Vite dev server origin while `!app.isPackaged`.
 */
export function isAllowedFrameUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === `${APP_SCHEME}:`) {
    return true;
  }
  const devOrigin = devServerOrigin();
  return devOrigin !== undefined && parsed.origin === devOrigin;
}

/**
 * The Vite dev server origin, only while `!app.isPackaged`. Forge's Vite
 * plugin defines MAIN_WINDOW_VITE_DEV_SERVER_URL at build time (a URL under
 * `npm start`, undefined in a packaged build); `typeof` also keeps this safe
 * where the constant is not defined at all (unit tests). Story 1.5 moves the
 * environment check into main/windows (AD-24).
 */
function devServerOrigin(): string | undefined {
  if (app.isPackaged) {
    return undefined;
  }
  if (
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'string' ||
    MAIN_WINDOW_VITE_DEV_SERVER_URL === ''
  ) {
    return undefined;
  }
  try {
    return new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
  } catch {
    return undefined;
  }
}
