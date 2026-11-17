/**
 * main/pool's assigner (Story 3.4; FR3, FR4, FR21): gives each shown
 * session a character from the pool, as one assignment with its own
 * `actorId`, and publishes StageView's `actors`. It passes main/detection's
 * `sessions` and `adapters` on, with main/pool's `pool` and `actors`, so
 * StageView hears a change of a session and what it does to `actors` as
 * one change (one delta).
 *
 * - The pool: each 上場 pack, by id, × each of its characters that joins
 *   the pool (加入池子), in manifest order. Both are read only through
 *   isPackEnabled and isInPool (src/shared/settings).
 * - Which character: among the pool's characters no actor plays right now,
 *   the one with the fewest appearances this run, the first in pool order
 *   among equals; when every one is on stage already, the same over the
 *   whole pool. Appearances are counted in memory only: each new
 *   assignment, and each one kept from the last run, counts once.
 * - Who gets one: every session in `sessions` that is not released, once
 *   start-up sync is over. Before it (some source has not sent
 *   `sync.ready` and syncTimeoutMs has not passed) no assignment is made;
 *   at sync every session due one gets it, in one change. An empty pool
 *   gives none: the session is listed with no actor.
 * - The assignments saved last run (assignments.json, through the store)
 *   are swept at sync: one whose session was not reported, its source
 *   confirmed, is dropped, and so is one whose character is not in the pool
 *   any more. The rest are kept: a session that is shown keeps its
 *   character and `actorId`; one that is shown later (an unconfirmed
 *   source catching up) keeps them then. Either way only while its
 *   character is still in the pool and, so as not to repeat a character
 *   while another is free, either not on stage or with every pool
 *   character on stage; otherwise it gets a new assignment.
 * - An assignment ends, and its actor with it, when its session leaves
 *   `sessions` (it ended or expired) or is released. Showing a released
 *   session again makes a new assignment, with a new `actorId`.
 * - The pool shrinking (a pack no longer 上場 or removed, a character out
 *   of the pool) leaves every assignment as it is: only later picks see
 *   it. The pool growing gives a character to each shown session still
 *   without one, at once. An actor never changes character here (3.9).
 * - The pool is worked out from the settings values and installed packs
 *   the assigner last heard, through watchPool(), which main.ts calls right
 *   after createStageView: StageView hears a settings or packs change
 *   before the assigner does, so an `actors` delta never goes out ahead of
 *   the `settings` or `packs` delta it follows from (one that a detection
 *   change causes in between uses the values StageView already has).
 * - `actorId`s come from `token` (randomUUID unless injected), are opaque,
 *   and are never used twice in a run.
 * - Each change of the assignments goes to the store, which writes
 *   assignments.json after its debounce.
 *
 * Log lines carry counts only, never a session key, a character or an
 * actor id.
 */
import { randomUUID } from 'node:crypto';
import {
  type SessionKey,
  splitSessionKey,
} from '../../shared/detection-events';
import { actorIdSchema } from '../../shared/pack-api';
import {
  type CharacterKey,
  characterKey,
  type StagePack,
} from '../../shared/packs';
import type { PoolAssignment, StageActor } from '../../shared/pool';
import {
  isInPool,
  isPackEnabled,
  type SettingsState,
  type SettingsValues,
} from '../../shared/settings';
import type { SourceCode } from '../../shared/sources';
import type {
  StageSession,
  StageViewAssignerSections,
  StageViewDetectionSections,
  StageViewPacksSections,
} from '../../shared/stage-view';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import type { PoolStore } from './store';

/** How many times a fresh actor id is drawn before giving up on one. */
const ACTOR_ID_TRIES = 16;

/** One session's character, as the assigner keeps it. */
export interface Assignment {
  readonly actorId: string;
  readonly characterKey: CharacterKey;
}

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('pool', message, level);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The pool, in order: each pack of `installed` that is 上場, by id, ×
 * each of its characters that joins the pool, in manifest order.
 */
