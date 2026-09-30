import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM. Blob layout (base64): iv(12) | authTag(16) | ciphertext. */
function key(raw = process.env.CONNECTOR_ENCRYPTION_KEY): Buffer {
  if (!raw) throw new Error("CONNECTOR_ENCRYPTION_KEY is not set (generate one with: openssl rand -base64 32)");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("CONNECTOR_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encryptSecret(plain: unknown, rawKey?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(rawKey), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(plain), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret<T = unknown>(blob: string, rawKey?: string): T {
  const buf = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", key(rawKey), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  // Tampering or a wrong key makes final() throw.
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")) as T;
}
