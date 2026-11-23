/**
 * gallery_codes as the Access codes page reads them (services/accesscode.js): one page at a time,
 * the counts above the table, and the events a code can be made for. Writes go through
 * models/gallery-code.js. Every query takes `?` parameters; pass `db` to join a transaction.
 */
const { pool } = require("../config/dbconfig")
const { SEAT_IDLE_SECONDS } = require("./gallery-code")

const ACTIVE = "c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > NOW(3))"
const EXPIRED = "c.revoked_at IS NULL AND c.expires_at IS NOT NULL AND c.expires_at <= NOW(3)"
const REVOKED = "c.revoked_at IS NOT NULL"
const STATUS_SQL = { active: ACTIVE, expired: EXPIRED, revoked: REVOKED }

/** "50%_off" → "50\%\_off": typed text is matched literally inside LIKE. */
const likeEscape = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`)

/**
 * Up to `limit` codes, newest first, after `cursor` ({ createdAt, id }), filtered by status and by
 * search: `codeHash` (a whole code) or `text` (part of the event name or label).
 */
async function page({ status = "all", codeHash, text, cursor, limit }) {
  const where = []
  const params = [SEAT_IDLE_SECONDS]
  if (STATUS_SQL[status]) where.push(STATUS_SQL[status])
  if (codeHash || text) {
    const any = []
    if (codeHash) {
      any.push("c.code_hash = ?")
      params.push(codeHash)
    }
    if (text) {
      const like = `%${likeEscape(text)}%`
      any.push("c.event_name LIKE ?", "c.label LIKE ?")
      params.push(like, like)
    }
    where.push(`(${any.join(" OR ")})`)
  }
  if (cursor) {
    // keyset: strictly after the last row shown (ties on created_at broken by id)
    where.push("(c.created_at < ? OR (c.created_at = ? AND c.id < ?))")
    params.push(cursor.createdAt, cursor.createdAt, cursor.id)
  }
  params.push(Number(limit))
  const [rows] = await pool.query(
    `SELECT c.id, c.code_enc, c.event_name, c.label, c.event_id, c.booking_id, c.max_users, c.expires_at, c.revoked_at,
            c.open_count, c.last_opened_at, c.created_by, c.created_at, u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM gallery_code_sessions s
              WHERE s.code_id = c.id AND s.ended_at IS NULL AND s.expires_at > NOW(3)
                AND s.last_seen_at > NOW(3) - INTERVAL ? SECOND) AS live_users
       FROM gallery_codes c LEFT JOIN users u ON u.id = c.created_by
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ?`,
    params,
  )
  return rows
}

/** The figures above the table, over every code. */
async function summary() {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(${ACTIVE}), 0) AS active,
            COALESCE(SUM(${EXPIRED}), 0) AS expired,
            COALESCE(SUM(${REVOKED}), 0) AS revoked,
            COALESCE(SUM(${ACTIVE} AND c.expires_at IS NOT NULL AND c.expires_at < NOW(3) + INTERVAL 30 DAY), 0) AS ending_soon,
            COALESCE(SUM(c.open_count), 0) AS opens,
            COUNT(DISTINCT CASE WHEN ${ACTIVE} THEN COALESCE(c.event_id, c.event_name) END) AS active_events
       FROM gallery_codes c`,
  )
  return row
}

/** The events, newest first (the form's Event list), each with its code's id when it has one. */
async function events({ limit = 500 } = {}) {
  const [rows] = await pool.query("SELECT e.id, e.name, e.event_date, c.id AS code_id FROM events e LEFT JOIN gallery_codes c ON c.event_id = e.id ORDER BY e.event_date DESC, e.name LIMIT ?", [Number(limit)])
  return rows
}

/** The event a new code opens: its name (the gallery's title) and booking. */
async function findEvent(id, db = pool) {
  const [rows] = await db.execute("SELECT id, name, booking_id FROM events WHERE id = ? LIMIT 1", [id])
  return rows[0] ?? null
}

module.exports = { page, summary, events, findEvent }
