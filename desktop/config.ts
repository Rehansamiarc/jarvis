import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppConfig, VoiceSettings } from "./ipc";

/**
 * Local configuration for the desktop app.
 *
 * Everything here is *normalised on read*: a hand-edited or partially written file must
 * never be able to put an invalid value into the app, and it must never throw away a
 * value that is still valid. The limits mirror the zod schema on
 * `PATCH /api/preferences`, so a value this file accepts is also a value the brain will
 * accept when we persist it.
 */

/** Origin of the brain this build ships pointing at; overridable in Settings. */
export const DEFAULT_BRAIN_URL = "https://site-df8c8a19e6764755a80a82add25ed227.freebuff.page";

export const VOICE_LIMITS = {
  rate: { min: 0.5, max: 2, default: 1 },
  pitch: { min: 0.5, max: 2, default: 1 },
  language: { min: 2, max: 32, default: "en-US" },
  nameMax: 120,
} as const;

/** Matches the engine's maximum key length so we never store a truncated key. */
const ACCESS_KEY_MAX = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Accepts only absolute http(s) origins — anything else falls back to the default. */
export function normalizeBrainUrl(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_BRAIN_URL;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_BRAIN_URL;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_BRAIN_URL;
    return url.origin;
  } catch {
    return DEFAULT_BRAIN_URL;
  }
}

export function normalizeVoice(input: unknown): VoiceSettings {
  const record = isRecord(input) ? input : {};
  const rawName = record.name;
  const name =
    typeof rawName === "string" && rawName.trim() && rawName.length <= VOICE_LIMITS.nameMax
      ? rawName.trim()
      : null;

  const rawLanguage = record.language;
  const language =
    typeof rawLanguage === "string" &&
    rawLanguage.trim().length >= VOICE_LIMITS.language.min &&
    rawLanguage.trim().length <= VOICE_LIMITS.language.max
      ? rawLanguage.trim()
      : VOICE_LIMITS.language.default;

  return {
    name,
    rate: clampNumber(record.rate, VOICE_LIMITS.rate.min, VOICE_LIMITS.rate.max, VOICE_LIMITS.rate.default),
    pitch: clampNumber(
      record.pitch,
      VOICE_LIMITS.pitch.min,
      VOICE_LIMITS.pitch.max,
      VOICE_LIMITS.pitch.default
    ),
    language,
  };
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Pure: turns anything at all into a complete, valid AppConfig. */
export function normalizeConfig(input: unknown): AppConfig {
  const record = isRecord(input) ? input : {};
  return {
    brainUrl: normalizeBrainUrl(record.brainUrl),
    autostart: booleanOr(record.autostart, false),
    wakeWordEnabled: booleanOr(record.wakeWordEnabled, false),
    porcupineAccessKey:
      typeof record.porcupineAccessKey === "string" &&
      record.porcupineAccessKey.trim().length <= ACCESS_KEY_MAX
        ? record.porcupineAccessKey.trim()
        : "",
    micMuted: booleanOr(record.micMuted, true),
    voice: normalizeVoice(record.voice),
  };
}

export async function loadConfig(file: string): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return normalizeConfig(JSON.parse(raw) as unknown);
  } catch {
    // Missing or corrupt file — a fresh, valid config beats a crash on startup.
    return normalizeConfig(null);
  }
}

export async function saveConfig(file: string, config: AppConfig): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  // Write-then-rename so a crash mid-write cannot leave a half-written config behind.
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}
