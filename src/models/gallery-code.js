/**
 * gallery_codes, gallery_code_members, gallery_code_sessions, gallery_code_blocks
 * (services/gallerycode.js). Every query takes `?` parameters; pass `db` to join
 * a transaction.
 */
const { pool } = require("../config/dbconfig")

/* ---------- Codes ---------- */

const CODE_COLUMNS = `c.id, c.code_enc, c.event_name, c.label, c.event_id, c.booking_id, c.max_users, c.expires_at, c.revoked_at,
  c.open_count, c.last_opened_at, c.created_by, c.created_at, u.full_name AS created_by_name`
const CODE_FROM = "gallery_codes c LEFT JOIN users u ON u.id = c.created_by"

async function create({ id, codeHash, codeEnc, eventName, label, eventId, bookingId, maxUsers, expiresAt, createdBy }, db = pool) {
  await db.execute(
    `INSERT INTO gallery_codes (id, code_hash, code_enc, event_name, label, event_id, booking_id, max_users, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, codeHash, codeEnc, eventName, label ?? null, eventId ?? null, bookingId ?? null, maxUsers ?? null, expiresAt ?? null, createdBy ?? null],
  )
}

async function findByHash(codeHash, db = pool) {
  const [rows] = await db.execute(`SELECT ${CODE_COLUMNS} FROM ${CODE_FROM} WHERE c.code_hash = ? LIMIT 1`, [codeHash])
  return rows[0] ?? null
}

async function findById(id, db = pool) {
  const [rows] = await db.execute(`SELECT ${CODE_COLUMNS} FROM ${CODE_FROM} WHERE c.id = ? LIMIT 1`, [id])
  return rows[0] ?? null
}

/** The event's one code (gallery_codes.event_id is unique), or null. */
async function findByEvent(eventId, db = pool) {
  const [rows] = await db.execute(`SELECT ${CODE_COLUMNS} FROM ${CODE_FROM} WHERE c.event_id = ? LIMIT 1`, [eventId])
  return rows[0] ?? null
}

/** The codes of several events at once (the Uploads page's folders): at most one each. */
async function findByEvents(eventIds, db = pool) {
  if (!eventIds.length) return []
  const [rows] = await db.query(`SELECT ${CODE_COLUMNS} FROM ${CODE_FROM} WHERE c.event_id IN (?)`, [eventIds])
  return rows
}

/**
 * Regenerating: the same row gets a new code. The old one stops opening the gallery, the counts
 * start again, and a revoked code is open again (it is a fresh code). End date and viewer limit stay.
 */
async function replaceCode(id, { codeHash, codeEnc, createdBy }, db = pool) {
  const [result] = await db.execute(
    `UPDATE gallery_codes SET code_hash = ?, code_enc = ?, open_count = 0, last_opened_at = NULL,
            revoked_at = NULL, revoked_by = NULL, created_by = ?, created_at = NOW(3)
      WHERE id = ?`,
    [codeHash, codeEnc, createdBy ?? null, id],
  )
  return result.affectedRows === 1
}

/** Locks the code row, so two browsers can't both take the last seat. */
async function lockById(id, db) {
  const [rows] = await db.execute("SELECT id, max_users, revoked_at, expires_at FROM gallery_codes WHERE id = ? FOR UPDATE", [id])
  return rows[0] ?? null
}

async function recordOpen(id, db = pool) {
  await db.execute("UPDATE gallery_codes SET open_count = open_count + 1, last_opened_at = NOW(3) WHERE id = ?", [id])
}

async function update(id, { revoked, revokedBy, expiresAt, maxUsers }) {
  const sets = []
  const params = []
  if (revoked !== undefined) {
    sets.push(revoked ? "revoked_at = COALESCE(revoked_at, NOW(3)), revoked_by = ?" : "revoked_at = NULL, revoked_by = NULL")
    if (revoked) params.push(revokedBy ?? null)
  }
  if (expiresAt !== undefined) {
    sets.push("expires_at = ?")
    params.push(expiresAt)
  }
  if (maxUsers !== undefined) {
    sets.push("max_users = ?")
    params.push(maxUsers)
  }
  if (!sets.length) return false
  const [result] = await pool.execute(`UPDATE gallery_codes SET ${sets.join(", ")} WHERE id = ?`, [...params, id])
  return result.affectedRows === 1
}

/* ---------- Members: client accounts that hold a gallery ---------- */

async function addMember(codeId, userId, via = "code", db = pool) {
  await db.execute("INSERT IGNORE INTO gallery_code_members (code_id, user_id, added_via) VALUES (?, ?, ?)", [codeId, userId, via])
}

async function isMember(codeId, userId) {
  const [rows] = await pool.execute("SELECT 1 FROM gallery_code_members WHERE code_id = ? AND user_id = ? LIMIT 1", [codeId, userId])
  return rows.length > 0
}

/** The galleries a client account holds that still open, newest first. */
async function openForUser(userId) {
  const [rows] = await pool.execute(
    `SELECT ${CODE_COLUMNS} FROM gallery_code_members m JOIN ${CODE_FROM} ON c.id = m.code_id
      WHERE m.user_id = ? AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > NOW(3))
      ORDER BY m.added_at DESC`,
    [userId],
  )
  return rows
}

/* ---------- Sessions: browsers viewing a gallery ---------- */

// A seat is free again once its browser hasn't been seen for this long (the dashboard checks in every minute).
const SEAT_IDLE_SECONDS = 180

async function liveSeats(codeId, db = pool) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM gallery_code_sessions
      WHERE code_id = ? AND ended_at IS NULL AND expires_at > NOW(3) AND last_seen_at > NOW(3) - INTERVAL ? SECOND`,
    [codeId, SEAT_IDLE_SECONDS],
  )
  return Number(rows[0].n)
}

