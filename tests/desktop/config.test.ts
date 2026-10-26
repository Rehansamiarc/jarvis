import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BRAIN_URL,
  VOICE_LIMITS,
  loadConfig,
  normalizeBrainUrl,
  normalizeConfig,
  normalizeVoice,
  saveConfig,
} from "../../desktop/config";

describe("normalizeBrainUrl", () => {
  it("keeps valid http(s) origins and strips paths and trailing slashes", () => {
    expect(normalizeBrainUrl("https://brain.example/app/")).toBe("https://brain.example");
    expect(normalizeBrainUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("falls back to the default for anything unusable", () => {
    for (const bad of [null, undefined, "", "not a url", "ftp://x.test", "javascript:alert(1)", 42]) {
      expect(normalizeBrainUrl(bad)).toBe(DEFAULT_BRAIN_URL);
    }
  });
});

describe("normalizeVoice", () => {
  it("clamps rate and pitch into the bounds the brain enforces", () => {
    const voice = normalizeVoice({ name: "Zira", rate: 99, pitch: -3, language: "en-GB" });
    expect(voice.rate).toBe(VOICE_LIMITS.rate.max);
    expect(voice.pitch).toBe(VOICE_LIMITS.pitch.min);
    expect(voice.language).toBe("en-GB");
    expect(voice.name).toBe("Zira");
  });

  it("rejects a missing, empty or over-long voice name", () => {
    expect(normalizeVoice({ name: "  " }).name).toBeNull();
    expect(normalizeVoice({ name: "x".repeat(VOICE_LIMITS.nameMax + 1) }).name).toBeNull();
    expect(normalizeVoice({}).name).toBeNull();
  });

  it("falls back to defaults when given nonsense", () => {
    const voice = normalizeVoice("nope");
    expect(voice).toEqual({
      name: null,
      rate: VOICE_LIMITS.rate.default,
      pitch: VOICE_LIMITS.pitch.default,
      language: VOICE_LIMITS.language.default,
    });
  });
});

describe("normalizeConfig", () => {
  it("produces a complete config from nothing at all", () => {
    expect(normalizeConfig(null)).toEqual({
      brainUrl: DEFAULT_BRAIN_URL,
      autostart: false,
      wakeWordEnabled: false,
      porcupineAccessKey: "",
      micMuted: true,
      voice: normalizeVoice(null),
    });
  });

  it("keeps valid values and repairs invalid ones", () => {
    const config = normalizeConfig({
      brainUrl: "https://brain.test",
      autostart: "yes", // wrong type → default
      wakeWordEnabled: true,
      porcupineAccessKey: "  key  ",
      micMuted: false,
      voice: { name: "Aria", rate: 1.4, pitch: 1.1, language: "fr-FR" },
    });
    expect(config.autostart).toBe(false);
    expect(config.wakeWordEnabled).toBe(true);
    expect(config.porcupineAccessKey).toBe("key");
    expect(config.micMuted).toBe(false);
    expect(config.voice).toEqual({ name: "Aria", rate: 1.4, pitch: 1.1, language: "fr-FR" });
  });

  it("never stores an over-long access key", () => {
    expect(normalizeConfig({ porcupineAccessKey: "k".repeat(500) }).porcupineAccessKey).toBe("");
  });
});

describe("config persistence", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "jarvis-config-"));
    file = path.join(dir, "nested", "config.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a config through a file that does not exist yet", async () => {
    const config = normalizeConfig({
      brainUrl: "https://brain.test",
      autostart: true,
      voice: { name: "Zira", rate: 1.25, pitch: 0.9, language: "en-GB" },
    });
    expect(await loadConfig(file)).toEqual(normalizeConfig(null));
    await saveConfig(file, config);
    expect(await loadConfig(file)).toEqual(config);
  });

  it("returns a valid default instead of throwing on a corrupt file", async () => {
    await saveConfig(file, normalizeConfig(null));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ not json", "utf8");
    const loaded = await loadConfig(file);
    expect(loaded.brainUrl).toBe(DEFAULT_BRAIN_URL);
  });
});
