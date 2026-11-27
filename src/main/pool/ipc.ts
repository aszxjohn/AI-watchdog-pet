import {
  poolSetLocked,
  poolSetLockOn,
  poolSetReleased,
  poolSetReleasedMany,
} from '../../shared/ipc';
import type { ChannelRenderers } from '../ipc/origin';
import { registerIpcHandler } from '../ipc/register';
import type { PoolStore } from './store';

/** Only the panels change the pool; the overlay gets `sender-rejected`. */
export const POOL_RENDERERS: ChannelRenderers = ['panels'];

/**
 * The pool channels: `pool:set-released`, `pool:set-released-many`,
 * `pool:set-locked` and `pool:set-lock-on`. registerIpcHandler has already
 * checked the arguments against the shared schema, so an invalid key never
 * reaches the store. Each answers null whether anything changed or not;
 * the panel sees the outcome in StageView's `pool` section.
 */
export function registerPoolHandlers(
  store: Pick<
    PoolStore,
    'setReleased' | 'setReleasedMany' | 'setLocked' | 'setLockOn'
  >,
): void {
  registerIpcHandler(
    poolSetReleased,
    POOL_RENDERERS,
    (_event, sessionKey, released) => {
      store.setReleased(sessionKey, released);
      return null;
    },
  );
  registerIpcHandler(
    poolSetReleasedMany,
    POOL_RENDERERS,
    (_event, sessionKeys, released) => {
      store.setReleasedMany(sessionKeys, released);
      return null;
    },
  );
  registerIpcHandler(poolSetLocked, POOL_RENDERERS, (_event, key, locked) => {
    store.setLocked(key, locked);
    return null;
  });
  registerIpcHandler(poolSetLockOn, POOL_RENDERERS, (_event, on) => {
    store.setLockOn(on);
    return null;
  });
}
