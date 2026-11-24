/**
 * main/pool's demo mode (FR21 as changed on 2026-11-24): the one place the
 * 示範模式 menu goes through. Demo mode is a tool for pack development:
 * while it is on it has the stage to itself, and the usual stage comes
 * back only once it is off. The two never run at once.
 *
 * - Picking a character (any installed one that fits this stage, in the
 *   pool or not) turns demo mode on if it is off: the stage is cleared
 *   (main/pool's assigner parks every other session's actor), then the
 *   demo session shows 休息中 with that character. Picking one while on
 *   switches to it the same way; picking the same one again reloads it
 *   (a new actor). The pick is remembered (settings' `demoCharacter`).
 * - Picking a state while on shows it on the demo session. While off, it
 *   turns demo mode on with that state and the remembered character; when
 *   that one is not installed (or none was picked yet), `chooseCharacter`
 *   asks for one first, and nothing happens unless one is picked. With no
 *   character installed at all, demo mode runs with none: the session
 *   shows in the panel only (FR24).
 * - 關閉 (stop) ends the demo session, then gives the stage back: the
 *   parked sessions come back, each with its character where it can.
 * - The character in use leaving (its pack removed or no longer fitting
 *   the stage, or a new version without it) turns demo mode off. A new
 *   version that still has it needs nothing here: the canvas reloads a
 *   pack whose version changed. Reloading a pack installed again at the
 *   same version is not done (to be discussed; see
 *   spec-demo-mode-pick-character.md).
 * - Each switch (clearing, demo session, remembering) runs as one change
 *   through `batch` (main.ts: one StageView batch).
 *
 * The menu shows view(): whether it is on, the state picked last, the
 * character in use (while off, the remembered one when installed) and the
 * characters to pick from, the remembered one first, then by pack id and
 * manifest order. onChange hears each change of it.
 *
 * Nothing here is saved but the remembered character; demo mode is off
 * at every start. Log lines carry no character, pack or session key.
 */
import {
  characterKey,
  type CharacterKey,
  type StagePack,
} from '../../shared/packs';
import type {
  SettingsPatch,
  SettingsPatchResult,
  SettingsState,
} from '../../shared/settings';
import type { StageViewPacksSections } from '../../shared/stage-view';
import type { StateCode } from '../../shared/states';
import { errorCode, logEvent, type ConsoleLevel } from '../log/run-log';
import type { DemoStage } from './assign';

/** The state demo mode shows right after a character is picked. */
export const DEMO_START_STATE: StateCode = 'idle';

/** One character the 示範模式 menu lists. */
export interface DemoCharacter {
  readonly key: CharacterKey;
  /** What the menu shows: `<character name>（<pack name>）`. */
  readonly label: string;
}

/** What the 示範模式 menu shows. */
export interface DemoModeView {
  readonly on: boolean;
  /** The state picked last; null while off. */
  readonly state: StateCode | null;
  /**
   * While on, the character the demo session plays (null: none installed);
   * while off, the remembered one when it is listed, else null.
   */
  readonly character: CharacterKey | null;
  /** The characters to pick from, the remembered one first. */
  readonly characters: readonly DemoCharacter[];
}

export type DemoModeListener = (view: DemoModeView) => void;

export interface DemoModeOptions {
  /** main/detection: shows a state on the demo session; null ends it. */
  readonly detection: { setDemo(state: StateCode | null): void };
  /** main/pool's assigner: who has the stage. */
  readonly assigner: { setDemo(demo: DemoStage | null): void };
  /** main/settings: the remembered character. */
  readonly settings: {
    get(): SettingsState;
    patch(patch: SettingsPatch): SettingsPatchResult;
    onChange(listener: (state: SettingsState) => void): () => void;
  };
  /** main/packs' store: the installed packs. */
  readonly packs: {
    get(): StageViewPacksSections;
    onChange(listener: (sections: StageViewPacksSections) => void): () => void;
  };
  /**
   * Asks the user for one of `characters` (the remembered one is not among
   * them); calls `pick` with the one picked, never when none is.
   */
  readonly chooseCharacter: (
    characters: readonly DemoCharacter[],
    pick: (key: CharacterKey) => void,
  ) => void;
  /** Runs `run` as one change (default: runs it). */
  readonly batch?: (run: () => void) => void;
}

export interface DemoMode {
  view(): DemoModeView;
  /** Hears each change of view(). Returns an unsubscribe. */
  onChange(listener: DemoModeListener): () => void;
  /** Shows `key` from 休息中, turning demo mode on if it is off. */
  pickCharacter(key: CharacterKey): void;
  /** Shows `state`, turning demo mode on if it is off (see above). */
  pickState(state: StateCode): void;
  /** Turns demo mode off; nothing when it is off. */
  stop(): void;
  /**
   * Starts following the installed packs and settings. main.ts calls it
   * once StageView exists, so StageView hears such a change first. Only
   * the first call does anything.
   */
  watch(): void;
}

