/**
 * auth_tokens: single-use email links (utils/link-token.js) and one-time codes
 * (utils/otp.js). Only hashes are stored.
 */
const { pool } = require("../config/dbconfig")
const crypto = require("node:crypto")

/** Marks the user's open tokens of this purpose used, so only the newest one works. */
async function closeOpen(userId, purpose, db = pool) {
  await db.execute("UPDATE auth_tokens SET used_at = NOW(3) WHERE user_id = ? AND purpose = ? AND used_at IS NULL", [
    userId,
    purpose,
  ])
}

async function create({ userId, purpose, tokenHash, expiresAt }, db = pool) {
  await db.execute("INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)", [
    crypto.randomUUID(),
    userId,
    purpose,
    tokenHash,
    expiresAt,
  ])
}

const BY_HASH = `SELECT t.id, t.user_id, t.expires_at, t.attempts, u.email, u.full_name, u.status
  FROM auth_tokens t JOIN users u ON u.id = t.user_id
  WHERE t.token_hash = ? AND t.purpose = ? AND t.used_at IS NULL AND u.status <> 'disabled' LIMIT 1`

async function findOpenByHash(tokenHash, purpose) {
  const [rows] = await pool.execute(BY_HASH, [tokenHash, purpose])
  return rows[0] ?? null
}

/** The same, locked until the transaction ends, so a link can't be used twice at once. */
async function findOpenByHashForUpdate(tokenHash, purpose, db) {
  const [rows] = await db.execute(`${BY_HASH} FOR UPDATE`, [tokenHash, purpose])
  return rows[0] ?? null
}

/** The user's newest open code of this purpose, locked (utils/otp.js). */
async function findOpenForUpdate(userId, purpose, db) {
  const [rows] = await db.execute(
    `SELECT id, token_hash, attempts, expires_at FROM auth_tokens
      WHERE user_id = ? AND purpose = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [userId, purpose],
  )
  return rows[0] ?? null
}

async function markUsed(id, db = pool) {
  await db.execute("UPDATE auth_tokens SET used_at = NOW(3) WHERE id = ?", [id])
}

/** One wrong guess; the code is used up once `max` is reached. */
async function recordAttempt(id, max, db = pool) {
  await db.execute(
    "UPDATE auth_tokens SET attempts = attempts + 1, used_at = IF(attempts >= ?, NOW(3), used_at) WHERE id = ?",
    [max, id],
  )
}

/** When the user last got a token of this purpose (for resend cooldowns). */
async function latestCreatedAt(userId, purpose) {
  const [rows] = await pool.execute(
    "SELECT MAX(created_at) AS at FROM auth_tokens WHERE user_id = ? AND purpose = ?",
    [userId, purpose],
  )
  return rows[0]?.at ?? null
}

module.exports = {
  closeOpen,
  create,
  findOpenByHash,
  findOpenByHashForUpdate,
  findOpenForUpdate,
  markUsed,
  recordAttempt,
  latestCreatedAt,
}