export function poolOf(
  installed: readonly StagePack[],
  values: Pick<SettingsValues, 'packEnabled' | 'fixedOverrides'>,
): CharacterKey[] {
  return [...installed]
    .sort((a, b) => compareIds(a.id, b.id))
    .filter((pack) => isPackEnabled(values, pack.id))
    .flatMap((pack) =>
      pack.characters
        .filter((character) => isInPool(values, pack.id, character.id))
        .map((character) => characterKey(pack.id, character.id)),
    );
}

/**
 * The character a new assignment takes from `pool`: among those not in
 * `onStage` (or all of `pool` when every one is), the one with the fewest
 * `appearances` (none counts 0), the first in pool order among equals.
 * Null when the pool is empty.
 */
export function pickCharacter(
  pool: readonly CharacterKey[],
  onStage: ReadonlySet<CharacterKey>,
  appearances: ReadonlyMap<CharacterKey, number>,
): CharacterKey | null {
  const offStage = pool.filter((key) => !onStage.has(key));
  const candidates = offStage.length > 0 ? offStage : pool;
  let best: CharacterKey | null = null;
  let fewest = Infinity;
  for (const key of candidates) {
    const count = appearances.get(key) ?? 0;
    if (count < fewest) {
      best = key;
      fewest = count;
    }
  }
  return best;
}

/**
 * StageView's actors: one per session of `sessions` with an assignment, in
 * the order of `sessions`, carrying the session's state, confidence and
 * display name.
 */
export function actorsOf(
  sessions: readonly StageSession[],
  assignments: ReadonlyMap<SessionKey, Assignment>,
): StageActor[] {
  return sessions.flatMap((session) => {
    const assignment = assignments.get(session.sessionKey);
    return assignment === undefined
      ? []
      : [
          {
            actorId: assignment.actorId,
            sessionKey: session.sessionKey,
            characterKey: assignment.characterKey,
            state: session.state,
            confidence: session.confidence,
            displayName: session.displayName,
          },
        ];
  });
}

function sameActors(
  a: readonly StageActor[],
  b: readonly StageActor[],
): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return (
        y !== undefined &&
        x.actorId === y.actorId &&
        x.sessionKey === y.sessionKey &&
        x.characterKey === y.characterKey &&
        x.state === y.state &&
        x.confidence === y.confidence &&
        x.displayName === y.displayName
      );
    })
  );
}

export type AssignerListener = (
  sections: Partial<StageViewAssignerSections>,
) => void;

export interface AssignerOptions {
  /** main/detection: its sections, passed on. */
  readonly detection: {
    get(): StageViewDetectionSections;
    onChange(
      listener: (sections: Partial<StageViewDetectionSections>) => void,
    ): () => void;
  };
  /** main/pool's store: the released keys and the saved assignments. */
  readonly store: Pick<
    PoolStore,
    'get' | 'onChange' | 'sweep' | 'assignments' | 'setAssignments'
  >;
  /** main/settings: 上場 and 加入池子. */
  readonly settings: {
    get(): SettingsState;
    onChange(listener: (state: SettingsState) => void): () => void;
  };
  /** main/packs' store: the installed packs and their characters. */
  readonly packs: {
    get(): StageViewPacksSections;
    onChange(listener: (sections: StageViewPacksSections) => void): () => void;
  };
  /** Makes a new actor id (default randomUUID). */
  readonly token?: () => string;
}

export interface Assigner {
  /** The current `sessions`, `adapters`, `pool` and `actors`. */
  get(): StageViewAssignerSections;
  /**
   * Hears only the sections each change changed (never an empty object).
   * Returns an unsubscribe.
   */
  onChange(listener: AssignerListener): () => void;
  /**
   * main/detection's start-up sync (main.ts wires its onSynced here):
   * sweeps the store's released keys and the saved assignments, then
   * assigns every session due a character, all in one change. Only the
   * first call does anything.
   */
  sync(
    reported: ReadonlySet<SessionKey>,
    unconfirmed: ReadonlySet<SourceCode>,
  ): void;
  /**
   * Starts following settings (上場, 加入池子) and the installed packs.
   * main.ts calls it right after createStageView, so StageView hears each
   * such change first. Until then the pool is what they were at creation.
   * Only the first call does anything.
   */
  watchPool(): void;
}

