/**
 * overlay/renderer/badges (Story 3.8): the stage's own name tag and state
 * badge, as numbers and painting calls on a fake 2D context: its layout
 * (two lines, the name cut to fit), how an inferred state looks otherwise,
 * the resolution it is painted at, and its texture's key.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BADGE_BACKGROUND,
  BADGE_CORNER_RADIUS,
  BADGE_DOT_GAP,
  BADGE_DOT_RADIUS,
  BADGE_ELLIPSIS,
  BADGE_INFERRED_MARK,
  BADGE_LINE_HEIGHT,
  BADGE_NAME_COLOR,
  BADGE_NAME_FONT,
  BADGE_NAME_MAX_WIDTH,
  BADGE_PADDING_X,
  BADGE_PADDING_Y,
  BADGE_RING_WIDTH,
  BADGE_STACK_GAP,
  BADGE_STATE_COLORS,
  BADGE_STATE_FONT,
  type BadgeBox,
  type BadgeContent,
  badgeKey,
  badgeLayout,
  fitText,
  type MeasureText,
  measureWith,
  paintBadge,
  stackBadges,
} from '../../src/overlay/renderer/badges';
import { STATE_CODES, STATE_DISPLAY_NAMES } from '../../src/shared/states';
import {
  FAKE_CHAR_WIDTH,
  recordingBadgeContext,
} from '../helpers/fake-badge-canvas';

/** FAKE_CHAR_WIDTH DIP a code point, whatever the font. */
const measure: MeasureText = (_font, text) =>
  Array.from(text).length * FAKE_CHAR_WIDTH;

const width = (text: string): number => measure(BADGE_NAME_FONT, text);

function content(overrides: Partial<BadgeContent> = {}): BadgeContent {
  return {
    name: 'gundam-pet',
    state: 'working',
    confidence: 'exact',
    ...overrides,
  };
}

/** What painting `badge` at `resolution` calls, one line each. */
function painted(badge: BadgeContent, resolution = 1): string[] {
  const calls: string[] = [];
  paintBadge(
    recordingBadgeContext(calls),
    badgeLayout(badge, measure),
    resolution,
  );
  return calls;
}

const HEIGHT = BADGE_PADDING_Y * 2 + BADGE_LINE_HEIGHT * 2;
const DOT_WIDTH = BADGE_DOT_RADIUS * 2 + BADGE_DOT_GAP;

