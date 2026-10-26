import { app } from "electron";

/**
 * Start-with-Windows.
 *
 * In development the login item has to launch `electron.exe` with the project path as
 * an argument; in a packaged build it launches the installed executable directly.
 * `getLoginItemSettings()` is the same registry-backed record Windows uses, so the
 * checkbox reflects what the OS actually has stored rather than what we last set.
 */
export function isAutostartEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

export function setAutostartEnabled(enabled: boolean): void {
  const dev = Boolean(process.defaultApp);
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: dev ? process.execPath : undefined,
    args: dev ? [app.getAppPath()] : [],
  });
}
