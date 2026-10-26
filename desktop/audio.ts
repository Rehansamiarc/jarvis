/**
 * Audio conversion shared by the capture path (renderer) and the wake-word engine.
 * Pure, dependency-free, and safe to bundle into either process.
 */

/** Float32 samples in [-1, 1] → PCM-16, the format the wake-word engine consumes. */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

/** Frames produced by the AudioWorklet are 128 samples; batch them before crossing IPC. */
export const CAPTURE_BATCH_SAMPLES = 2048;
