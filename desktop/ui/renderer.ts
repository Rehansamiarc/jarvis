import { floatToInt16 } from "../audio";
import type {
  AppConfig,
  DesktopApi,
  PrivacyState,
  SessionStatus,
  VoiceSettings,
  WakeWordStatus,
} from "../ipc";

/**
 * Desktop shell renderer.
 *
 * Runs with no Node access (contextIsolation). It owns three things the main process
 * cannot: enumerating the OS speech voices, capturing microphone audio into 16 kHz
 * frames for the on-device wake-word engine, and speaking replies back to you.
 */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

/**
 * TypeScript's DOM lib does not ship the Web Speech API, so declare the slice this
 * renderer uses. Keeping it local avoids polluting the web app's global types.
 */
interface SpeechResultLike {
  transcript: string;
}
interface SpeechResultListLike {
  [index: number]: { [index: number]: SpeechResultLike };
}
interface SpeechEventLike extends Event {
  results: SpeechResultListLike;
}
interface SpeechErrorEventLike extends Event {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechEventLike) => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/**
 * The bridge is optional in the type world (the page can be opened without a preload)
 * but mandatory at runtime, so resolve it once and hand back a non-optional handle.
 */
function resolveApi(): DesktopApi {
  const bridge = window.jarvis;
  if (!bridge) {
    const node = document.getElementById("sessionStatus");
    if (node) {
      node.textContent =
        "The desktop bridge did not load. Rebuild with `npm run desktop:build` and restart the app.";
      node.className = "status bad";
    }
    throw new Error("window.jarvis missing — preload not applied");
  }
  return bridge;
}

const api: DesktopApi = resolveApi();

const brainUrlInput = el<HTMLInputElement>("brainUrl");
const sessionStatus = el<HTMLDivElement>("sessionStatus");
const voiceSelect = el<HTMLSelectElement>("voiceSelect");
const rateRange = el<HTMLInputElement>("rateRange");
const pitchRange = el<HTMLInputElement>("pitchRange");
const rateValue = el<HTMLSpanElement>("rateValue");
const pitchValue = el<HTMLSpanElement>("pitchValue");
const voiceStatus = el<HTMLDivElement>("voiceStatus");
const wakeToggle = el<HTMLInputElement>("wakeToggle");
const accessKey = el<HTMLInputElement>("accessKey");
const wakeStatus = el<HTMLDivElement>("wakeStatus");
const privacyStatus = el<HTMLDivElement>("privacyStatus");
const micPill = el<HTMLSpanElement>("micPill");
const camPill = el<HTMLSpanElement>("camPill");
const micBadge = el<HTMLSpanElement>("micBadge");
const wakeBadge = el<HTMLSpanElement>("wakeBadge");
const connDot = el<HTMLSpanElement>("connDot");
const log = el<HTMLDivElement>("log");
const sttBadge = el<HTMLSpanElement>("sttBadge");
const commandInput = el<HTMLInputElement>("commandInput");

let config: AppConfig | null = null;
let privacy: PrivacyState | null = null;
let voices: SpeechSynthesisVoice[] = [];
let lastReply = "";

// ------------------------------------------------------------------ helpers

type Kind = "" | "ok" | "bad" | "warn";

function setStatus(node: HTMLElement, text: string, kind: Kind = ""): void {
  node.textContent = text;
  node.className = kind ? `status ${kind}` : "status";
}

