/**
 * main/stage-view (AD-20): composes StageView from the modules that own the
 * data (Epic 1: settings only) and owns nothing but its own rev and the
 * subscriber list.
 *
 * - Every change of a source becomes one delta, `rev` + 1, pushed to every
 *   subscriber through pushToRenderer. A delta replaces whole sections.
 * - Subscribers are keyed by webContents id. Subscribing again (a renderer
 *   reload) answers a fresh snapshot without registering the webContents a
 *   second time. A destroyed webContents leaves the list, on its
 *   `destroyed` event or when a push finds it destroyed.
 */
import { stageViewDelta, stageViewSubscribe } from '../../shared/ipc';
import type { SettingsState } from '../../shared/settings';
import {
  applyStageViewDelta,
  type StageView,
  type StageViewSections,
  type StageViewSnapshot,
} from '../../shared/stage-view';
import { pushToRenderer, type PushTarget } from '../ipc/push';
import { registerIpcHandler } from '../ipc/register';
import { logEvent } from '../log/run-log';

/** What StageView reads from each owner. */
export interface StageViewSources {
  readonly settings: {
    get(): SettingsState;
    onChange(listener: (state: SettingsState) => void): () => void;
  };
}

/** The parts of a WebContents a subscriber needs. */
export interface StageViewSubscriber extends PushTarget {
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface StageViewHub {
  /** The current view and its rev. */
  snapshot(): StageViewSnapshot;
  /** Adds `subscriber` (once per webContents) and answers a snapshot. */
  subscribe(subscriber: StageViewSubscriber): StageViewSnapshot;
  /** How many webContents are subscribed. */
  subscriberCount(): number;
}

export function createStageView(sources: StageViewSources): StageViewHub {
  let rev = 0;
  let view: StageView = { settings: sources.settings.get() };
  const subscribers = new Map<number, StageViewSubscriber>();

  function snapshot(): StageViewSnapshot {
    return { rev, view };
  }

  function publish(sections: StageViewSections): void {
    rev += 1;
    view = applyStageViewDelta(view, sections);
    const delta = { rev, sections };
    for (const [id, subscriber] of subscribers) {
      if (pushToRenderer(subscriber, stageViewDelta, delta) === 'destroyed') {
        subscribers.delete(id);
      }
    }
  }

  sources.settings.onChange((settings) => {
    publish({ settings });
  });

  return {
    snapshot,

    subscribe(subscriber) {
      const { id } = subscriber;
      if (subscribers.get(id) !== subscriber) {
        subscribers.set(id, subscriber);
        subscriber.once('destroyed', () => {
          if (subscribers.get(id) === subscriber) {
            subscribers.delete(id);
          }
        });
        logEvent('stage-view', `webContents ${id} subscribed at rev ${rev}`);
      }
      return snapshot();
    },

    subscriberCount: () => subscribers.size,
  };
}

/** Registers `stage-view:subscribe`; the caller's webContents subscribes. */
export function registerStageViewHandlers(
  hub: Pick<StageViewHub, 'subscribe'>,
): void {
  registerIpcHandler(stageViewSubscribe, (event) =>
    hub.subscribe(event.sender),
  );
}
