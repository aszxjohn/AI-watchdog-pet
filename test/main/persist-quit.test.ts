/**
 * main/persist's flushOnQuit with fake stores and an EventEmitter as the
 * app: what it registers and what it calls. main/pool's own test writes a
 * real assignments.json through it.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { flushOnQuit } from '../../src/main/persist/quit';

describe('flushOnQuit', () => {
  it('registers one will-quit listener and calls nothing before the app quits', () => {
    const app = new EventEmitter();
    const store = { flushSync: vi.fn() };

    flushOnQuit(app, store);

    expect(app.eventNames()).toStrictEqual(['will-quit']);
    expect(app.listenerCount('will-quit')).toBe(1);
    expect(store.flushSync).not.toHaveBeenCalled();
  });

  it('on will-quit, calls only the store’s flushSync, with no argument', () => {
    const app = new EventEmitter();
    const store = { flushSync: vi.fn(), patch: vi.fn() };

    flushOnQuit(app, store);
    app.emit('will-quit');

    expect(store.flushSync).toHaveBeenCalledExactlyOnceWith();
    expect(store.patch).not.toHaveBeenCalled();
  });

  it('several calls flush in the order they were made, before a will-quit listener added afterwards', () => {
    const app = new EventEmitter();
    const order: string[] = [];
    const store = (name: string) => ({
      flushSync: () => {
        order.push(`${name} flushed`);
      },
    });

    flushOnQuit(app, store('settings'));
    flushOnQuit(app, store('pool'));
    app.on('will-quit', () => {
      order.push('quit logged');
    });
    app.emit('will-quit');

    expect(order).toStrictEqual([
      'settings flushed',
      'pool flushed',
      'quit logged',
    ]);
  });
});
