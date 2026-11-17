/**
 * main/stage-view (AD-20): composes StageView from the modules that own the
 * data (main/settings: `settings`, and `characters` from its characters
 * source, Story 3.6; main/windows: `displays`, `canvas`, `power`;
 * main/pool's assigner: `pool` and `actors`, with main/detection's
 * `sessions` and `adapters` passed on through it, Story 3.4; main/packs:
 * `packs` from its store, `packImport` from its importer, `packExport`
 * from its exporter) and owns nothing but its own rev and the subscriber
 * list.
 *
 * - Every change of a source becomes one delta, `rev` + 1, pushed to every
 *   subscriber through pushToRenderer. A delta replaces whole sections and
 *   carries only the sections that change reported.
 * - batch(run) (Story 3.6, Epic 1 retro R10): the changes the sources
 *   report while `run` runs make one delta, when it returns: a later report
 *   of a section replaces an earlier one, the whole is checked once, and
 *   `rev` goes up by 1. A batch inside a batch joins the outer one; a batch
 *   in which nothing changed sends nothing. When the whole fails the
 *   schema, each of its sections goes out on its own instead (each
 *   checked, so only the bad one is dropped and logged): the sources will
 *   not report the good ones again. `run` must be synchronous: one that
 *   answers a promise is logged as an error and the batch throws. When
 *   `run` throws, the batch still ends and what the sources reported
 *   until then is published (they have changed already and will not report
 *   it again), then the error goes on to the caller. Until a batch ends,
 *   snapshot() is still the view before it. main/settings' `settings:patch`
 *   runs in one, so what one patch does to settings, canvas, sessions,
 *   actors and characters reaches a renderer as one delta.
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
  type StageViewAssignerSections,
  type StageViewCharactersSections,
  type StageViewPackExportSections,
  type StageViewPackImportSections,
  type StageViewPacksSections,
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
   * main/pool's assigner: its `pool` and `actors`, and main/detection's
   * `sessions` and `adapters` passed on, so a change of a session and the
   * change of `actors` it causes are one delta. `onChange` hears only the
   * sections that changed (never an empty object).
   */
  readonly assigner: {
    get(): StageViewAssignerSections;
    onChange(
      listener: (sections: Partial<StageViewAssignerSections>) => void,
    ): () => void;
  };
  /** main/packs' store. `onChange` hears its one section after each change. */
  readonly packs: {
    get(): StageViewPacksSections;
    onChange(listener: (sections: StageViewPacksSections) => void): () => void;
  };
  /**
   * main/packs' importer. `onChange` hears its one section after each
   * change.
   */
  readonly packImport: {
    get(): StageViewPackImportSections;
    onChange(
      listener: (sections: StageViewPackImportSections) => void,
    ): () => void;
  };
  /**
   * main/packs' exporter. `onChange` hears its one section after each
   * change.
   */
  readonly packExport: {
    get(): StageViewPackExportSections;
    onChange(
      listener: (sections: StageViewPackExportSections) => void,
    ): () => void;
  };
  /**
   * main/settings' characters source (Story 3.6). `onChange` hears its one
   * section after each change.
   */
  readonly characters: {
    get(): StageViewCharactersSections;
    onChange(
      listener: (sections: StageViewCharactersSections) => void,
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
  /**
   * Runs `run` (synchronous) and answers what it returns; every section
   * the sources report meanwhile goes out as one delta when it ends, or
   * none when nothing changed (section by section when the whole fails
   * the schema). Nested batches join the outermost one. When `run` throws,
   * what was reported is still published, then the error is thrown on; a
   * `run` that answers a promise is logged and makes it throw.
   */
  batch<T>(run: () => T): T;
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

/** Whether `value` looks like a promise (has a `then` method). */
function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function createStageView(sources: StageViewSources): StageViewHub {
  let rev = 0;
  let view: StageView = {
    settings: sources.settings.get(),
    ...sources.windows.get(),
    ...sources.assigner.get(),
    ...sources.packs.get(),
    ...sources.packImport.get(),
    ...sources.packExport.get(),
    ...sources.characters.get(),
  };
  const subscribers = new Map<number, StageViewSubscriber>();
  /** How many batch() calls are under way; the delta waits for the last. */
  let batching = 0;
  /** The sections reported in this batch, the latest of each. */
  let held: StageViewSections = {};

  function snapshot(): StageViewSnapshot {
    return { rev, view };
  }

  /** Sends `sections` now, or holds them for the batch under way. */
  function publish(sections: StageViewSections): void {
    if (batching > 0) {
      held = { ...held, ...sections };
      return;
    }
    send(sections);
  }

  function send(sections: StageViewSections): void {
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
    deliver(sections);
  }

  /**
   * Sends what a batch gathered: as one delta, or, when that fails the
   * schema, each section as its own (each checked by send).
   */
  function sendBatch(sections: StageViewSections): void {
    const names = Object.keys(sections);
    if (names.length === 0) {
      return;
    }
    if (stageViewSectionsSchema.safeParse(sections).success) {
      deliver(sections);
      return;
    }
    for (const [name, section] of Object.entries(sections)) {
      send({ [name]: section } as StageViewSections);
    }
  }

  /** Takes `sections` (already checked) into the view and pushes them. */
  function deliver(sections: StageViewSections): void {
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
  sources.assigner.onChange((sections) => {
    publish(sections);
  });
  sources.packs.onChange((sections) => {
    publish(sections);
  });
  sources.packImport.onChange((sections) => {
    publish(sections);
  });
  sources.packExport.onChange((sections) => {
    publish(sections);
  });
  sources.characters.onChange((sections) => {
    publish(sections);
  });

  return {
    snapshot,

    batch(run) {
      batching += 1;
      try {
        const answer = run();
        if (isThenable(answer)) {
          logEvent(
            'stage-view',
            'a batch was handed a run that answered a promise; only what it did before answering is in the batch',
            'error',
          );
          throw new TypeError('batch() takes a synchronous run');
        }
        return answer;
      } finally {
        batching -= 1;
        if (batching === 0) {
          const sections = held;
          held = {};
          sendBatch(sections);
        }
      }
    },

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
