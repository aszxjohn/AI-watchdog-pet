/**
 * Which renderer frames may talk to main on a channel (AD-24). Shared by
 * invoke handlers (register.ts, for the sender frame) and pushes (push.ts,
 * for the target's top-level frame), so both follow one rule: the frame
 * must be one of the stage's renderers, and one the channel lists. Which
 * renderer a URL is (`app://panels`, `app://overlay`, or a dev server while
 * not packaged) is decided in main/windows/environment.ts, the one place
 * that knows the environment.
 */
import type { WebFrameMain } from 'electron';
import { rendererOfUrl, type RendererName } from '../windows/environment';

/**
 * The renderers a channel accepts, at least one. Every invoke handler and
 * every push names its own; any other renderer is refused.
 */
export type ChannelRenderers = readonly [RendererName, ...RendererName[]];

/**
 * Why `frame` may not talk to main on a channel that accepts `renderers`,
 * or null when it may: it must be a live, top-level frame of one of those
 * renderers. Never throws.
 */
export function frameRejection(
  frame: Pick<WebFrameMain, 'url' | 'parent'> | null,
  renderers: ChannelRenderers,
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
  const renderer = rendererOfUrl(url);
  if (renderer === undefined) {
    return `origin not allowed (${url})`;
  }
  return renderers.includes(renderer)
    ? null
    : `renderer ${renderer} may not use this channel`;
}
