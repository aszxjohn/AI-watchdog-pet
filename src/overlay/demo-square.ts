/**
 * overlay/demo-square: a coloured square standing in for the demo session's
 * character, so Epic 2's acceptance can right-click it on the canvas to pick
 * a demo state. For acceptance only: Epic 3 removes it once real characters
 * are on the canvas, and keeps pointer.ts and the `canvas:*` channels.
 *
 * Pure: what to draw, from StageView alone (the `sessions` section names
 * the demo session and its state; `canvas` gives the world size). No DOM,
 * no PixiJS; main.ts draws it.
 *
 * - It is there only while a session with source `demo` is (demo mode on)
 *   and the canvas is placed; otherwise there is nothing to draw.
 * - It sits near the world's bottom-right corner, DEMO_SQUARE_SIZE DIP a
 *   side, DEMO_SQUARE_RIGHT_MARGIN DIP from the right edge and
 *   DEMO_SQUARE_BOTTOM_MARGIN DIP above the bottom edge, clear of a
 *   Windows taskbar (48 DIP) or a macOS Dock at the bottom; it cannot be
 *   dragged. The world is the whole display, so this is a fixed guess:
 *   placing things inside the display's work area is left for Epic 3's
 *   characters.
 * - Its colour is its state's; on it, the state's Chinese name (from
 *   src/shared/states.ts) in white, or in a dark colour on the fills too
 *   light for white (`approval`, `decision`, `done`, `waiting`).
 */
import type { SessionKey } from '../shared/detection-events';
import type { StageView } from '../shared/stage-view';
import { STATE_DISPLAY_NAMES, type StateCode } from '../shared/states';
import type { HitArea } from './pointer';

/** The square's side, in DIP. */
export const DEMO_SQUARE_SIZE = 120;

/** How far the square stays from the world's right edge, in DIP. */
export const DEMO_SQUARE_RIGHT_MARGIN = 24;

/**
 * How far the square stays above the world's bottom edge, in DIP: past a
 * Windows taskbar (48 DIP) or a bottom macOS Dock.
 */
export const DEMO_SQUARE_BOTTOM_MARGIN = 96;

/** Each state's fill (acceptance only). */
export const DEMO_SQUARE_COLORS: Readonly<Record<StateCode, string>> =
  Object.freeze({
    thinking: '#7c4dff',
    working: '#2979ff',
    approval: '#ff6d00',
    decision: '#ffd600',
    error: '#d50000',
    done: '#00c853',
    waiting: '#b0bec5',
    idle: '#546e7a',
  });

/** The label colour on most fills. */
export const DEMO_SQUARE_LIGHT_TEXT = '#ffffff';

/**
 * The label colour on the fills too light for white text (`approval`,
 * `decision`, `done`, `waiting`).
 */
export const DEMO_SQUARE_DARK_TEXT = '#212121';

/** The states whose fill is too light for white text. */
const LIGHT_FILLS: ReadonlySet<StateCode> = new Set([
  'approval',
  'decision',
  'done',
  'waiting',
]);

/** What to draw for the demo session. */
export interface DemoSquare {
  readonly sessionKey: SessionKey;
  readonly state: StateCode;
  /** The top-left corner, in world DIP. */
  readonly x: number;
  readonly y: number;
  /** The side, in DIP. */
  readonly size: number;
  readonly fill: string;
  readonly textColor: string;
  /** The state's Chinese name. */
  readonly label: string;
}

/**
 * The demo square for `view`: the first session whose source is `demo`,
 * placed near the world's bottom-right corner. Null when there is no demo
 * session or no canvas yet. A world too small for the margins keeps it at
 * the top-left edge rather than off-screen.
 */
export function demoSquare(
  view: Pick<StageView, 'canvas' | 'sessions'>,
): DemoSquare | null {
  const { canvas } = view;
  if (canvas === null) {
    return null;
  }
  const session = view.sessions.find((entry) => entry.source === 'demo');
  if (session === undefined) {
    return null;
  }
  const { state } = session;
  return {
    sessionKey: session.sessionKey,
    state,
    x: Math.max(
      0,
      canvas.bounds.width - DEMO_SQUARE_SIZE - DEMO_SQUARE_RIGHT_MARGIN,
    ),
    y: Math.max(
      0,
      canvas.bounds.height - DEMO_SQUARE_SIZE - DEMO_SQUARE_BOTTOM_MARGIN,
    ),
    size: DEMO_SQUARE_SIZE,
    fill: DEMO_SQUARE_COLORS[state],
    textColor: LIGHT_FILLS.has(state)
      ? DEMO_SQUARE_DARK_TEXT
      : DEMO_SQUARE_LIGHT_TEXT,
    label: STATE_DISPLAY_NAMES[state],
  };
}

/** The areas that take the mouse: the square, named by its session; none without one. */
export function demoSquareAreas(
  square: DemoSquare | null,
): readonly HitArea<SessionKey>[] {
  if (square === null) {
    return [];
  }
  return [
    {
      key: square.sessionKey,
      x: square.x,
      y: square.y,
      width: square.size,
      height: square.size,
    },
  ];
}
