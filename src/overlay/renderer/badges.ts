/**
 * overlay/renderer (Story 3.8): the stage's own name tag and state badge,
 * which pixi-stage.ts draws for each actor at its character's manifest
 * `anchor`. Plain functions over the parts of a 2D canvas they use: no
 * PixiJS and no DOM, so they are unit-tested under Node with a fake
 * context.
 *
 * - One dark, half-clear tag with round corners, two lines, each centred:
 *   the first a dot and the state's name (STATE_DISPLAY_NAMES), both in
 *   the state's colour (BADGE_STATE_COLORS); the second the session's
 *   name, in BADGE_NAME_COLOR. An inferred state (`confidence:
 *   inferred`): the dot is hollow (a ring) and BADGE_INFERRED_MARK follows
 *   the state's name.
 * - A name wider than BADGE_NAME_MAX_WIDTH is cut and ends with
 *   BADGE_ELLIPSIS (fitText), never inside a character (a grapheme: an
 *   emoji sequence, a flag, a letter with its combining marks).
 * - Its size is in DIP (badgeLayout), whole numbers, the same at any
 *   大小; paintBadge() paints it `resolution` device pixels to the DIP (the
 *   canvas display's scaleFactor), so it stays sharp.
 * - Text in the system's fonts (BADGE_FONT_FAMILY): nothing is loaded.
 * - stackBadges() places the tags: each kept inside the canvas, then, in
 *   order, moved up a level (its height and BADGE_STACK_GAP) while it
 *   intersects one placed before it; a tag that would go above the
 *   canvas's top stays at it, even overlapping another (the canvas edge
 *   wins).
 */
import type { Confidence } from '../../shared/detection-events';
import { STATE_DISPLAY_NAMES, type StateCode } from '../../shared/states';

/** What a tag shows. */
export interface BadgeContent {
  /** The session's name. */
  readonly name: string;
  readonly state: StateCode;
  readonly confidence: Confidence;
}

/** The system's fonts, Traditional Chinese ones named for the states. */
export const BADGE_FONT_FAMILY =
  'system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif';

/** The first line's font: the state's name. */
export const BADGE_STATE_FONT = `600 11px ${BADGE_FONT_FAMILY}`;

/** The second line's font: the session's name. */
export const BADGE_NAME_FONT = `11px ${BADGE_FONT_FAMILY}`;

/** Each line's height, DIP. */
export const BADGE_LINE_HEIGHT = 14;

/** The space left and right of the widest line, DIP. */
export const BADGE_PADDING_X = 6;

/** The space above the first line and below the second, DIP. */
export const BADGE_PADDING_Y = 3;

/** The tag's corner radius, DIP. */
export const BADGE_CORNER_RADIUS = 5;

/** The dot's radius, DIP. */
export const BADGE_DOT_RADIUS = 3;

/** The space between the dot and the state's name, DIP. */
export const BADGE_DOT_GAP = 4;

/** The hollow dot's line width, DIP. */
export const BADGE_RING_WIDTH = 1.5;

/** The widest a name is drawn, DIP; a wider one is cut. */
export const BADGE_NAME_MAX_WIDTH = 140;

/** The tag's colour: dark and half clear. */
export const BADGE_BACKGROUND = 'rgba(20, 20, 24, 0.9)';

/** The session's name's colour. */
export const BADGE_NAME_COLOR = '#f2f2f2';

/** The space between a tag and the one it is moved up above, DIP. */
export const BADGE_STACK_GAP = 2;

/** What follows an inferred state's name. */
export const BADGE_INFERRED_MARK = '？';

/** What ends a name cut short. */
export const BADGE_ELLIPSIS = '…';

/** Each state's colour, seen on the dark tag. */
export const BADGE_STATE_COLORS: Readonly<Record<StateCode, string>> =
  Object.freeze({
    waiting: '#ffd166',
    thinking: '#b39dff',
    working: '#5ee08a',
    approval: '#ff9f45',
    decision: '#ff7ac6',
    done: '#4cc9f0',
    idle: '#b8b8c0',
    error: '#ff5c5c',
  });

/** How wide `text` is in `font`, DIP (the 2D context's measureText). */
export type MeasureText = (font: string, text: string) => number;

/** A point in the tag, DIP from its top-left corner. */
export interface BadgePoint {
  readonly x: number;
  readonly y: number;
}

/** Where everything in a tag goes, DIP from its top-left corner. */
export interface BadgeLayout {
  /** The tag's size: whole numbers. */
  readonly width: number;
  readonly height: number;
  /** The state's colour. */
  readonly color: string;
  /** Whether the dot is hollow: the state is inferred. */
  readonly hollow: boolean;
  /** The dot's centre. */
  readonly dot: BadgePoint;
  /** The state's name, with BADGE_INFERRED_MARK when inferred. */
  readonly stateText: string;
  /** Where the state's name starts, at the middle of its line. */
  readonly stateAt: BadgePoint;
  /** The session's name, cut to BADGE_NAME_MAX_WIDTH. */
  readonly nameText: string;
  /** Where the session's name starts, at the middle of its line. */
  readonly nameAt: BadgePoint;
}

/** Splits a text into graphemes: what a reader sees as one character. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * `text` as it fits in `maxWidth` (as `measure` sees it): itself when it
 * does; otherwise its longest start (whole graphemes, spaces at its end
 * dropped) that fits with BADGE_ELLIPSIS after it, and the ellipsis.
 */
