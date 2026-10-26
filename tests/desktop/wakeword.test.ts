import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { floatToInt16 } from "../../desktop/audio";
import { WAKE_FRAME_LENGTH, inspectWakeWord, resolveKeywordPath } from "../../desktop/wakeword";

describe("floatToInt16", () => {
  it("maps the full scale onto 16-bit PCM", () => {
    const pcm = floatToInt16(new Float32Array([0, 1, -1, 0.5, -0.5]));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 16383, -16384]);
  });

  it("clips rather than wrapping on out-of-range input", () => {
    const pcm = floatToInt16(new Float32Array([5, -5, Number.NaN]));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
    expect(pcm[2]).toBe(0);
  });
});

describe("wake word model resolution", () => {
  it("finds the built-in Jarvis keyword model for this platform", () => {
    const model = resolveKeywordPath("jarvis");
    expect(existsSync(model)).toBe(true);
    expect(model).toMatch(/jarvis.*\.ppn$/i);
  });

  it("is case-insensitive for built-in keywords", () => {
    expect(resolveKeywordPath("JARVIS")).toBe(resolveKeywordPath("jarvis"));
  });

  it("explains which phrases are available when the model is missing", () => {
    expect(() => resolveKeywordPath("banana")).toThrowError(/No wake-word model/i);
  });

  it("reports readiness without constructing the engine", () => {
    const withoutKey = inspectWakeWord("");
    expect(withoutKey.keyConfigured).toBe(false);
    expect(withoutKey.keywordPath).not.toBeNull();
    expect(withoutKey.detail).toMatch(/access key/i);

    const withKey = inspectWakeWord("pv_test_key");
    expect(withKey.keyConfigured).toBe(true);
    expect(withKey.detail).toMatch(/ready/i);
  });

  it("uses fixed 16 kHz windows of 512 samples", () => {
    expect(WAKE_FRAME_LENGTH).toBe(512);
  });
});