describe('I/O matrix', () => {
  it('出現: two lines, each centred: the dot and the state’s name, then the session’s name; the tag as wide as its widest line and the padding, in whole DIP', () => {
    // gundam-pet, the widest line; 工作中 after the dot.
    const name = width('gundam-pet');
    const first = DOT_WIDTH + width('工作中');
    const tag = name + BADGE_PADDING_X * 2;
    const layout = badgeLayout(content(), measure);

    expect(first).toBeLessThan(name);
    expect(layout).toStrictEqual({
      width: tag,
      height: HEIGHT,
      color: BADGE_STATE_COLORS.working,
      hollow: false,
      dot: {
        x: (tag - first) / 2 + BADGE_DOT_RADIUS,
        y: BADGE_PADDING_Y + BADGE_LINE_HEIGHT / 2,
      },
      stateText: '工作中',
      stateAt: {
        x: (tag - first) / 2 + DOT_WIDTH,
        y: BADGE_PADDING_Y + BADGE_LINE_HEIGHT / 2,
      },
      nameText: 'gundam-pet',
      nameAt: {
        x: BADGE_PADDING_X,
        y: BADGE_PADDING_Y + BADGE_LINE_HEIGHT * 1.5,
      },
    });
  });

  it('出現: a short name: the first line is the widest, the name centred under it; a width not whole is rounded up', () => {
    const halves: MeasureText = (font, text) =>
      measure(font, text) + (font === BADGE_STATE_FONT ? 0.5 : 0);
    const layout = badgeLayout(
      content({ name: 'ab', state: 'approval' }),
      halves,
    );

    // 要你批准: 24.5 after the dot.
    const first = DOT_WIDTH + 24.5;
    expect(layout.width).toBe(Math.ceil(first + BADGE_PADDING_X * 2));
    expect(layout.nameAt.x).toBe((layout.width - 12) / 2);
    expect(layout.dot.x).toBe((layout.width - first) / 2 + BADGE_DOT_RADIUS);
  });

  it('狀態名: every state’s name comes from STATE_DISPLAY_NAMES, in its own colour, each colour different', () => {
    for (const state of STATE_CODES) {
      const layout = badgeLayout(content({ state }), measure);
      expect(layout.stateText).toBe(STATE_DISPLAY_NAMES[state]);
      expect(layout.color).toBe(BADGE_STATE_COLORS[state]);
    }
    expect(Object.keys(BADGE_STATE_COLORS).sort()).toStrictEqual(
      [...STATE_CODES].sort(),
    );
    expect(new Set(Object.values(BADGE_STATE_COLORS)).size).toBe(
      STATE_CODES.length,
    );
    expect(Object.isFrozen(BADGE_STATE_COLORS)).toBe(true);
  });

  it('畫法: scaled to the resolution, a dark half-clear tag with round corners, a full dot and the state’s name in its colour, the name under it in the name colour, in the system’s fonts', () => {
    const layout = badgeLayout(content(), measure);
    const { dot, stateAt, nameAt } = layout;

    expect(painted(content(), 2)).toStrictEqual([
      'setTransform 2 0 0 2 0 0',
      'beginPath',
      `roundRect 0 0 ${layout.width} ${HEIGHT} ${BADGE_CORNER_RADIUS}`,
      `fill ${BADGE_BACKGROUND}`,
      'beginPath',
      `arc ${dot.x} ${dot.y} ${BADGE_DOT_RADIUS} 0 ${2 * Math.PI}`,
      `fill ${BADGE_STATE_COLORS.working}`,
      `fillText "工作中" ${stateAt.x} ${stateAt.y} ${BADGE_STATE_COLORS.working} ${BADGE_STATE_FONT} left middle`,
      `fillText "gundam-pet" ${nameAt.x} ${nameAt.y} ${BADGE_NAME_COLOR} ${BADGE_NAME_FONT} left middle`,
    ]);
    expect(BADGE_BACKGROUND).toMatch(/^rgba\(\d+, \d+, \d+, 0\.\d+\)$/);
    for (const font of [BADGE_STATE_FONT, BADGE_NAME_FONT]) {
      expect(font).toMatch(/system-ui/);
      expect(font).not.toMatch(/url\(|https?:/);
    }
  });

  it('推測: an inferred state: the dot is a ring (stroked in the state’s colour, its outer edge where the full dot’s is) and ？ follows the state’s name; the rest as an exact one', () => {
    const exact = badgeLayout(content(), measure);
    const inferred = badgeLayout(content({ confidence: 'inferred' }), measure);

    expect(inferred.hollow).toBe(true);
    expect(inferred.stateText).toBe(`工作中${BADGE_INFERRED_MARK}`);
    expect(BADGE_INFERRED_MARK).toBe('？');
    expect([inferred.nameText, inferred.color]).toStrictEqual([
      exact.nameText,
      exact.color,
    ]);
    const calls = painted(content({ confidence: 'inferred' }));
    const { dot } = inferred;
    expect(calls).toContain(
      `arc ${dot.x} ${dot.y} ${BADGE_DOT_RADIUS - BADGE_RING_WIDTH / 2} 0 ${2 * Math.PI}`,
    );
    expect(calls).toContain(
      `stroke ${BADGE_STATE_COLORS.working} ${BADGE_RING_WIDTH}`,
    );
    expect(calls).not.toContain(`fill ${BADGE_STATE_COLORS.working}`);
    expect(calls.join('\n')).toContain('fillText "工作中？"');
    // Told apart from the exact one.
    expect(calls).not.toStrictEqual(painted(content()));
  });

  it('太長: a name wider than BADGE_NAME_MAX_WIDTH is cut to fit with … at its end; the tag is no wider than that and the padding', () => {
    const name = '3f2a9c1e-5b7d-4e60-9a1b-c0ffee123456';
    const layout = badgeLayout(content({ name }), measure);

    expect(width(name)).toBeGreaterThan(BADGE_NAME_MAX_WIDTH);
    expect(layout.nameText.endsWith(BADGE_ELLIPSIS)).toBe(true);
    expect(name.startsWith(layout.nameText.slice(0, -1))).toBe(true);
    expect(width(layout.nameText)).toBeLessThanOrEqual(BADGE_NAME_MAX_WIDTH);
    // The longest start that fits: one code point more would not.
    expect(
      width(`${name.slice(0, layout.nameText.length)}${BADGE_ELLIPSIS}`),
    ).toBeGreaterThan(BADGE_NAME_MAX_WIDTH);
    expect(layout.width).toBeLessThanOrEqual(
      BADGE_NAME_MAX_WIDTH + BADGE_PADDING_X * 2,
    );
  });

  it('太長: fitText keeps a text that fits (to its last DIP) as it is, cuts between characters (never inside a surrogate pair), drops spaces before …, and gives … alone when nothing else fits', () => {
    const count = (text: string): number => Array.from(text).length;

    expect(fitText('abcd', 4, count)).toBe('abcd');
    expect(fitText('abcde', 4, count)).toBe('abc…');
    expect(fitText('😀😀😀😀😀', 4, count)).toBe('😀😀😀…');
    expect(fitText('ab  cdef', 5, count)).toBe('ab…');
    expect(fitText('abc', 1, count)).toBe('…');
    expect(fitText('abc', 0, count)).toBe('…');
    expect(fitText('', 0, count)).toBe('');
  });

  it('太長: fitText cuts between graphemes: a ZWJ family emoji, a flag or a letter with a combining mark at the cut point is kept whole or dropped whole, never cut in half', () => {
    // Measured by code point, so a cut inside one would have fitted.
    const count = (text: string): number => Array.from(text).length;
    const family = '👨‍👩‍👧';
    const flag = '🇹🇼';
    const accented = 'e\u0301';

    expect(Array.from(family)).toHaveLength(5);
    expect(fitText(`ab${family}cd`, 6, count)).toBe('ab…');
    expect(fitText(`ab${family}cd`, 8, count)).toBe(`ab${family}…`);
    expect(Array.from(flag)).toHaveLength(2);
    expect(fitText(`ab${flag}cd`, 4, count)).toBe('ab…');
    expect(fitText(`ab${flag}cd`, 5, count)).toBe(`ab${flag}…`);
    expect(fitText(`a${accented}b`, 3, count)).toBe('a…');
  });

  it('沒名字 / 改名: the tag shows whatever name it is given (scene.ts gives the native id when there is no display name)', () => {
    expect(badgeLayout(content({ name: 'abc:def' }), measure).nameText).toBe(
      'abc:def',
    );
    expect(painted(content({ name: 'renamed' })).join('\n')).toContain(
      'fillText "renamed"',
    );
  });
});

describe('the parts', () => {
  it('measureWith measures in the font asked for', () => {
    const context = recordingBadgeContext([]);
    const fonts: string[] = [];
    context.measureText = (text) => {
      fonts.push(context.font);
      return { width: text.length };
    };
    const measured = measureWith(context);

    expect(measured(BADGE_STATE_FONT, 'abc')).toBe(3);
    expect(measured(BADGE_NAME_FONT, 'ab')).toBe(2);
    expect(fonts).toStrictEqual([BADGE_STATE_FONT, BADGE_NAME_FONT]);
  });

  it('badgeKey: the same content at the same resolution has the same key; any field or the resolution changed, another; names cannot run into the other fields', () => {
    const key = badgeKey(content(), 2);

    expect(badgeKey(content(), 2)).toBe(key);
    const others = [
      badgeKey(content(), 1),
      badgeKey(content({ name: 'other' }), 2),
      badgeKey(content({ state: 'done' }), 2),
      badgeKey(content({ confidence: 'inferred' }), 2),
      badgeKey(content({ name: '","working' }), 2),
    ];
    expect(new Set([key, ...others]).size).toBe(others.length + 1);
  });

  it('stackBadges: tags stacked near the canvas’s top go up a level while they can; one that would go above the top stays at 0, overlapping the one there (the canvas edge wins), and the next is placed against it', () => {
    const tag = (top: number): BadgeBox => ({
      left: 100,
      top,
      width: 80,
      height: HEIGHT,
    });
    const level = HEIGHT + BADGE_STACK_GAP;

    const placed = stackBadges([tag(50), tag(50), tag(50), tag(50)], 1000);

    // 50, then 50 - 36 = 14, then -22 and -58: at the top.
    expect(placed.map((box) => box.top)).toStrictEqual([50, 50 - level, 0, 0]);
    expect(placed.every((box) => box.top >= 0)).toBe(true);
    // Lower down, the same tags each get a level of their own.
    expect(
      stackBadges([tag(500), tag(500), tag(500)], 1000).map((box) => box.top),
    ).toStrictEqual([500, 500 - level, 500 - level * 2]);
  });

  it('it is plain functions: the module imports no PixiJS and loads nothing', () => {
    const source = readFileSync(
      new URL('../../src/overlay/renderer/badges.ts', import.meta.url),
      'utf8',
    );
    const imports = [
      ...source.matchAll(/^import[\s\S]*?from '([^']+)';$/gm),
    ].map((match) => match[1]);
    expect(imports).toStrictEqual([
      '../../shared/detection-events',
      '../../shared/states',
    ]);
    expect(source).not.toMatch(/https?:|url\(|fetch\(|new Image|FontFace/);
  });
});
