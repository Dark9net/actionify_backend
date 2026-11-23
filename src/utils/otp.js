/**
 * Six-digit one-time codes (OTP) for email verification, password reset and
 * 2FA login, stored in auth_tokens.
 *
 * - Codes come from crypto.randomInt (uniform, unpredictable).
 * - Only HMAC-SHA-256(key, purpose:user:code) is stored. A plain hash of a
 *   6-digit code could be reversed by trying all million codes; the secret key
 *   (derived from SECRET_KEY) prevents that if the database leaks.
 * - Each code allows OTP_MAX_ATTEMPTS wrong guesses, then a new code is needed.
 * - Issuing a code closes the user's older codes of the same purpose.
 */
const crypto = require("node:crypto")
const env = require("../config/env")
const { withTransaction } = require("../config/dbconfig")
const tokens = require("../models/auth-token")

const KEY = crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update("otp-hash-v1").digest()
const CODE_LENGTH = 6

const hashCode = (userId, purpose, code) => crypto.createHmac("sha256", KEY).update(`${purpose}:${userId}:${code}`).digest()

/** Creates a code for the user and returns it (for the email). Pass `db` to join a transaction. */
async function issue(userId, purpose, db) {
  const code = String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0")
  const create = async (conn) => {
    await tokens.closeOpen(userId, purpose, conn)
    await tokens.create(
      { userId, purpose, tokenHash: hashCode(userId, purpose, code), expiresAt: new Date(Date.now() + env.OTP_EXPIRES_IN.ms) },
      conn,
    )
  }
  await (db ? create(db) : withTransaction(create))
  return code
}

/**
 * Checks a code. Returns { ok: true } and uses the code up, or
 * { ok: false, reason: "missing" | "expired" | "invalid", attemptsLeft }.
 * Runs in its own transaction, or in `db` when given.
 */
async function check(userId, purpose, code, db) {
  const run = async (conn) => {
    const row = await tokens.findOpenForUpdate(userId, purpose, conn)
    if (!row) return { ok: false, reason: "missing" }
    if (row.expires_at <= new Date()) {
      await tokens.markUsed(row.id, conn)
      return { ok: false, reason: "expired" }
    }
    const expected = Buffer.from(row.token_hash)
    if (!crypto.timingSafeEqual(expected, hashCode(userId, purpose, code))) {
      await tokens.recordAttempt(row.id, env.OTP_MAX_ATTEMPTS, conn)
      const attemptsLeft = Math.max(0, env.OTP_MAX_ATTEMPTS - (row.attempts + 1))
      return { ok: false, reason: attemptsLeft ? "invalid" : "expired", attemptsLeft }
    }
    await tokens.markUsed(row.id, conn)
    return { ok: true }
  }
  return db ? run(db) : withTransaction(run)
}

/** Seconds until the user may get another code of this purpose (0 = now). */
async function cooldownSeconds(userId, purpose, cooldownMs) {
  const last = await tokens.latestCreatedAt(userId, purpose)
  if (!last) return 0
  return Math.max(0, Math.ceil((last.getTime() + cooldownMs - Date.now()) / 1000))
}

module.exports = { issue, check, cooldownSeconds, CODE_LENGTH }
