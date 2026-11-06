import { z } from './zod-setup';

/**
 * The panel pages (FR7, AD-14). The tray menu (main/windows/menu.ts) and the
 * panel's side navigation (src/panels) both list pages from here, so the
 * English ids and the Chinese labels are defined once. Code compares ids;
 * labels are for display only.
 */

/** Page ids, in menu and navigation order. */
export const PANEL_PAGE_IDS = ['sessions', 'packs', 'settings'] as const;

export const panelPageIdSchema = z.enum(PANEL_PAGE_IDS);

export type PanelPageId = z.infer<typeof panelPageIdSchema>;

export interface PanelPage {
  readonly id: PanelPageId;
  /** Chinese display name, shown in the tray menu and the panel. */
  readonly label: string;
}

const PANEL_PAGE_LABELS: Readonly<Record<PanelPageId, string>> = Object.freeze({
  sessions: '管理 session',
  packs: '角色包',
  settings: '舞台設定',
});

/** Every page with its label, in PANEL_PAGE_IDS order. */
export const PANEL_PAGES: readonly PanelPage[] = Object.freeze(
  PANEL_PAGE_IDS.map((id) =>
    Object.freeze({ id, label: PANEL_PAGE_LABELS[id] }),
  ),
);

/** The page a second launch, macOS `activate` or an unknown hash opens. */
export const MAIN_PANEL_PAGE: PanelPageId = 'sessions';

/**
 * The URL fragment that selects `page` in the panel window: `#/<id>`. Main
 * builds load URLs with it and the panel's navigation links use it.
 */
export function panelPageHash(page: PanelPageId): string {
  return `#/${page}`;
}

/**
 * The page a URL fragment selects (`#/packs` -> `packs`), or undefined when
 * the fragment is not `#/<page id>`.
 */
export function panelPageFromHash(hash: string): PanelPageId | undefined {
  if (!hash.startsWith('#/')) {
    return undefined;
  }
  const parsed = panelPageIdSchema.safeParse(hash.slice(2));
  return parsed.success ? parsed.data : undefined;
}
