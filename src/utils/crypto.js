const crypto = require("node:crypto")
const env = require("../config/env")

/** A URL-safe random token (32 bytes = 43 characters). */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url")
}

/** Hex SHA-256: how tokens are stored, so the database never holds a usable one. */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

/** Compares two strings in constant time (no timing hints about how much matched). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/* ---------- Keys derived for one job each ---------- */

/** A 32-byte key for `purpose`, from DATA_KEY when set, else SECRET_KEY (HKDF-SHA-256). */
function deriveKey(purpose) {
  const root = env.DATA_KEY || env.JWT_ACCESS_SECRET
  return Buffer.from(crypto.hkdfSync("sha256", root, "Actionify", purpose, 32))
}

const LOOKUP_KEY = deriveKey("lookup-hmac-v1")
const SEAL_KEY = deriveKey("data-seal-v1")

/** HMAC-SHA-256 (32 bytes) of `value`: a searchable fingerprint that can't be reversed without the key. */
function lookupHash(value) {
  return crypto.createHmac("sha256", LOOKUP_KEY).update(String(value)).digest()
}

/* ---------- Encryption at rest (AES-256-GCM) ---------- */

const VERSION = 1

/** Encrypts a short string: [version 1][iv 12][tag 16][ciphertext]. */
function seal(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", SEAL_KEY, iv)
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body])
}

/** Decrypts what `seal` made. Throws if it was changed or made with another key. */
function open(sealed) {
  const buf = Buffer.from(sealed)
  if (buf[0] !== VERSION || buf.length < 29) throw new Error("Unknown encrypted value")
  const decipher = crypto.createDecipheriv("aes-256-gcm", SEAL_KEY, buf.subarray(1, 13))
  decipher.setAuthTag(buf.subarray(13, 29))
  return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString("utf8")
}

module.exports = { randomToken, sha256, safeEqual, lookupHash, seal, open }
