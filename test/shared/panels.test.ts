import { describe, expect, it } from 'vitest';
import {
  MAIN_PANEL_PAGE,
  PANEL_PAGE_IDS,
  PANEL_PAGES,
  panelPageFromHash,
  panelPageHash,
  panelPageIdSchema,
} from '../../src/shared/panels';
import { expectRejected, expectRoundTrip } from './schema-helpers';

describe('panel pages', () => {
  it('lists sessions, packs and settings with their labels, in menu order', () => {
    expect(PANEL_PAGES).toStrictEqual([
      { id: 'sessions', label: '管理 session' },
      { id: 'packs', label: '角色包' },
      { id: 'settings', label: '舞台設定' },
    ]);
    expect(PANEL_PAGES.map((page) => page.id)).toStrictEqual([
      ...PANEL_PAGE_IDS,
    ]);
  });

  it('cannot be changed', () => {
    expect(Object.isFrozen(PANEL_PAGES)).toBe(true);
    for (const page of PANEL_PAGES) {
      expect(Object.isFrozen(page)).toBe(true);
    }
  });

  it('has 管理 session as the main panel page', () => {
    expect(MAIN_PANEL_PAGE).toBe('sessions');
  });

  it('uses English codes for ids', () => {
    for (const id of PANEL_PAGE_IDS) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
    }
  });
});

describe('panelPageIdSchema', () => {
  it.each(PANEL_PAGE_IDS.map((id) => [id]))('round-trips %j', (id) => {
    expectRoundTrip(panelPageIdSchema, id);
  });

  it.each([
    ['Sessions'],
    ['管理 session'],
    ['editor'],
    [''],
    [' sessions'],
    [null],
    [undefined],
    [0],
    [{ id: 'sessions' }],
  ])('rejects %j', (value) => {
    expectRejected(panelPageIdSchema, value);
  });
});

describe('page hash', () => {
  it.each(PANEL_PAGE_IDS.map((id) => [id]))(
    'round-trips %s through the URL fragment',
    (id) => {
      expect(panelPageHash(id)).toBe(`#/${id}`);
      expect(panelPageFromHash(panelPageHash(id))).toBe(id);
    },
  );

  it.each([
    [''],
    ['#'],
    ['#/'],
    ['#sessions'],
    ['/sessions'],
    ['#/Sessions'],
    ['#/editor'],
    ['#/sessions/'],
    ['#/sessions?x=1'],
    ['#//sessions'],
  ])('reads %j as no page', (hash) => {
    expect(panelPageFromHash(hash)).toBeUndefined();
  });
});
