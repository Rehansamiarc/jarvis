import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain, session, shell, Tray } from "electron";

import { createBrainClient } from "./brain";
import { isAutostartEnabled, setAutostartEnabled } from "./autostart";
import { loadConfig, normalizeConfig, saveConfig } from "./config";
import type {
  AppConfig,
  CheckResult,
  PrivacyState,
  SessionStatus,
  SmokeReport,
  VoiceSettings,
  WakeWordStatus,
} from "./ipc";
import { copyToClipboard, notify, openApp, runLocalCommand, searchFiles } from "./actions";
import { describeCommand, parseLocalCommand, resolveApp, type LocalCommand } from "./commandRouter";
import { buildTrayMenu, createTrayIcon, showWindow } from "./tray";
import { createWakeWordEngine, inspectWakeWord, type WakeWordEngine } from "./wakeword";

/**
 * JARVIS desktop — main process.
 *
 * Responsibilities: window + tray lifecycle, the sign-in window whose cookie jar is the
 * app's credential, microphone frames flowing to the on-device wake-word engine, and
 * every IPC channel the renderer is allowed to call. The renderer itself never touches
 * Node, the filesystem or the session cookies (contextIsolation stays on).
 */

const AUTH_PARTITION = "persist:jarvis-auth";
const SMOKE = process.argv.includes("--smoke-test");

let config: AppConfig = normalizeConfig(null);
let engine: WakeWordEngine | null = null;
let engineError: string | null = null;
let pendingFrames: Int16Array = new Int16Array(0);

let mainWindow: BrowserWindow | null = null;
let authWindow: BrowserWindow | null = null;

let capturing = false;
let lastDetectionAt: number | null = null;
let lastSession: SessionStatus | null = null;

// ---------------------------------------------------------------------- helpers

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

async function persist(): Promise<void> {
  await saveConfig(configPath(), config);
}

/** The Supabase session cookie, replayed as a plain header for the brain's REST routes. */
async function cookieHeaderFor(url: string): Promise<string> {
  try {
    const cookies = await session.fromPartition(AUTH_PARTITION).cookies.get({ url });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch {
    return "";
  }
}

async function brainClient() {
  return createBrainClient({ baseUrl: config.brainUrl, cookieHeader: await cookieHeaderFor(config.brainUrl) });
}

function privacyState(): PrivacyState {
  return {
    micMuted: config.micMuted,
    capturing,
    wakeWordRunning: engine !== null,
    lastDetectionAt,
  };
}

function emitPrivacy(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("privacy:changed", privacyState());
  }
}

/**
 * Tells the window that a local device action ran, so the transcript shows what the app
 * did on this machine rather than only what the brain said.
 */
function emitLocalAction(command: LocalCommand, outcome: { ok: boolean }): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("device:action", {
      description: describeCommand(command),
      ok: outcome.ok,
      at: Date.now(),
    });
  }
}

function wakeWordStatus(): WakeWordStatus {
  const info = inspectWakeWord(config.porcupineAccessKey);
  return {
    supported: info.keywordPath !== null,
    running: engine !== null,
    keyConfigured: info.keyConfigured,
    listening: engine !== null && capturing && !config.micMuted,
    detail: engineError ?? info.detail,
  };
}

async function startEngine(): Promise<WakeWordStatus> {
  if (engine) return wakeWordStatus();
  try {
    engine = createWakeWordEngine({ accessKey: config.porcupineAccessKey });
    engineError = null;
    pendingFrames = new Int16Array(0);
  } catch (error) {
    engine = null;
    engineError = (error as Error).message;
  }
  return wakeWordStatus();
}

function stopEngine(): void {
  engine?.release();
  engine = null;
  pendingFrames = new Int16Array(0);
}

/** Streams 16 kHz mono PCM-16 frames from the renderer into fixed-size engine windows. */
function handleFrames(frames: Int16Array): void {
  if (!engine || config.micMuted || frames.length === 0) return;

  const merged = new Int16Array(pendingFrames.length + frames.length);
  merged.set(pendingFrames);
  merged.set(frames, pendingFrames.length);

  let offset = 0;
  const size = engine.frameLength;
  while (merged.length - offset >= size) {
    const window = merged.subarray(offset, offset + size);
    if (engine.process(window)) {
      lastDetectionAt = Date.now();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("wakeword:detected");
      }
      emitPrivacy();
    }
    offset += size;
  }
  pendingFrames = merged.slice(offset);
}

