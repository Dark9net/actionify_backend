/**
 * user_sessions: one row per signed-in device. Only the SHA-256 of the current
 * refresh token is stored (utils/session.js).
 */
const { pool } = require("../config/dbconfig")

async function create({ id, userId, tokenHash, remember, userAgent, ip, expiresAt }, db = pool) {
  await db.execute(
    `INSERT INTO user_sessions (id, user_id, token_hash, remember, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, tokenHash, Boolean(remember), userAgent?.slice(0, 512) ?? null, ip ?? null, expiresAt],
  )
}

/** The session with what refresh needs to know about its user. */
async function findById(id) {
  const [rows] = await pool.execute(
    `SELECT s.id, s.user_id, s.token_hash, s.remember, s.expires_at, s.revoked_at,
            u.status AS user_status, u.email_verified_at, u.password_changed_at
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

/** A session that may be used right now: not revoked or expired, its user active and confirmed. */
async function findActive(id) {
  const [rows] = await pool.execute(
    `SELECT s.id, s.user_id, u.password_changed_at, u.role_slug
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > NOW(3)
        AND u.status = 'active' AND u.email_verified_at IS NOT NULL
      LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

/** Swaps the refresh token only if it's still `oldHash` (so two parallel refreshes can't both win). */
async function rotate(id, oldHash, newHash) {
  const [result] = await pool.execute(
    "UPDATE user_sessions SET token_hash = ?, last_seen_at = NOW(3) WHERE id = ? AND token_hash = ? AND revoked_at IS NULL",
    [newHash, id, oldHash],
  )
  return result.affectedRows === 1
}

async function revokeById(id) {
  await pool.execute("UPDATE user_sessions SET revoked_at = NOW(3) WHERE id = ? AND revoked_at IS NULL", [id])
}

/** Ends every live session of the user (but `exceptId`). Returns the ids ended. */
async function revokeAllForUser(userId, exceptId = null, db = pool) {
  const [rows] = await db.execute(
    "SELECT id FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR id <> ?)",
    [userId, exceptId, exceptId],
  )
  if (rows.length) {
    await db.execute(
      "UPDATE user_sessions SET revoked_at = NOW(3) WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR id <> ?)",
      [userId, exceptId, exceptId],
    )
  }
  return rows.map((r) => r.id)
}

/** Live session ids of a user (to drop their cached copies after a role change). */
async function liveIds(userId) {
  const [rows] = await pool.execute("SELECT id FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL", [userId])
  return rows.map((r) => r.id)
}

module.exports = { create, findById, findActive, rotate, revokeById, revokeAllForUser, liveIds }
