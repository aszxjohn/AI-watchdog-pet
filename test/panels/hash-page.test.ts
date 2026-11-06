import { describe, expect, it, vi } from 'vitest';
import {
  currentHashPage,
  followHashPage,
  type HashTarget,
} from '../../src/panels/hash-page';
import type { PanelPageId } from '../../src/shared/panels';

/** A stand-in for `window`: a fragment and its hashchange listeners. */
function fakeWindow(hash: string) {
  const listeners = new Set<() => void>();
  const target: HashTarget = {
    location: { hash },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    target,
    listeners,
    /** Changes the fragment and fires hashchange, as the browser does. */
    navigate(next: string) {
      (target.location as { hash: string }).hash = next;
      for (const listener of Array.from(listeners)) {
        listener();
      }
    },
  };
}

describe('currentHashPage', () => {
  it.each([
    ['#/sessions', 'sessions'],
    ['#/packs', 'packs'],
    ['#/settings', 'settings'],
    ['', 'sessions'],
    ['#/editor', 'sessions'],
    ['#packs', 'sessions'],
  ] as const)('%j -> %s', (hash, page) => {
    expect(currentHashPage(fakeWindow(hash).target)).toBe(page);
  });
});

describe('followHashPage', () => {
  it('reports the initial page at once', () => {
    const win = fakeWindow('#/packs');
    const onPage = vi.fn<(page: PanelPageId) => void>();
    followHashPage(win.target, onPage);
    expect(onPage.mock.calls).toStrictEqual([['packs']]);
  });

  it('reports the page after each hashchange', () => {
    const win = fakeWindow('#/sessions');
    const onPage = vi.fn<(page: PanelPageId) => void>();
    followHashPage(win.target, onPage);
    win.navigate('#/settings');
    win.navigate('#/packs');
    expect(onPage.mock.calls).toStrictEqual([
      ['sessions'],
      ['settings'],
      ['packs'],
    ]);
  });

  it('falls back to sessions for an unknown fragment', () => {
    const win = fakeWindow('#/packs');
    const onPage = vi.fn<(page: PanelPageId) => void>();
    followHashPage(win.target, onPage);
    win.navigate('#/no-such-page');
    expect(onPage).toHaveBeenLastCalledWith('sessions');
  });

  it('stops listening once cleaned up', () => {
    const win = fakeWindow('#/sessions');
    const onPage = vi.fn<(page: PanelPageId) => void>();
    const stop = followHashPage(win.target, onPage);
    expect(win.listeners.size).toBe(1);
    stop();
    expect(win.listeners.size).toBe(0);
    win.navigate('#/packs');
    expect(onPage).toHaveBeenCalledOnce();
  });
});
