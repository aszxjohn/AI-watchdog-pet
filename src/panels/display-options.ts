/**
 * The choices of the 舞台設定 page's 畫布所在螢幕 setting, built from
 * StageView alone (AD-20): the panel never keeps its own copy of the
 * setting. No React and no DOM types, so it is unit-tested under Node.
 *
 * - First, 主螢幕（跟著系統設定）: the value null.
 * - Then every connected display: its name and width × height, the primary
 *   one marked ・目前的主螢幕.
 * - When the setting names a display that is not connected, one more
 *   option, 螢幕 <id>（未連接，暫用主螢幕）, which is the selected one.
 *
 * Also here: what choosing an option does (createDisplayChooser) and the
 * status bar's StageView line (stageViewStatusText).
 */
import type { IpcError, IpcResult } from '../shared/ipc';
import type { SettingsPatch, SettingsPatchResult } from '../shared/settings';
import type {
  StageDisplay,
  StageView,
  StageViewSnapshot,
} from '../shared/stage-view';

export interface DisplayOption {
  /**
   * Stable key, also the radio value: `primary`, `display-<id>`, or
   * `missing-<id>` for a chosen display that is not connected.
   */
  readonly key: string;
  /** The `canvasDisplayId` choosing it sets; null is the primary display. */
  readonly value: number | null;
  /** What the page shows. */
  readonly label: string;
}

export interface DisplayChoices {
  readonly options: readonly DisplayOption[];
  /** Key of the option the current setting selects. */
  readonly selected: string;
}

export const PRIMARY_OPTION_LABEL = '主螢幕（跟著系統設定）';

/** The display's own name; `螢幕 <id>` when it has none. */
function displayName(display: StageDisplay): string {
  return display.label.trim() === ''
    ? `螢幕 ${display.id}`
    : display.label.trim();
}

/** `Built-in Retina Display 1512×982・目前的主螢幕`; `螢幕 <id>` when unnamed. */
export function displayOptionLabel(display: StageDisplay): string {
  const name = displayName(display);
  const size = `${display.bounds.width}×${display.bounds.height}`;
  return `${name} ${size}${display.primary ? '・目前的主螢幕' : ''}`;
}

/** The options, in page order, and which one the setting selects. */
export function displayChoices(
  view: Pick<StageView, 'settings' | 'displays'>,
): DisplayChoices {
  const wanted = view.settings.values.canvasDisplayId;
  const options: DisplayOption[] = [
    { key: 'primary', value: null, label: PRIMARY_OPTION_LABEL },
    ...view.displays.map((display) => ({
      key: `display-${display.id}`,
      value: display.id,
      label: displayOptionLabel(display),
    })),
  ];
  if (wanted === null) {
    return { options, selected: 'primary' };
  }
  if (view.displays.some((display) => display.id === wanted)) {
    return { options, selected: `display-${wanted}` };
  }
  const missing: DisplayOption = {
    key: `missing-${wanted}`,
    value: wanted,
    label: `螢幕 ${wanted}（未連接，暫用主螢幕）`,
  };
  return { options: [...options, missing], selected: missing.key };
}

/**
 * The `settings:patch` that chooses `option`. `settingsRev` is the settings
 * rev in StageView, the rev the page last saw.
 */
export function displayPatch(
  settingsRev: number,
  option: DisplayOption,
): SettingsPatch {
  return {
    baseRev: settingsRev,
    ops: [{ op: 'set', field: 'canvasDisplayId', value: option.value }],
  };
}

/** What the page shows when a patch fails; the choice stays as it was. */
export function patchErrorText(error: IpcError | undefined): string {
  return error === undefined
    ? '無法變更畫布所在螢幕'
    : `無法變更畫布所在螢幕（${error.code}：${error.message}）`;
}

/** What the page shows around the options while a choice is sent. */
export interface DisplayChoiceState {
  /** A patch is on its way: the options are disabled. */
  readonly saving: boolean;
  /** Why the last choice failed, or null. */
  readonly error: string | null;
}

export const IDLE_DISPLAY_CHOICE: DisplayChoiceState = Object.freeze({
  saving: false,
  error: null,
});

/** The page as it is when an option is chosen. */
export interface CurrentChoice {
  /** Key of the option StageView selects now. */
  readonly selected: string;
  /** The settings rev in StageView. */
  readonly settingsRev: number;
}

export interface DisplayChooser {
  /**
   * Chooses `option`, unless it is already selected or a patch is still on
   * its way: reports `saving`, sends the patch, then reports the outcome.
   * The selection itself is never changed here; it comes back through
   * StageView (AD-20). Never rejects.
   */
  choose(option: DisplayOption, current: CurrentChoice): Promise<void>;
}

/**
 * The 舞台設定 page's choose logic. `patch` is `window.awp.settings.patch`;
 * `onState` hears every saving / error change.
 */
export function createDisplayChooser(
  patch: (patch: SettingsPatch) => Promise<IpcResult<SettingsPatchResult>>,
  onState: (state: DisplayChoiceState) => void,
  logError: (message: string, ...details: unknown[]) => void = console.error,
): DisplayChooser {
  let saving = false;
  return {
    async choose(option, current) {
      if (saving || option.key === current.selected) {
        return;
      }
      saving = true;
      onState({ saving: true, error: null });
      let error: string | null = null;
      try {
        const result = await patch(displayPatch(current.settingsRev, option));
        if (!result.ok) {
          logError(
            `[panels] settings:patch: ${result.error.code}: ${result.error.message}`,
          );
          error = patchErrorText(result.error);
        }
      } catch (thrown) {
        logError('[panels] settings:patch failed', thrown);
        error = patchErrorText(undefined);
      }
      saving = false;
      onState({ saving: false, error });
    },
  };
}

/**
 * Where the canvas actually is, from the StageView `canvas` section: 主螢幕
 * for the primary display, otherwise the display's name; （暫用主螢幕）
 * added while the chosen display is not connected; 尚未就緒 before main has
 * placed it.
 */
export function canvasDisplayText(
  view: Pick<StageView, 'displays' | 'canvas'>,
): string {
  const { canvas } = view;
  if (canvas === null) {
    return '尚未就緒';
  }
  const display = view.displays.find((d) => d.id === canvas.displayId);
  let name: string;
  if (display === undefined) {
    name = `螢幕 ${canvas.displayId}`;
  } else if (display.primary) {
    name = '主螢幕';
  } else {
    name = displayName(display);
  }
  return canvas.fallback ? `${name}（暫用主螢幕）` : name;
}

/** The status bar line: `StageView rev <n>｜畫布螢幕：<where the canvas is>`. */
export function stageViewStatusText(snapshot: StageViewSnapshot): string {
  return `StageView rev ${snapshot.rev}｜畫布螢幕：${canvasDisplayText(snapshot.view)}`;
}