function openAuthWindow(): BrowserWindow {
  if (authWindow && !authWindow.isDestroyed()) {
    showWindow(authWindow);
    return authWindow;
  }

  authWindow = new BrowserWindow({
    width: 520,
    height: 720,
    backgroundColor: "#050505",
    title: "Sign in to JARVIS",
    autoHideMenuBar: true,
    webPreferences: {
      // The sign-in window is the only place a Supabase session is created, and its
      // cookies live in their own partition so they are never shared with page content.
      partition: AUTH_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  authWindow.loadURL(`${config.brainUrl.replace(/\/+$/, "")}/login`);
  authWindow.on("closed", () => {
    authWindow = null;
  });
  return authWindow;
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 680,
    minHeight: 520,
    backgroundColor: "#050505",
    title: "JARVIS",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
}

// ---------------------------------------------------------------------- ipc

function registerIpc(): void {
  ipcMain.handle("config:get", () => config);

  ipcMain.handle("config:set", async (_event, patch: Partial<AppConfig>) => {
    const previous = config;
    config = normalizeConfig({ ...config, ...patch });
    await persist();

    if (patch.autostart !== undefined && patch.autostart !== previous.autostart) {
      setAutostartEnabled(config.autostart);
    }
    if (patch.porcupineAccessKey !== undefined || patch.wakeWordEnabled !== undefined) {
      if (config.wakeWordEnabled) await startEngine();
      else stopEngine();
    }
    emitPrivacy();
    return config;
  });

  ipcMain.handle("session:status", async () => {
    const status = await (await brainClient()).session();
    lastSession = status;
    updateTrayMenu();
    return status;
  });

  ipcMain.handle("session:signin", async () => {
    openAuthWindow();
    return lastSession;
  });

  ipcMain.handle("session:signout", async () => {
    const cookies = await session.fromPartition(AUTH_PARTITION).cookies.get({ url: config.brainUrl });
    await Promise.all(
      cookies.map((cookie) =>
        session.fromPartition(AUTH_PARTITION).cookies.remove(
          `${cookie.secure ? "https" : "http"}://${cookie.domain?.replace(/^\./, "")}${cookie.path}`,
          cookie.name
        )
      )
    );
    lastSession = null;
    return (await brainClient()).session();
  });

  ipcMain.handle("voice:save", async (_event, voice: VoiceSettings) => {
    const client = await brainClient();
    const result = await client.saveVoice(voice);
    if (result.persistedToBrain) {
      config = normalizeConfig({ ...config, voice });
      await persist();
    }
    return result;
  });

  ipcMain.handle("prefs:load", async () => {
    try {
      return await (await brainClient()).preferences();
    } catch {
      return null;
    }
  });

  ipcMain.handle("wakeword:status", () => wakeWordStatus());

  ipcMain.handle("wakeword:setEnabled", async (_event, enabled: boolean) => {
    config = normalizeConfig({ ...config, wakeWordEnabled: Boolean(enabled) });
    await persist();
    if (config.wakeWordEnabled) await startEngine();
    else stopEngine();
    return wakeWordStatus();
  });

  ipcMain.handle("privacy:get", () => privacyState());

  ipcMain.handle("privacy:setMuted", async (_event, muted: boolean) => {
    config = normalizeConfig({ ...config, micMuted: Boolean(muted) });
    await persist();
    emitPrivacy();
    return privacyState();
  });

  ipcMain.handle("privacy:setCapturing", (_event, value: boolean) => {
    capturing = Boolean(value) && !config.micMuted;
    emitPrivacy();
    return privacyState();
  });

  ipcMain.handle("agent:run", async (_event, message: string) => {
    const text = String(message ?? "").slice(0, 12_000);

    // Fast path: a literal device instruction ("open Chrome", "find my file tax.pdf")
    // is performed here, with no model call and no network dependency. Anything that is
    // not an exact match returns null and goes to the brain exactly as before.
    const local = parseLocalCommand(text);
    if (local.kind !== "none") {
      const outcome = await runLocalCommand(local);
      if (outcome) {
        emitLocalAction(local, outcome);
        return { reply: outcome.reply, detail: outcome.detail };
      }
    }

    const client = await brainClient();
    return client.runAgent(text);
  });

  // Explicit device channels for the UI (buttons, and confirmations the user clicked).
  ipcMain.handle("device:openApp", async (_event, name: string) => {
    const app = resolveApp(String(name ?? ""));
    if (!app) {
      return { ok: false, reply: `“${name}” is not on the approved app list.`, detail: "not_allowlisted" };
    }
    return openApp(app);
  });

  ipcMain.handle("device:searchFiles", async (_event, query: string, limit?: number) => {
    const matches = await searchFiles(
      String(query ?? "").slice(0, 200),
      Math.min(Math.max(Number(limit) || 12, 1), 50)
    );
    return { ok: true, reply: `${matches.length} match(es).`, detail: "search complete", data: matches };
  });

  ipcMain.handle("device:notify", (_event, title: string, body: string) =>
    notify(String(title ?? "JARVIS").slice(0, 120), String(body ?? "").slice(0, 500))
  );

  ipcMain.handle("device:copy", (_event, text: string) => copyToClipboard(String(text ?? "").slice(0, 20_000)));

  ipcMain.handle("external:open", (_event, url: string) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  ipcMain.on("wakeword:frame", (_event, frames: Int16Array) => {
    if (frames instanceof Int16Array) handleFrames(frames);
  });
}

// ---------------------------------------------------------------------- smoke test

async function runSmoke(): Promise<SmokeReport> {
  const checks: Record<string, CheckResult> = {};

  const record = async (name: string, run: () => Promise<CheckResult> | CheckResult): Promise<void> => {
    try {
      checks[name] = await run();
    } catch (error) {
      checks[name] = { ok: false, detail: (error as Error).message };
    }
  };

  checks.electron = {
    ok: true,
    detail: `electron ${process.versions.electron ?? "unknown"} · node ${process.versions.node}`,
  };

  await record("config_roundtrip", async () => {
    const file = path.join(app.getPath("temp"), `jarvis-smoke-${process.pid}.json`);
    const original = normalizeConfig({
      brainUrl: "https://brain.example.test/",
      autostart: true,
      wakeWordEnabled: true,
      porcupineAccessKey: "test-key",
      micMuted: false,
      voice: { name: "Microsoft Zira Desktop", rate: 1.25, pitch: 0.9, language: "en-GB" },
    });
    await saveConfig(file, original);
    const reloaded = await loadConfig(file);
    await fs.rm(file, { force: true });
    const same = JSON.stringify(reloaded) === JSON.stringify(original);
    return { ok: same, detail: same ? "written and re-read identically" : "round trip changed the config" };
  });

  await record("wake_word_model", () => {
    const info = inspectWakeWord(config.porcupineAccessKey);
    return {
      ok: info.keywordPath !== null,
      detail: info.keywordPath ?? info.detail,
    };
  });

  await record("wake_word_engine", async () => {
    const info = inspectWakeWord(config.porcupineAccessKey);
    if (!info.keyConfigured) {
      return { ok: true, detail: "skipped — no Picovoice access key configured (engine loads on demand)" };
    }
    const testEngine = createWakeWordEngine({ accessKey: config.porcupineAccessKey });
    const silence = new Int16Array(testEngine.frameLength);
    testEngine.process(silence);
    testEngine.release();
    return { ok: true, detail: `engine constructed and processed ${silence.length} samples` };
  });

  await record("brain_reachable", async () => {
    const status = await createBrainClient({ baseUrl: config.brainUrl }).session();
    return { ok: status.reachable, detail: status.detail };
  });

  await record("autostart", () => {
    const enabled = isAutostartEnabled();
    return { ok: typeof enabled === "boolean", detail: `openAtLogin=${enabled}` };
  });

  await record("tray_icon", () => {
    const icon = createTrayIcon();
    const size = icon.getSize();
    return { ok: !icon.isEmpty(), detail: `${size.width}x${size.height} RGBA bitmap` };
  });

  await record("renderer_bridge", async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
    });
    await window.loadFile(path.join(__dirname, "ui", "index.html"));
    const probe = (await window.webContents.executeJavaScript(`({
      bridge: typeof window.jarvis === "object" && typeof window.jarvis.getConfig === "function" && typeof window.jarvis.pushAudioFrames === "function",
      recognition: String(typeof (window.SpeechRecognition ?? window.webkitSpeechRecognition)),
      synthesis: String(typeof window.speechSynthesis),
      audioContext: String(typeof window.AudioContext),
      audioWorklet: String(typeof (window.AudioWorkletNode ?? ""))
    })`)) as {
      bridge: boolean;
      recognition: string;
      synthesis: string;
      audioContext: string;
      audioWorklet: string;
    };
    window.destroy();

    // Speech synthesis + the audio graph are required for the Voice Studio and the
    // wake-word capture path. Recognition is reported, not required: Chromium only
    // ships it where a platform speech service is configured, and the renderer already
    // falls back to typed commands when it is absent.
    checks.speech_api = {
      // `speechSynthesis` is an object in Chromium; the constructors are functions.
      ok:
        (probe.synthesis === "function" || probe.synthesis === "object") &&
        probe.audioContext === "function" &&
        probe.audioWorklet === "function",
      detail: `recognition=${probe.recognition}, synthesis=${probe.synthesis}, audioContext=${probe.audioContext}, audioWorklet=${probe.audioWorklet}`,
    };

    return {
      ok: probe.bridge === true,
      detail: probe.bridge
        ? "window.jarvis exposes the typed API with isolation on"
        : "preload did not expose window.jarvis",
    };
  });

  await record("renderer_bundle", () => {
    const html = path.join(__dirname, "ui", "index.html");
    const script = path.join(__dirname, "ui", "renderer.js");
    const ok = existsSync(html) && existsSync(script);
    return { ok, detail: ok ? "index.html + renderer.js present" : "renderer bundle missing — run npm run desktop:build" };
  });

  const ok = Object.values(checks).every((check) => check.ok);
  return { ok, checks };
}

// ---------------------------------------------------------------------- lifecycle

async function boot(): Promise<void> {
  config = await loadConfig(configPath());
  registerIpc();

  if (SMOKE) {
    const report = await runSmoke();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    app.exit(report.ok ? 0 : 1);
    return;
  }

  createTray();
  createMainWindow();
  if (config.wakeWordEnabled) await startEngine();
  console.log("[jarvis-desktop] ready");
}

let tray: Tray | null = null;

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("JARVIS — personal AI assistant");
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const menu = buildTrayMenu(
    {
      muted: config.micMuted,
      wakeWordRunning: engine !== null,
      autostart: isAutostartEnabled(),
      signedIn: lastSession?.signedIn ?? false,
    },
    {
      onShow: () => showWindow(mainWindow),
      onToggleMute: () => {
        config = normalizeConfig({ ...config, micMuted: !config.micMuted });
        void persist().then(() => {
          emitPrivacy();
          updateTrayMenu();
        });
      },
      onToggleWakeWord: () => {
        config = normalizeConfig({ ...config, wakeWordEnabled: !config.wakeWordEnabled });
        void (async () => {
          await persist();
          if (config.wakeWordEnabled) await startEngine();
          else stopEngine();
          updateTrayMenu();
        })();
      },
      onToggleAutostart: () => {
        const next = !isAutostartEnabled();
        setAutostartEnabled(next);
        config = normalizeConfig({ ...config, autostart: next });
        void persist().then(updateTrayMenu);
      },
      onQuit: () => app.quit(),
    }
  );
  tray.setContextMenu(menu);
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow(mainWindow));
  // Closing the window hides to tray: the assistant keeps running without a browser.
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", () => stopEngine());
  void app.whenReady().then(boot).catch((error: Error) => {
    console.error("[jarvis-desktop] failed to start:", error);
    if (SMOKE) app.exit(1);
    else app.quit();
  });
}
