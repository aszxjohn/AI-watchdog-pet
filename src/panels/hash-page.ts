/**
 * Which panel page the URL fragment selects, following later changes. Main
 * opens or switches the panel by loading `#/<page id>`, and the side
 * navigation links change it, so this listener is what makes a tray menu
 * choice show up on screen. No React and no DOM types, so it is unit-tested
 * under Node.
 */
import {
  MAIN_PANEL_PAGE,
  panelPageFromHash,
  type PanelPageId,
} from '../shared/panels';

/** The parts of `window` this reads. */
export interface HashTarget {
  readonly location: { readonly hash: string };
  addEventListener(type: 'hashchange', listener: () => void): void;
  removeEventListener(type: 'hashchange', listener: () => void): void;
}

/** The page `target`'s fragment selects; the main page for any other. */
export function currentHashPage(target: HashTarget): PanelPageId {
  return panelPageFromHash(target.location.hash) ?? MAIN_PANEL_PAGE;
}

/**
 * Calls `onPage` with the current page, then again on every `hashchange`.
 * Returns a function that stops listening.
 */
export function followHashPage(
  target: HashTarget,
  onPage: (page: PanelPageId) => void,
): () => void {
  const listener = (): void => {
    onPage(currentHashPage(target));
  };
  target.addEventListener('hashchange', listener);
  listener();
  return () => {
    target.removeEventListener('hashchange', listener);
  };
}