function log(message: string, level: ConsoleLevel = 'info'): void {
  logEvent('pool', message, level);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The characters demo mode can show: those of the installed packs that fit
 * this stage, in or out of the pool, `remembered` first, then by pack id
 * and manifest order.
 */
export function demoCharactersOf(
  installed: readonly StagePack[],
  remembered: CharacterKey | null,
): DemoCharacter[] {
  const all = [...installed]
    .sort((a, b) => compareIds(a.id, b.id))
    .filter((pack) => pack.compatibility.compatible)
    .flatMap((pack) =>
      pack.characters.map(
        (character): DemoCharacter => ({
          key: characterKey(pack.id, character.id),
          label: `${character.name}（${pack.name}）`,
        }),
      ),
    );
  const first = all.find((character) => character.key === remembered);
  return first === undefined
    ? all
    : [first, ...all.filter((character) => character !== first)];
}

function sameView(a: DemoModeView, b: DemoModeView): boolean {
  return (
    a.on === b.on &&
    a.state === b.state &&
    a.character === b.character &&
    a.characters.length === b.characters.length &&
    a.characters.every((character, index) => {
      const other = b.characters[index];
      return (
        other !== undefined &&
        other.key === character.key &&
        other.label === character.label
      );
    })
  );
}

export function createDemoMode({
  detection,
  assigner,
  settings,
  packs,
  chooseCharacter,
  batch = (run) => {
    run();
  },
}: DemoModeOptions): DemoMode {
  let on = false;
  let state: StateCode | null = null;
  /** The character in use while on; null: none installed. */
  let inUse: CharacterKey | null = null;
  let watching = false;
  const listeners = new Set<DemoModeListener>();

  function remembered(): CharacterKey | null {
    return settings.get().values.demoCharacter;
  }

  function characters(): DemoCharacter[] {
    return demoCharactersOf(packs.get().packs.installed, remembered());
  }

  function isListed(key: CharacterKey | null): key is CharacterKey {
    return (
      key !== null && characters().some((character) => character.key === key)
    );
  }

  function current(): DemoModeView {
    const listed = characters();
    const kept = remembered();
    return {
      on,
      state,
      character: on
        ? inUse
        : listed.some((character) => character.key === kept)
          ? kept
          : null,
      characters: listed,
    };
  }

  let last = current();

  function notify(): void {
    const next = current();
    if (sameView(next, last)) {
      return;
    }
    last = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (error) {
        log(`a demo mode listener failed (${errorCode(error)})`, 'error');
      }
    }
  }

  function remember(key: CharacterKey): void {
    const { rev, values } = settings.get();
    if (values.demoCharacter === key) {
      return;
    }
    try {
      settings.patch({
        baseRev: rev,
        ops: [{ op: 'set', field: 'demoCharacter', value: key }],
      });
    } catch (error) {
      log(
        `remembering the demo character failed (${errorCode(error)})`,
        'error',
      );
    }
  }

  /**
   * Clears the stage for `key` (null: no character), shows `next` on the
   * demo session and remembers `key`, as one change.
   */
  function show(key: CharacterKey | null, next: StateCode): void {
    const starting = !on;
    // Set first: remembering is a settings change, whose listeners (this
    // one's included) may read view() before the batch ends.
    on = true;
    state = next;
    inUse = key;
    batch(() => {
      assigner.setDemo({ characterKey: key });
      detection.setDemo(next);
      if (key !== null) {
        remember(key);
      }
    });
    log(
      starting
        ? `demo mode on (${key === null ? 'no character installed' : 'a character picked'})`
        : 'demo mode: a character picked',
    );
    notify();
  }

  function turnOff(reason?: string): void {
    if (!on) {
      return;
    }
    on = false;
    state = null;
    inUse = null;
    batch(() => {
      detection.setDemo(null);
      assigner.setDemo(null);
    });
    log(reason === undefined ? 'demo mode off' : `demo mode off: ${reason}`);
    notify();
  }

  return {
    view: () => last,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    pickCharacter(key) {
      if (!isListed(key)) {
        log('demo mode: the character picked is not installed', 'warn');
        return;
      }
      show(key, DEMO_START_STATE);
    },

    pickState(next) {
      if (on) {
        state = next;
        batch(() => {
          detection.setDemo(next);
        });
        notify();
        return;
      }
      const kept = remembered();
      if (isListed(kept)) {
        show(kept, next);
        return;
      }
      const listed = characters();
      if (listed.length === 0) {
        show(null, next);
        return;
      }
      log('demo mode: asking which character to show');
      chooseCharacter(listed, (key) => {
        if (!isListed(key)) {
          log('demo mode: the character picked is not installed', 'warn');
          return;
        }
        show(key, next);
      });
    },

    stop() {
      turnOff();
    },

    watch() {
      if (watching) {
        return;
      }
      watching = true;
      packs.onChange(() => {
        if (on && inUse !== null && !isListed(inUse)) {
          turnOff('its character is no longer installed');
          return;
        }
        notify();
      });
      settings.onChange(() => {
        notify();
      });
    },
  };
}
