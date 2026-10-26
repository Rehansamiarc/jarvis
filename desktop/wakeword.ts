import { existsSync } from "node:fs";
import { BuiltinKeyword, Porcupine, getBuiltinKeywordPath } from "@picovoice/porcupine-node";

/**
 * On-device wake-word detection.
 *
 * Picovoice Porcupine runs entirely in this process: no audio, no recording and no
 * network request ever leaves the machine for detection. The only credential involved
 * is the local access key that unlocks the engine, and it is sent to Picovoice's
 * licence check, never to the JARVIS brain.
 *
 * The engine consumes fixed 512-sample windows of 16 kHz mono PCM-16 audio.
 */

export const WAKE_SAMPLE_RATE = 16_000;
export const WAKE_FRAME_LENGTH = 512;

export class WakeWordError extends Error {
  constructor(
    message: string,
    readonly code: "missing_key" | "unsupported_keyword" | "engine_failed"
  ) {
    super(message);
    this.name = "WakeWordError";
  }
}

export interface WakeWordEngine {
  readonly frameLength: number;
  readonly sampleRate: number;
  /** Returns true when the wake phrase was recognised in this frame. */
  process(frame: Int16Array): boolean;
  release(): void;
}

/**
 * Resolves the phrase to listen for. Any of Porcupine's built-in keywords works
 * (`jarvis` by default), and a path to a custom `.ppn` file produced for this
 * machine also works, which is what makes a customisable phrase possible.
 */
export function resolveKeywordPath(keyword: string): string {
  const builtin = BuiltinKeyword[keyword.toUpperCase() as keyof typeof BuiltinKeyword];
  // Anything that is not a built-in is treated as a path to a custom .ppn file, which is
  // how a personalised wake phrase gets plugged in.
  const candidate = builtin ? getBuiltinKeywordPath(builtin) : getBuiltinKeywordPath(keyword as BuiltinKeyword);
  if (!candidate || !existsSync(candidate)) {
    throw new WakeWordError(
      `No wake-word model for "${keyword}". Use one of: ${Object.keys(BuiltinKeyword).join(", ")}, or supply a .ppn file.`,
      "unsupported_keyword"
    );
  }
  return candidate;
}

/** Reports what the engine would need to run, without constructing it. */
export function inspectWakeWord(accessKey: string, keyword = "jarvis"): {
  keyConfigured: boolean;
  keywordPath: string | null;
  detail: string;
} {
  const keyConfigured = accessKey.trim().length > 0;
  let keywordPath: string | null = null;
  let detail: string;

  try {
    keywordPath = resolveKeywordPath(keyword);
    detail = keyConfigured
      ? `Ready — listening for "${keyword}".`
      : `Engine available. Add your Picovoice access key to start listening for "${keyword}".`;
  } catch (error) {
    detail = (error as Error).message;
  }

  return { keyConfigured, keywordPath, detail };
}

export function createWakeWordEngine(
  options: { accessKey: string; keyword?: string; sensitivity?: number }
): WakeWordEngine {
  const keyword = options.keyword ?? "jarvis";
  const accessKey = options.accessKey.trim();
  if (!accessKey) {
    throw new WakeWordError(
      "No Picovoice access key configured. Get a free key at console.picovoice.ai and paste it in Settings.",
      "missing_key"
    );
  }

  const keywordPath = resolveKeywordPath(keyword);
  let engine: Porcupine;
  try {
    // (accessKey, keyword model paths, per-keyword sensitivities). The engine always
    // runs at 16 kHz / 512 samples, which is what WAKE_SAMPLE_RATE documents.
    engine = new Porcupine(accessKey, [keywordPath], [options.sensitivity ?? 0.5]);
  } catch (error) {
    const message = (error as Error).message;
    // The engine reports key problems as "Failed to parse AccessKey" (no space), so match
    // both spellings before falling back to the generic construction error.
    throw new WakeWordError(
      /access.?key|authoriz|licence|license|invalid key/i.test(message)
        ? `Picovoice rejected the access key. Paste the AccessKey from console.picovoice.ai — ${message}`
        : `Could not start the wake-word engine: ${message}`,
      "engine_failed"
    );
  }

  let released = false;

  return {
    frameLength: engine.frameLength ?? WAKE_FRAME_LENGTH,
    sampleRate: WAKE_SAMPLE_RATE,
    process(frame: Int16Array): boolean {
      if (released) return false;
      try {
        return engine.process(frame) >= 0;
      } catch {
        // A malformed frame must not take the listener down.
        return false;
      }
    },
    release(): void {
      if (released) return;
      released = true;
      try {
        engine.release();
      } catch {
        /* already released */
      }
    },
  };
}

/** Float32 in [-1, 1] → PCM-16, the format the engine consumes. */
export { floatToInt16 } from "./audio";