export function createAssigner({
  detection,
  store,
  settings,
  packs,
  token = randomUUID,
}: AssignerOptions): Assigner {
  const started = detection.get();
  let sections: StageViewAssignerSections = {
    sessions: started.sessions,
    adapters: started.adapters,
    pool: store.get().pool,
    actors: [],
  };
  /** The assignments of shown sessions: the actors. */
  const live = new Map<SessionKey, Assignment>();
  /**
   * The assignments saved last run and not used yet: all of them until
   * sync, then those the sweep kept whose session is not shown (yet).
   */
  const restored = new Map<SessionKey, Assignment>();
  /** Every actor id this run has seen, so a new one is never one of them. */
  const usedActorIds = new Set<string>();
  /** How many times each character has appeared this run. */
  const appearances = new Map<CharacterKey, number>();
  const listeners = new Set<AssignerListener>();
  let synced = false;
  let watching = false;
  /** The settings values and installed packs the pool is worked out from. */
  let poolValues = settings.get().values;
  let installed = packs.get().packs.installed;
  /** How many batch() calls are under way; the change waits for the last. */
  let batching = 0;
  /** The sections changed in this batch, heard when it ends. */
  let changed: Partial<StageViewAssignerSections> = {};

  for (const saved of store.assignments()) {
    restored.set(saved.sessionKey, {
      actorId: saved.actorId,
      characterKey: saved.characterKey,
    });
    usedActorIds.add(saved.actorId);
  }

  function currentPool(): CharacterKey[] {
    return poolOf(installed, poolValues);
  }

  function appeared(key: CharacterKey): void {
    appearances.set(key, (appearances.get(key) ?? 0) + 1);
  }

  /** A fresh, valid actor id, or null when `token` gives none. */
  function newActorId(): string | null {
    for (let tries = 0; tries < ACTOR_ID_TRIES; tries += 1) {
      let id: unknown;
      try {
        id = token();
      } catch (error) {
        log(`making an actor id failed (${errorCode(error)})`, 'error');
        return null;
      }
      if (
        typeof id === 'string' &&
        !usedActorIds.has(id) &&
        actorIdSchema.safeParse(id).success
      ) {
        usedActorIds.add(id);
        return id;
      }
    }
    log(
      `no fresh actor id after ${ACTOR_ID_TRIES} tries; the session stays without a character`,
      'error',
    );
    return null;
  }

  /** Hands every assignment, shown or kept for later, to the store. */
  function save(): void {
    const all: PoolAssignment[] = [];
    for (const [sessionKey, assignment] of [...live, ...restored]) {
      all.push({ sessionKey, ...assignment });
    }
    try {
      store.setAssignments(all);
    } catch (error) {
      log(`saving the assignments failed (${errorCode(error)})`, 'error');
    }
  }

  /**
   * After sync: ends the assignments of sessions gone or released, gives
   * shown sessions their kept assignment, then a character to each one
   * still without, and publishes `actors` if they changed. `force` saves
   * the assignments even when none changed here (the sync's sweep may have
   * dropped some).
   */
  function reconcile(force = false): void {
    if (!synced) {
      return;
    }
    const shown = sections.sessions;
    const shownKeys = new Set<SessionKey>(shown.map((s) => s.sessionKey));
    const released = new Set<SessionKey>(sections.pool.released);
    let ended = 0;
    let dropped = 0;
    let kept = 0;
    let added = 0;

    // A Map may lose the entry being visited: iteration goes on safely.
    for (const key of live.keys()) {
      if (!shownKeys.has(key) || released.has(key)) {
        live.delete(key);
        ended += 1;
      }
    }
    for (const key of restored.keys()) {
      if (released.has(key)) {
        restored.delete(key);
        dropped += 1;
      }
    }

    const pool = currentPool();
    const inPool = new Set(pool);
    const due = shown.filter(
      (session) =>
        !released.has(session.sessionKey) && !live.has(session.sessionKey),
    );
    const onStage = new Set<CharacterKey>(
      [...live.values()].map((assignment) => assignment.characterKey),
    );
    // Kept ones first, so a new pick sees their characters on stage. One
    // whose character is on stage already is kept only when no pool
    // character is free: a kept assignment never repeats a character
    // while another is off stage.
    for (const { sessionKey } of due) {
      const saved = restored.get(sessionKey);
      if (saved === undefined) {
        continue;
      }
      restored.delete(sessionKey);
      const free =
        !onStage.has(saved.characterKey) ||
        pool.every((key) => onStage.has(key));
      if (inPool.has(saved.characterKey) && free) {
        live.set(sessionKey, saved);
        onStage.add(saved.characterKey);
        appeared(saved.characterKey);
        kept += 1;
      } else {
        dropped += 1;
      }
    }
    for (const { sessionKey } of due) {
      if (live.has(sessionKey)) {
        continue;
      }
      const picked = pickCharacter(pool, onStage, appearances);
      if (picked === null) {
        break;
      }
      const actorId = newActorId();
      if (actorId === null) {
        break;
      }
      live.set(sessionKey, { actorId, characterKey: picked });
      onStage.add(picked);
      appeared(picked);
      added += 1;
    }

    if (ended + dropped + kept + added > 0) {
      log(
        `assignments: ${added} new, ${kept} kept from the last run, ${ended} ended, ${dropped} dropped (${live.size} actors, ${pool.length} characters in the pool)`,
      );
    }
    if (force || ended + dropped + kept + added > 0) {
      save();
    }
    const actors = actorsOf(shown, live);
    if (!sameActors(actors, sections.actors)) {
      sections = { ...sections, actors };
      changed.actors = actors;
    }
  }

  /** Runs `run`, then tells the listeners what it changed, once. */
  function batch(run: () => void): void {
    batching += 1;
    try {
      run();
    } catch (error) {
      log(`updating the assignments failed (${errorCode(error)})`, 'error');
    } finally {
      batching -= 1;
      if (batching === 0) {
        notify();
      }
    }
  }

  function notify(): void {
    if (Object.keys(changed).length === 0) {
      return;
    }
    const heard = changed;
    changed = {};
    for (const listener of listeners) {
      try {
        listener(heard);
      } catch (error) {
        log(`a change listener failed (${errorCode(error)})`, 'error');
      }
    }
  }

  detection.onChange((next) => {
    batch(() => {
      sections = { ...sections, ...next };
      Object.assign(changed, next);
      if (next.sessions !== undefined) {
        reconcile();
      }
    });
  });

  store.onChange(({ pool }) => {
    batch(() => {
      sections = { ...sections, pool };
      changed.pool = pool;
      reconcile();
    });
  });

  return {
    get: () => sections,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    sync(reported, unconfirmed) {
      if (synced) {
        return;
      }
      batch(() => {
        try {
          store.sweep(reported, unconfirmed);
          const inPool = new Set(currentPool());
          let notReported = 0;
          let notInPool = 0;
          for (const [key, assignment] of restored) {
            if (
              !reported.has(key) &&
              !unconfirmed.has(splitSessionKey(key).source)
            ) {
              restored.delete(key);
              notReported += 1;
            } else if (!inPool.has(assignment.characterKey)) {
              restored.delete(key);
              notInPool += 1;
            }
          }
          log(
            `start-up sync: kept ${restored.size} saved assignments, dropped ${notReported + notInPool} (${notReported} not reported, ${notInPool} not in the pool)`,
          );
        } finally {
          // A sweep that throws (logged by batch) must not leave this run
          // never assigning.
          synced = true;
          reconcile(true);
        }
      });
    },

    watchPool() {
      if (watching) {
        return;
      }
      watching = true;
      settings.onChange((state) => {
        batch(() => {
          poolValues = state.values;
          reconcile();
        });
      });
      packs.onChange((next) => {
        batch(() => {
          installed = next.packs.installed;
          reconcile();
        });
      });
    },
  };
}
