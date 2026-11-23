/**
 * Single-use tokens for emailed links (e.g. /verify-email?token=…), stored in
 * auth_tokens.
 *
 * - Each token is 32 random bytes (43 URL-safe characters): unguessable, so a
 *   plain SHA-256 is enough to store it (unlike 6-digit codes, see otp.js).
 * - Issuing a token closes the user's older open tokens of the same purpose,
 *   so only the newest link works.
 * - Using a token marks it used inside the caller's transaction.
 */
const env = require("../config/env")
const { withTransaction } = require("../config/dbconfig")
const tokens = require("../models/auth-token")
const { randomToken, sha256 } = require("../utils/crypto")

/** auth_tokens.token_hash is BINARY(32): the raw digest bytes. */
const hashToken = (token) => Buffer.from(sha256(token), "hex")

const LIFETIME_MS = {
  verify_email: () => env.EMAIL_VERIFY_EXPIRES_IN.ms,
  reset_password: () => env.PASSWORD_RESET_EXPIRES_IN.ms,
}

/** Creates a link token and returns the plain value for the URL. Pass `db` to join a transaction. */
async function issue(userId, purpose, db) {
  const token = randomToken()
  const create = async (conn) => {
    await tokens.closeOpen(userId, purpose, conn)
    await tokens.create(
      { userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + LIFETIME_MS[purpose]()) },
      conn,
    )
  }
  await (db ? create(db) : withTransaction(create))
  return token
}

/**
 * Uses a token up. Returns { ok: true, userId, email }, or
 * { ok: false, reason: "invalid" } (unknown, used or replaced) /
 * { ok: false, reason: "expired", email }.
 */
async function consume(token, purpose, db) {
  const row = await tokens.findOpenByHashForUpdate(hashToken(token), purpose, db)
  if (!row) return { ok: false, reason: "invalid" }
  if (row.expires_at <= new Date()) return { ok: false, reason: "expired", email: row.email }
  await tokens.markUsed(row.id, db)
  return { ok: true, userId: row.user_id, email: row.email, status: row.status }
}

/**
 * Looks at a token without using it (e.g. the reset page checking its link
 * before asking for a new password). Same results as `consume`.
 */
async function inspect(token, purpose) {
  const row = await tokens.findOpenByHash(hashToken(token), purpose)
  if (!row) return { ok: false, reason: "invalid" }
  if (row.expires_at <= new Date()) return { ok: false, reason: "expired", email: row.email }
  return { ok: true, userId: row.user_id, email: row.email, status: row.status }
}

/** Seconds until the user may get another link of this purpose (0 = now). */
async function cooldownSeconds(userId, purpose, cooldownMs) {
  const last = await tokens.latestCreatedAt(userId, purpose)
  if (!last) return 0
  return Math.max(0, Math.ceil((last.getTime() + cooldownMs - Date.now()) / 1000))
}

module.exports = { issue, consume, inspect, cooldownSeconds }