function appendLog(who: "you" | "jarvis", text: string): void {
  const line = document.createElement("div");
  line.className = who;
  line.textContent = `${who === "you" ? "› " : "JARVIS: "}${text}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function currentVoice(): VoiceSettings {
  return {
    name: voiceSelect.value || null,
    rate: Number(rateRange.value),
    pitch: Number(pitchRange.value),
    language: config?.voice.language ?? "en-US",
  };
}

function applyConfigToUi(): void {
  if (!config) return;
  brainUrlInput.value = config.brainUrl;
  wakeToggle.checked = config.wakeWordEnabled;
  accessKey.value = config.porcupineAccessKey;
  rateRange.value = String(config.voice.rate);
  pitchRange.value = String(config.voice.pitch);
  rateValue.textContent = `${Number(config.voice.rate).toFixed(2)}×`;
  pitchValue.textContent = Number(config.voice.pitch).toFixed(2);
  if (config.voice.name) voiceSelect.value = config.voice.name;
  renderPrivacy();
}

function renderPrivacy(): void {
  if (!privacy) return;
  const live = privacy.capturing && !privacy.micMuted;
  micPill.textContent = privacy.micMuted ? "microphone muted" : live ? "microphone live" : "microphone idle";
  micPill.className = `pill${live ? " on" : ""}`;
  micBadge.textContent = privacy.micMuted ? "mic muted" : live ? "mic live" : "mic idle";
  micBadge.className = `badge${live ? " live" : ""}`;
  camPill.textContent = "camera unused by JARVIS";

  const muteButton = document.getElementById("muteBtn");
  const muteButton2 = document.getElementById("muteBtn2");
  const label = privacy.micMuted ? "Unmute" : "Mute";
  if (muteButton) muteButton.textContent = label;
  if (muteButton2) muteButton2.textContent = privacy.micMuted ? "Unmute microphone" : "Mute microphone";

  setStatus(
    privacyStatus,
    privacy.micMuted
      ? "Muted. The microphone is released and no frames reach the wake-word engine."
      : live
        ? "Live: 16 kHz frames are matched against your wake phrase on this PC and then discarded."
        : "Microphone idle — nothing is captured until the wake word is enabled.",
    privacy.micMuted ? "warn" : live ? "ok" : ""
  );
}

function renderWake(): void {
  if (!config) return;
  wakeBadge.textContent = config.wakeWordEnabled ? "wake word on" : "wake word off";
  wakeBadge.className = `badge${config.wakeWordEnabled ? " live" : ""}`;
}

function renderSession(status: SessionStatus): void {
  connDot.className = `dot ${status.signedIn ? "on" : ""}`;
  setStatus(
    sessionStatus,
    status.signedIn
      ? `Connected as ${status.email ?? "your account"} · ${status.brainUrl}`
      : `${status.detail} (${status.brainUrl})`,
    status.signedIn ? "ok" : status.reachable ? "warn" : "bad"
  );
}

// ------------------------------------------------------------------ voices

function loadVoices(preferredName?: string | null): void {
  voices = window.speechSynthesis.getVoices();
  voiceSelect.innerHTML = "";

  if (voices.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No system voices found";
    voiceSelect.appendChild(option);
    setStatus(voiceStatus, "The Windows speech engine reported no voices.", "bad");
    return;
  }

  const preferred = preferredName ?? config?.voice.name ?? null;
  for (const voice of voices) {
    const option = document.createElement("option");
    option.value = voice.name;
    option.textContent = `${voice.name} — ${voice.lang}${voice.localService ? "" : " (online)"}`;
    if (voice.name === preferred) option.selected = true;
    voiceSelect.appendChild(option);
  }

  if (!voiceSelect.value) voiceSelect.value = voices[0]?.name ?? "";
  console.log(`[jarvis-desktop] ${voices.length} speech voices loaded`);
  setStatus(
    voiceStatus,
    `${voices.length} voices available from ${voices.some((v) => v.localService) ? "the Windows speech engine" : "the browser"} · ${new Set(voices.map((v) => v.lang)).size} languages`,
    "ok"
  );
}

function speak(text: string): void {
  if (!text) return;
  window.speechSynthesis.cancel();
  const settings = currentVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  const match = voices.find((voice) => voice.name === settings.name);
  if (match) utterance.voice = match;
  utterance.rate = settings.rate;
  utterance.pitch = settings.pitch;
  utterance.lang = settings.language;
  window.speechSynthesis.speak(utterance);
}

// ------------------------------------------------------------------ capture

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let captureNode: AudioWorkletNode | null = null;
let capturing = false;
let batch: Float32Array[] = [];
let batchLength = 0;

/**
 * The worklet forwards raw input frames; running it through a muted gain node keeps the
 * graph alive without ever monitoring (and therefore never replaying) your own voice.
 */
const WORKLET_SOURCE = `
class Forwarder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel);
    return true;
  }
}
registerProcessor("jarvis-forwarder", Forwarder);
`;

async function startCapture(): Promise<void> {
  if (capturing) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    audioContext = new AudioContext({ sampleRate: 16_000 });
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    await audioContext.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    captureNode = new AudioWorkletNode(audioContext, "jarvis-forwarder");
    const sink = audioContext.createGain();
    sink.gain.value = 0;
    captureNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      batch.push(event.data);
      batchLength += event.data.length;
      if (batchLength < 2048) return;
      const merged = new Float32Array(batchLength);
      let offset = 0;
      for (const chunk of batch) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      api.pushAudioFrames(floatToInt16(merged));
      batch = [];
      batchLength = 0;
    };
    captureNode.connect(sink);
    sink.connect(audioContext.destination);

    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(captureNode);
    capturing = true;
    await api.setCapturing(true);
    renderPrivacy();
  } catch (error) {
    capturing = false;
    await api.setCapturing(false);
    setStatus(wakeStatus, `Microphone unavailable: ${(error as Error).message}`, "bad");
    renderPrivacy();
  }
}

async function stopCapture(): Promise<void> {
  captureNode?.port.close();
  captureNode?.disconnect();
  captureNode = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  await audioContext?.close();
  audioContext = null;
  batch = [];
  batchLength = 0;
  capturing = false;
  await api.setCapturing(false);
  renderPrivacy();
}

async function syncCapture(): Promise<void> {
  const should = Boolean(config?.wakeWordEnabled) && Boolean(privacy && !privacy.micMuted);
  if (should && !capturing) await startCapture();
  else if (!should && capturing) await stopCapture();
}

// --------------------------------------------------------------- wake word

async function refreshWake(): Promise<void> {
  const status: WakeWordStatus = await api.wakeWordStatus();
  const kind: Kind = status.running ? "ok" : status.keyConfigured ? "warn" : "";
  setStatus(wakeStatus, status.detail, kind);
  renderWake();
  await syncCapture();
}

function startRecognition(): void {
  const globals = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  const Ctor = globals.SpeechRecognition ?? globals.webkitSpeechRecognition;

  if (!Ctor) {
    sttBadge.textContent = "voice input unavailable";
    sttBadge.className = "badge";
    setStatus(
      voiceStatus,
      "Wake word heard, but this build has no speech recognition — type your command below.",
      "warn"
    );
    return;
  }

  const recognition = new Ctor();
  recognition.lang = config?.voice.language ?? "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    sttBadge.textContent = "listening…";
    sttBadge.className = "badge live";
  };
  recognition.onresult = (event: SpeechEventLike) => {
    const transcript = event.results?.[0]?.[0]?.transcript ?? "";
    if (transcript) void runCommand(transcript);
  };
  recognition.onerror = (event: SpeechErrorEventLike) => {
    sttBadge.textContent = "voice input failed";
    sttBadge.className = "badge";
    appendLog("jarvis", `I could not hear that (${event.error}). Type the command instead.`);
  };
  recognition.onend = () => {
    sttBadge.textContent = "voice input idle";
    sttBadge.className = "badge";
  };
  try {
    recognition.start();
  } catch {
    sttBadge.textContent = "voice input busy";
    sttBadge.className = "badge";
  }
}

// ----------------------------------------------------------------- commands

async function runCommand(message: string): Promise<void> {
  const text = message.trim();
  if (!text) return;
  appendLog("you", text);
  commandInput.value = "";
  try {
    const result = await api.runAgent(text);
    lastReply = result.reply || result.detail;
    appendLog("jarvis", lastReply);
    speak(lastReply);
  } catch (error) {
    appendLog("jarvis", `That failed: ${(error as Error).message}`);
  }
}

async function refreshSession(): Promise<void> {
  renderSession(await api.sessionStatus());
}

// -------------------------------------------------------------------- wire up

async function boot(): Promise<void> {
  config = await api.getConfig();
  applyConfigToUi();
  renderWake();

  window.speechSynthesis.addEventListener("voiceschanged", () => loadVoices());
  loadVoices(config.voice.name);

  privacy = await api.privacyState();
  renderPrivacy();

  await refreshWake();
  void refreshSession();

  api.onWakeWordDetected(() => {
    appendLog("jarvis", "Wake word detected — go ahead.");
    startRecognition();
  });
  api.onPrivacyChanged((state) => {
    privacy = state;
    renderPrivacy();
    void syncCapture();
  });

  window.setInterval(() => void refreshSession(), 10_000);
  console.log("[jarvis-desktop] renderer ready");
}

el<HTMLButtonElement>("muteBtn").addEventListener("click", () => void toggleMute());
el<HTMLButtonElement>("muteBtn2").addEventListener("click", () => void toggleMute());

async function toggleMute(): Promise<void> {
  privacy = await api.setMicMuted(!(privacy?.micMuted ?? true));
  config = await api.getConfig();
  renderPrivacy();
  await syncCapture();
}

el<HTMLButtonElement>("saveBrainBtn").addEventListener("click", () => void saveBrain());

async function saveBrain(): Promise<void> {
  config = await api.setConfig({ brainUrl: brainUrlInput.value });
  applyConfigToUi();
  await refreshSession();
  await refreshWake();
}

el<HTMLButtonElement>("signInBtn").addEventListener("click", () => void signIn());

async function signIn(): Promise<void> {
  setStatus(sessionStatus, "Sign-in window opened — complete it there, then wait a moment…", "warn");
  await api.signIn();
  window.setTimeout(() => void refreshSession(), 2500);
}

el<HTMLButtonElement>("signOutBtn").addEventListener("click", () => void signOut());

async function signOut(): Promise<void> {
  renderSession(await api.signOut());
}

el<HTMLButtonElement>("previewBtn").addEventListener("click", () => {
  speak("Good evening. JARVIS online, at your service.");
});
el<HTMLButtonElement>("stopBtn").addEventListener("click", () => window.speechSynthesis.cancel());
el<HTMLButtonElement>("speakBtn").addEventListener("click", () => speak(lastReply));

rateRange.addEventListener("input", () => {
  rateValue.textContent = `${Number(rateRange.value).toFixed(2)}×`;
});
pitchRange.addEventListener("input", () => {
  pitchValue.textContent = Number(pitchRange.value).toFixed(2);
});

el<HTMLButtonElement>("saveVoiceBtn").addEventListener("click", () => void saveVoice());

async function saveVoice(): Promise<void> {
  const voice = currentVoice();
  const result = await api.saveVoice(voice);
  config = await api.getConfig();
  setStatus(voiceStatus, result.detail, result.persistedToBrain ? "ok" : "warn");
  speak(`Voice saved. ${voice.name ?? "System default"} at ${voice.rate.toFixed(2)} times speed.`);
}

wakeToggle.addEventListener("change", () => void setWakeWord(wakeToggle.checked));

async function setWakeWord(enabled: boolean): Promise<void> {
  await api.setWakeWordEnabled(enabled);
  config = await api.getConfig();
  privacy = await api.privacyState();
  renderWake();
  await refreshWake();
}

el<HTMLButtonElement>("saveKeyBtn").addEventListener("click", () => void saveKey());

async function saveKey(): Promise<void> {
  config = await api.setConfig({ porcupineAccessKey: accessKey.value });
  applyConfigToUi();
  await refreshWake();
}

el<HTMLButtonElement>("testMicBtn").addEventListener("click", () => void testMic());

async function testMic(): Promise<void> {
  setStatus(wakeStatus, "Requesting microphone access…", "warn");
  if (!capturing) await startCapture();
  if (capturing) {
    setStatus(wakeStatus, "Microphone is live. Say your wake phrase — frames are matched locally.", "ok");
    renderPrivacy();
  }
}

el<HTMLButtonElement>("openBrainBtn").addEventListener("click", () => {
  if (config) void api.openExternal(config.brainUrl);
});

el<HTMLButtonElement>("sendBtn").addEventListener("click", () => void runCommand(commandInput.value));
commandInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void runCommand(commandInput.value);
});

void boot();
