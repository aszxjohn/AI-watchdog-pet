// StageView subscription for a preload (AD-20). Besides invoke.ts, the only
// preload file allowed to import ipcRenderer, and only to listen for the
// `stage-view:delta` push (lint cannot narrow it to `on` / `removeListener`;
// review is the backstop). Sandboxed: only electron's renderer API and
// src/shared, no Node globals.
//
// - Every listener in this renderer shares one subscription: one delta
//   listener and one snapshot request, however many listeners there are.
// - Subscribing fetches a snapshot (`stage-view:subscribe`, which also
//   registers this webContents for pushes). Deltas that arrive before the
//   snapshot are held, then applied on top of it; deltas at or below the
//   snapshot's rev are dropped.
// - A delta that fails the shared schema, or whose rev is not the current
//   rev + 1, starts a new snapshot fetch. Until it arrives, deltas are held
//   and listeners keep the last consistent state they were given.
// - A failed snapshot fetch is reported to each listener's onError; the next
//   delta that arrives retries it.
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  stageViewDelta,
  stageViewSubscribe,
  type IpcError,
} from '../shared/ipc';
import {
  applyStageViewDelta,
  type StageViewDelta,
  type StageViewSnapshot,
} from '../shared/stage-view';
import { invoke } from './invoke';

export type StageViewListener = (snapshot: StageViewSnapshot) => void;
export type StageViewErrorListener = (error: IpcError) => void;

interface Entry {
  readonly listener: StageViewListener;
  readonly onError: StageViewErrorListener | undefined;
  /** Whether this listener has been given any state yet. */
  delivered: boolean;
}

const entries = new Set<Entry>();
/** The consistent state listeners last saw, or null while (re)fetching. */
let current: StageViewSnapshot | null = null;
/** Deltas received while `current` is null. */
let pending: StageViewDelta[] = [];
let fetching = false;
/** Bumped when the last listener leaves, so a late snapshot is ignored. */
let generation = 0;

function deliver(entry: Entry, snapshot: StageViewSnapshot): void {
  entry.delivered = true;
  try {
    entry.listener(snapshot);
  } catch (error) {
    console.error('[awp] stage-view listener threw', error);
  }
}

function notify(snapshot: StageViewSnapshot): void {
  for (const entry of entries) {
    deliver(entry, snapshot);
  }
}

function notifyError(error: IpcError): void {
  for (const entry of entries) {
    try {
      entry.onError?.(error);
    } catch (thrown) {
      console.error('[awp] stage-view onError threw', thrown);
    }
  }
}

async function fetchSnapshot(): Promise<void> {
  fetching = true;
  const requestGeneration = generation;
  const result = await invoke(stageViewSubscribe);
  if (requestGeneration !== generation) {
    return;
  }
  fetching = false;
  if (!result.ok) {
    pending = [];
    console.error(
      `[awp] ${stageViewSubscribe.channel}: ${result.error.code}: ${result.error.message}`,
    );
    notifyError(result.error);
    return;
  }
  current = result.data;
  const held = pending.sort((a, b) => a.rev - b.rev);
  pending = [];
  notify(current);
  // A listener may have unsubscribed the last entry from inside notify.
  if (requestGeneration !== generation) {
    return;
  }
  for (const delta of held) {
    receive(delta);
  }
}

/** Drops the current state and fetches a new snapshot (unless one is on its way). */
function resync(): void {
  current = null;
  if (!fetching) {
    void fetchSnapshot();
  }
}

function receive(delta: StageViewDelta): void {
  if (current === null) {
    pending.push(delta);
    if (!fetching) {
      void fetchSnapshot();
    }
    return;
  }
  if (delta.rev <= current.rev) {
    return;
  }
  if (delta.rev !== current.rev + 1) {
    console.error(
      `[awp] ${stageViewDelta.channel}: expected rev ${current.rev + 1}, got ${delta.rev}; fetching a new snapshot`,
    );
    resync();
    return;
  }
  current = {
    rev: delta.rev,
    view: applyStageViewDelta(current.view, delta.sections),
  };
  notify(current);
}

function onDelta(_event: IpcRendererEvent, payload: unknown): void {
  const parsed = stageViewDelta.payload.safeParse(payload);
  if (!parsed.success) {
    console.error(
      `[awp] ${stageViewDelta.channel}: payload does not match its schema; fetching a new snapshot`,
    );
    resync();
    return;
  }
  receive(parsed.data);
}

/**
 * Calls `listener` with the snapshot, then with the state after each delta.
 * Returns a function that unsubscribes this listener; when the last one
 * leaves, the shared subscription stops listening.
 */
export function subscribeStageView(
  listener: StageViewListener,
  onError?: StageViewErrorListener,
): () => void {
  const entry: Entry = { listener, onError, delivered: false };
  entries.add(entry);
  if (entries.size === 1) {
    ipcRenderer.on(stageViewDelta.channel, onDelta);
  }
  if (current !== null) {
    // A later listener joins an existing subscription: give it the current
    // state, unless a delta has already reached it by then.
    queueMicrotask(() => {
      if (entries.has(entry) && !entry.delivered && current !== null) {
        deliver(entry, current);
      }
    });
  } else if (!fetching) {
    void fetchSnapshot();
  }

  let subscribed = true;
  return () => {
    if (!subscribed) {
      return;
    }
    subscribed = false;
    entries.delete(entry);
    if (entries.size === 0) {
      ipcRenderer.removeListener(stageViewDelta.channel, onDelta);
      generation += 1;
      current = null;
      pending = [];
      fetching = false;
    }
  };
}
