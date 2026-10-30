/**
 * Contract shared by the Electron main process, the preload bridge and the renderer.
 *
 * This file deliberately imports nothing from Node or the DOM so that both sides can
 * depend on it without pulling each other's type environments into scope.
 */

/** Mirrors the voice columns in `user_preferences` so the web app and this app agree. */
export interface VoiceSettings {
  /** Name as reported by the OS speech engine, or null for the system default. */
  name: string | null;
  /** 0.5–2, same bounds as `user_preferences.speech_rate`. */
  rate: number;
  /** 0.5–2, same bounds as `user_preferences.speech_pitch`. */
  pitch: number;
  /** BCP-47 tag, same bounds as `user_preferences.language`. */
  language: string;
}

export interface AppConfig {
  /** Origin of the JARVIS brain this app talks to (no trailing slash). */
  brainUrl: string;
  /** Start with Windows. */
  autostart: boolean;
  /** Hands-free wake-word listening while the app runs in the background. */
  wakeWordEnabled: boolean;
  /**
   * Picovoice access key for the on-device wake-word engine. It stays in this app's
   * config directory on this machine and is never sent to the JARVIS brain — the
   * engine it unlocks runs entirely locally.
   */
  porcupineAccessKey: string;
  /** Local mute switch. When true no microphone audio leaves the microphone driver. */
  micMuted: boolean;
  voice: VoiceSettings;
}

export interface SessionStatus {
  signedIn: boolean;
  email: string | null;
  brainUrl: string;
  /** The brain answered HTTP at all (as opposed to being unreachable). */
  reachable: boolean;
  /** Human-readable explanation of the current state. */
  detail: string;
}

export interface WakeWordStatus {
  /** The native wake-word engine could be constructed on this machine. */
  supported: boolean;
  running: boolean;
  keyConfigured: boolean;
  /** The renderer is currently capturing microphone audio. */
  listening: boolean;
  detail: string;
}

export interface PrivacyState {
  micMuted: boolean;
  capturing: boolean;
  wakeWordRunning: boolean;
  /** Epoch ms of the most recent wake-word hit, for the activity indicator. */
  lastDetectionAt: number | null;
}

export interface SaveVoiceResult {
  /** True when the brain accepted the change; false when it was kept locally only. */
  persistedToBrain: boolean;
  detail: string;
}

export interface AgentRunResult {
  reply: string;
  detail: string;
}

/** Result of a local device action performed by the desktop app itself. */
export interface DeviceOutcome {
  ok: boolean;
  /** What the assistant says back — worded to match what actually happened. */
  reply: string;
  detail: string;
  data?: unknown;
}

/** Emitted when a spoken command was handled on this machine instead of by the brain. */
export interface DeviceActionEvent {
  description: string;
  ok: boolean;
  at: number;
}

export interface FileMatch {
  path: string;
  name: string;
}

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export interface SmokeReport {
  ok: boolean;
  checks: Record<string, CheckResult>;
}

/** What `window.jarvis` looks like inside the renderer. */
export interface DesktopApi {
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;

  sessionStatus(): Promise<SessionStatus>;
  signIn(): Promise<SessionStatus | void>;
  /** Clears the app's session cookies and returns the resulting (signed-out) status. */
  signOut(): Promise<SessionStatus>;

  saveVoice(voice: VoiceSettings): Promise<SaveVoiceResult>;
  loadBrainPreferences(): Promise<Record<string, unknown> | null>;

  wakeWordStatus(): Promise<WakeWordStatus>;
  setWakeWordEnabled(enabled: boolean): Promise<WakeWordStatus>;

  privacyState(): Promise<PrivacyState>;
  setMicMuted(muted: boolean): Promise<PrivacyState>;
  /** Tells the main process whether the renderer is currently capturing microphone audio. */
  setCapturing(capturing: boolean): Promise<PrivacyState>;

  runAgent(message: string): Promise<AgentRunResult>;

  /** Device actions. Every target is checked against the allowlist in the main process. */
  openApp(name: string): Promise<DeviceOutcome>;
  searchFiles(query: string, limit?: number): Promise<DeviceOutcome>;
  notify(title: string, body: string): Promise<DeviceOutcome>;
  copyText(text: string): Promise<DeviceOutcome>;
  onDeviceAction(handler: (event: DeviceActionEvent) => void): () => void;

  /** Push captured 16 kHz mono Int16 frames to the wake-word engine. */
  pushAudioFrames(frames: Int16Array): void;
  openExternal(url: string): Promise<void>;

  onWakeWordDetected(handler: () => void): () => void;
  onPrivacyChanged(handler: (state: PrivacyState) => void): () => void;
}

declare global {
  interface Window {
    jarvis?: DesktopApi;
  }
}
