/**
 * main/stage-view (AD-20): composes StageView from the modules that own the
 * data (main/settings: `settings`; main/windows: `displays`, `canvas`,
 * `power`; main/detection: `sessions`, `adapters`) and owns nothing but its
 * own rev and the subscriber list.
 *
 * - Every change of a source becomes one delta, `rev` + 1, pushed to every
 *   subscriber through pushToRenderer. A delta replaces whole sections and
 *   carries only the sections that change reported.
 * - A delta is checked against the shared schema first. One that fails is
 *   dropped and logged as an error, by section name and field path only
 *   (never a value): the view and `rev` stay as they were, so a later valid
 *   delta still goes out with the next rev.
 * - Subscribers are keyed by webContents id. Subscribing again (a renderer
 *   reload) answers a fresh snapshot without registering the webContents a
 *   second time. A destroyed webContents leaves the list, on its
 *   `destroyed` event or when a push finds it destroyed.
 * - Both renderers (panels and overlay) may subscribe and receive pushes.
 */
import { stageViewDelta, stageViewSubscribe } from '../../shared/ipc';
import type { SettingsState } from '../../shared/settings';
import {
  applyStageViewDelta,
  stageViewSectionsSchema,
  type StageView,
  type StageViewDetectionSections,
  type StageViewSections,
  type StageViewSnapshot,
  type StageViewWindowsSections,
} from '../../shared/stage-view';
import type { z } from '../../shared/zod-setup';
import type { ChannelRenderers } from '../ipc/origin';
import { pushToRenderer, type PushTarget } from '../ipc/push';
import { registerIpcHandler } from '../ipc/register';
import { logEvent } from '../log/run-log';

/** Who may subscribe to StageView and receive its deltas. */
export const STAGE_VIEW_RENDERERS: ChannelRenderers = ['panels', 'overlay'];

/** What StageView reads from each owner. */
export interface StageViewSources {
  readonly settings: {
    get(): SettingsState;
    onChange(listener: (state: SettingsState) => void): () => void;
  };
  /**
   * main/windows. `onChange` hears only the sections that changed (never an
   * empty object).
   */
  readonly windows: {
    get(): StageViewWindowsSections;
    onChange(
      listener: (sections: Partial<StageViewWindowsSections>) => void,
    ): () => void;
  };
  /**
   * main/detection. `onChange` hears only the sections that changed (never
   * an empty object).
   */
  readonly detection: {
    get(): StageViewDetectionSections;
    onChange(
      listener: (sections: Partial<StageViewDetectionSections>) => void,
    ): () => void;
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

/**
 * The sections and field paths a failed check names, for the log: each
 * issue's path (`sessions.0.state`; just the section for a rule on the
 * whole section), the names of unknown sections, or `(root)`. Never a
 * value.
 */
function failedPaths(issues: z.ZodError['issues']): string {
  const paths = new Set<string>();
  for (const issue of issues) {
    const named =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issue.path, key])
        : [issue.path];
    for (const path of named) {
      paths.add(path.length === 0 ? '(root)' : path.map(String).join('.'));
    }
  }
  return [...paths].join(', ');
}

export function createStageView(sources: StageViewSources): StageViewHub {
  let rev = 0;
  let view: StageView = {
    settings: sources.settings.get(),
    ...sources.windows.get(),
    ...sources.detection.get(),
  };
  const subscribers = new Map<number, StageViewSubscriber>();

  function snapshot(): StageViewSnapshot {
    return { rev, view };
  }

  function publish(sections: StageViewSections): void {
    const names = Object.keys(sections);
    if (names.length === 0) {
      return;
    }
    const checked = stageViewSectionsSchema.safeParse(sections);
    if (!checked.success) {
      logEvent(
        'stage-view',
        `dropped a delta that fails the schema (sections: ${names.join(', ')}; fields: ${failedPaths(checked.error.issues)}); rev stays ${rev}`,
        'error',
      );
      return;
    }
    rev += 1;
    view = applyStageViewDelta(view, sections);
    const delta = { rev, sections };
    for (const [id, subscriber] of subscribers) {
      const outcome = pushToRenderer(
        subscriber,
        stageViewDelta,
        STAGE_VIEW_RENDERERS,
        delta,
      );
      if (outcome === 'destroyed') {
        subscribers.delete(id);
      }
    }
  }

  sources.settings.onChange((settings) => {
    publish({ settings });
  });
  sources.windows.onChange((sections) => {
    publish(sections);
  });
  sources.detection.onChange((sections) => {
    publish(sections);
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
  registerIpcHandler(stageViewSubscribe, STAGE_VIEW_RENDERERS, (event) =>
    hub.subscribe(event.sender),
  );
}
