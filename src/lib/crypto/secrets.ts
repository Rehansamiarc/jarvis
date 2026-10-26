import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env, MissingEnvError } from "@/lib/env";

/**
 * Server-side encrypted credential storage (section 10 / requirement F).
 *
 * Every OAuth refresh token and WordPress application password is sealed with
 * AES-256-GCM before it reaches Postgres, and only ever unsealed inside a server
 * route. The key lives in SECRET_ENCRYPTION_KEY and must never be exposed to the
 * client bundle.
 *
 * Wire form:  v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 * The version prefix lets us rotate the scheme later without guessing.
 */

const VERSION = "v1";
const ALGO = "aes-256-gcm";

function keyBytes(): Buffer {
  const raw = env().SECRET_ENCRYPTION_KEY;
  if (!raw) throw new MissingEnvError(["SECRET_ENCRYPTION_KEY"], "Encrypted credential storage");

  // Accept a base64, hex, or passphrase-style value: derive a stable 32-byte key so the
  // operator never has to think about key length.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  try {
    const b64 = Buffer.from(raw, "base64");
    if (b64.length === 32) return b64;
  } catch {
    /* fall through to derivation */
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function unseal(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;
  const parts = ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unrecognised secret envelope format — was it written by a different version?");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGO, keyBytes(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * SHA-256 of a value for deduplication / change detection. Unlike `seal`, this is
 * deterministic and therefore safe to index — but it is NOT reversible and must never
 * be used for values we need to read back.
 */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time comparison for bearer secrets such as CRON_SECRET. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