/** role: always 'client' (whoever holds a gallery views it as a client); via: 'code' | 'account'. */
async function createSession({ id, codeId, userId, role = "client", via = "code", tokenHash, ip, userAgent, expiresAt }, db = pool) {
  await db.execute(
    `INSERT INTO gallery_code_sessions (id, code_id, user_id, role, via, token_hash, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, codeId, userId ?? null, role, via, tokenHash, ip ?? null, userAgent?.slice(0, 512) ?? null, expiresAt],
  )
}

/** When the client last entered this gallery's code (a session opened by code), or null. */
async function lastCodeOpen(codeId, userId) {
  const [rows] = await pool.execute(
    `SELECT MAX(created_at) AS at FROM gallery_code_sessions WHERE code_id = ? AND user_id = ? AND via = 'code'`,
    [codeId, userId],
  )
  return rows[0]?.at ?? null
}

/** The live session behind a cookie, with its code. */
async function findSession(tokenHash) {
  const [rows] = await pool.execute(
    `SELECT s.id AS session_id, s.user_id, s.role AS session_role, s.via AS session_via, s.expires_at AS session_expires_at, s.last_seen_at, ${CODE_COLUMNS}
       FROM gallery_code_sessions s JOIN ${CODE_FROM} ON c.id = s.code_id
      WHERE s.token_hash = ? AND s.ended_at IS NULL AND s.expires_at > NOW(3) LIMIT 1`,
    [tokenHash],
  )
  return rows[0] ?? null
}

async function touchSession(id) {
  await pool.execute("UPDATE gallery_code_sessions SET last_seen_at = NOW(3) WHERE id = ?", [id])
}

async function endSession(id) {
  await pool.execute("UPDATE gallery_code_sessions SET ended_at = COALESCE(ended_at, NOW(3)) WHERE id = ?", [id])
}

async function endSessionsForCode(codeId) {
  await pool.execute("UPDATE gallery_code_sessions SET ended_at = NOW(3) WHERE code_id = ? AND ended_at IS NULL", [codeId])
}

/* ---------- Blocks: wrong codes per IP ---------- */

async function findBlock(ip) {
  const [rows] = await pool.execute("SELECT failures, window_started_at, blocked_until FROM gallery_code_blocks WHERE ip = ?", [ip])
  return rows[0] ?? null
}

/**
 * One more wrong code from `ip`. Counts within a window of `windowMinutes`; at `max` the IP is
 * blocked for `blockMinutes` and the count starts again. Returns { failures, blockedUntil }.
 */
async function recordFailure(ip, { max, windowMinutes, blockMinutes }) {
  // MySQL assigns left to right: failures reads the old window_started_at before it is reset.
  await pool.execute(
    `INSERT INTO gallery_code_blocks (ip, failures, window_started_at, last_failure_at) VALUES (?, 1, NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE
       failures = IF(window_started_at < NOW(3) - INTERVAL ? MINUTE, 1, failures + 1),
       window_started_at = IF(window_started_at < NOW(3) - INTERVAL ? MINUTE, NOW(3), window_started_at),
       last_failure_at = NOW(3)`,
    [ip, windowMinutes, windowMinutes],
  )
  await pool.execute(
    `UPDATE gallery_code_blocks
        SET blocked_until = NOW(3) + INTERVAL ? MINUTE, failures = 0, window_started_at = NOW(3), times_blocked = times_blocked + 1
      WHERE ip = ? AND failures >= ?`,
    [blockMinutes, ip, max],
  )
  const row = await findBlock(ip)
  return { failures: row?.failures ?? 0, blockedUntil: row?.blocked_until ?? null }
}

module.exports = {
  SEAT_IDLE_SECONDS,
  create,
  findByHash,
  findById,
  findByEvent,
  findByEvents,
  replaceCode,
  lockById,
  recordOpen,
  update,
  addMember,
  isMember,
  openForUser,
  liveSeats,
  createSession,
  findSession,
  touchSession,
  lastCodeOpen,
  endSession,
  endSessionsForCode,
  findBlock,
  recordFailure,
}
