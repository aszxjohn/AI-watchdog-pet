/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

// Forge's Vite plugin defines `<NAME>_VITE_*` for each renderer in
// forge.config.mts; its own typings only declare the template's
// `MAIN_WINDOW_*`. Read these only in src/main/windows (AD-24).
declare global {
  /**
   * The panels Vite dev server URL under `npm start`; `undefined` in a
   * packaged build. Not defined at all outside a Forge build (unit tests).
   */
  const PANELS_VITE_DEV_SERVER_URL: string | undefined;
  /** `panels`: the folder under .vite/renderer the panels build lands in. */
  const PANELS_VITE_NAME: string;
}

export {};
