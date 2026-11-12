import { poolSetReleased } from '../../shared/ipc';
import type { ChannelRenderers } from '../ipc/origin';
import { registerIpcHandler } from '../ipc/register';
import type { PoolStore } from './store';

/** Only the panels release sessions; the overlay gets `sender-rejected`. */
export const POOL_RENDERERS: ChannelRenderers = ['panels'];

/**
 * The only pool channel for now: `pool:set-released`. registerIpcHandler
 * has already checked the key against the shared schema, so an invalid one
 * never reaches the store. The answer is null whether anything changed or
 * not; the panel sees the outcome in StageView's `pool` section.
 */
export function registerPoolHandlers(
  store: Pick<PoolStore, 'setReleased'>,
): void {
  registerIpcHandler(
    poolSetReleased,
    POOL_RENDERERS,
    (_event, sessionKey, released) => {
      store.setReleased(sessionKey, released);
      return null;
    },
  );
}
