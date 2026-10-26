import { Menu, nativeImage, type BrowserWindow } from "electron";

/**
 * Tray icon and menu.
 *
 * The icon is generated as raw RGBA rather than shipped as an asset file: one less
 * binary in the repo, and it always matches the amber accent used everywhere else.
 */

export function createTrayIcon(size = 16) {
  const buffer = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size / 2 - 0.5;
  const [r, g, b] = [255, 154, 60]; // --arc amber

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centre, y - centre);
      const offset = (y * size + x) * 4;
      if (distance > radius) {
        buffer[offset + 3] = 0;
        continue;
      }
      // Soft edge so a 16px glyph does not look saw-toothed on hidpi.
      const alpha = distance > radius - 1 ? Math.round(255 * (radius - distance)) : 255;
      buffer[offset] = r;
      buffer[offset + 1] = g;
      buffer[offset + 2] = b;
      buffer[offset + 3] = Math.max(0, Math.min(255, alpha));
    }
  }

  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size });
  image.setTemplateImage(false);
  return image;
}

export interface TrayState {
  muted: boolean;
  wakeWordRunning: boolean;
  autostart: boolean;
  signedIn: boolean;
}

export interface TrayHandlers {
  onShow(): void;
  onToggleMute(): void;
  onToggleWakeWord(): void;
  onToggleAutostart(): void;
  onQuit(): void;
}

export function buildTrayMenu(state: TrayState, handlers: TrayHandlers): Menu {
  return Menu.buildFromTemplate([
    { label: "Open JARVIS", click: handlers.onShow },
    { type: "separator" },
    {
      label: state.muted ? "Unmute microphone" : "Mute microphone",
      enabled: true,
      click: handlers.onToggleMute,
      toolTip: "Muting stops the microphone in this app; the OS-level indicator clears immediately.",
    },
    {
      label: state.wakeWordRunning ? "Stop wake word" : "Start wake word",
      click: handlers.onToggleWakeWord,
    },
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: state.autostart,
      click: handlers.onToggleAutostart,
    },
    { type: "separator" },
    {
      label: state.signedIn ? "Signed in — click to show" : "Not signed in — open to sign in",
      enabled: false,
    },
    { label: "Quit JARVIS", click: handlers.onQuit },
  ]);
}

/** Keeps the window on screen and focused instead of spawning a second instance. */
export function showWindow(window: BrowserWindow | null): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