export function fitText(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
): string {
  if (measure(text) <= maxWidth) {
    return text;
  }
  const chars = Array.from(GRAPHEMES.segment(text), (each) => each.segment);
  const cut = (count: number): string =>
    `${chars.slice(0, count).join('').trimEnd()}${BADGE_ELLIPSIS}`;
  // The most graphemes kept: all of them do not fit.
  let low = 0;
  let high = chars.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(cut(mid)) <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return cut(low);
}

/** The tag for `content`, its text measured with `measure`. */
export function badgeLayout(
  content: BadgeContent,
  measure: MeasureText,
): BadgeLayout {
  const inferred = content.confidence === 'inferred';
  const stateText = `${STATE_DISPLAY_NAMES[content.state]}${
    inferred ? BADGE_INFERRED_MARK : ''
  }`;
  const nameText = fitText(content.name, BADGE_NAME_MAX_WIDTH, (text) =>
    measure(BADGE_NAME_FONT, text),
  );
  const dotWidth = BADGE_DOT_RADIUS * 2 + BADGE_DOT_GAP;
  const stateWidth = dotWidth + measure(BADGE_STATE_FONT, stateText);
  const nameWidth = measure(BADGE_NAME_FONT, nameText);
  const width = Math.ceil(
    Math.max(stateWidth, nameWidth) + BADGE_PADDING_X * 2,
  );
  const height = BADGE_PADDING_Y * 2 + BADGE_LINE_HEIGHT * 2;
  const firstLine = BADGE_PADDING_Y + BADGE_LINE_HEIGHT / 2;
  const secondLine = firstLine + BADGE_LINE_HEIGHT;
  const stateLeft = (width - stateWidth) / 2;
  return {
    width,
    height,
    color: BADGE_STATE_COLORS[content.state],
    hollow: inferred,
    dot: { x: stateLeft + BADGE_DOT_RADIUS, y: firstLine },
    stateText,
    stateAt: { x: stateLeft + dotWidth, y: firstLine },
    nameText,
    nameAt: { x: (width - nameWidth) / 2, y: secondLine },
  };
}

/** A tag's box, DIP: its top-left corner and its size. */
export interface BadgeBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Whether `a` and `b` overlap (touching edges do not). */
function intersects(a: BadgeBox, b: BadgeBox): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

/**
 * Where the tags `wanted` go, in the same order: each first kept inside
 * a canvas `canvasWidth` DIP wide (its left within 0 and canvasWidth −
 * its width, 0 when it is wider; its top at 0 or below), then, in order,
 * moved up a level (its height and BADGE_STACK_GAP) as many times as it
 * takes to intersect none placed before it, but never above the canvas's
 * top: there it stays at 0, even overlapping another. A tag that needs
 * none of this stays where it was wanted.
 */
export function stackBadges(
  wanted: readonly BadgeBox[],
  canvasWidth: number,
): BadgeBox[] {
  const placed: BadgeBox[] = [];
  for (const box of wanted) {
    let at: BadgeBox = {
      ...box,
      left: Math.max(0, Math.min(box.left, canvasWidth - box.width)),
      top: Math.max(0, box.top),
    };
    while (placed.some((other) => intersects(at, other))) {
      at = { ...at, top: at.top - at.height - BADGE_STACK_GAP };
    }
    // The canvas's top wins over overlapping.
    placed.push({ ...at, top: Math.max(0, at.top) });
  }
  return placed;
}

/**
 * The parts of a 2D canvas context (CanvasRenderingContext2D in the
 * overlay) a tag is measured and painted with.
 */
export interface BadgeContext {
  font: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  textAlign: string;
  textBaseline: string;
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
  beginPath(): void;
  roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radii: number,
  ): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
  ): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { readonly width: number };
}

/** A canvas (an HTMLCanvasElement in the overlay) to paint a tag on. */
export interface BadgeCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): BadgeContext | null;
}

/** `context`'s measureText as a MeasureText. */
export function measureWith(context: BadgeContext): MeasureText {
  return (font, text) => {
    context.font = font;
    return context.measureText(text).width;
  };
}

/**
 * Paints `layout` on `context`'s canvas (layout.width × layout.height DIP,
 * `resolution` device pixels to the DIP), which is clear.
 */
export function paintBadge(
  context: BadgeContext,
  layout: BadgeLayout,
  resolution: number,
): void {
  context.setTransform(resolution, 0, 0, resolution, 0, 0);
  context.fillStyle = BADGE_BACKGROUND;
  context.beginPath();
  context.roundRect(0, 0, layout.width, layout.height, BADGE_CORNER_RADIUS);
  context.fill();
  context.beginPath();
  if (layout.hollow) {
    // The ring's outer edge where the full dot's would be.
    context.arc(
      layout.dot.x,
      layout.dot.y,
      BADGE_DOT_RADIUS - BADGE_RING_WIDTH / 2,
      0,
      2 * Math.PI,
    );
    context.strokeStyle = layout.color;
    context.lineWidth = BADGE_RING_WIDTH;
    context.stroke();
  } else {
    context.arc(layout.dot.x, layout.dot.y, BADGE_DOT_RADIUS, 0, 2 * Math.PI);
    context.fillStyle = layout.color;
    context.fill();
  }
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.font = BADGE_STATE_FONT;
  context.fillStyle = layout.color;
  context.fillText(layout.stateText, layout.stateAt.x, layout.stateAt.y);
  context.font = BADGE_NAME_FONT;
  context.fillStyle = BADGE_NAME_COLOR;
  context.fillText(layout.nameText, layout.nameAt.x, layout.nameAt.y);
}

/** The key of `content`'s texture at `resolution`: same content, same key. */
export function badgeKey(content: BadgeContent, resolution: number): string {
  return JSON.stringify([
    resolution,
    content.state,
    content.confidence,
    content.name,
  ]);
}
