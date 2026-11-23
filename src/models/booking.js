/**
 * bookings and booking_crew (services/bookings.js). Every query takes `?` parameters; pass `db` to
 * join a transaction.
 */
const { pool } = require("../config/dbconfig")

// the staff who can be sent to a booking
const CREW_ROLES = ["photographer", "assistant", "studio_lead"]

const BOOKING_COLUMNS = `b.id, b.client_name, b.email, b.phone, b.event_type,
  DATE_FORMAT(b.event_date, '%Y-%m-%d') AS event_day, TIME_FORMAT(b.start_time, '%H:%i') AS start_hm,
  b.venue, b.coverage, b.crew, b.notes, b.status, b.user_id, b.handled_by, h.full_name AS handled_by_name,
  b.created_at, b.updated_at, e.id AS event_id, e.name AS event_name,
  (gc.id IS NOT NULL AND gc.revoked_at IS NULL AND (gc.expires_at IS NULL OR gc.expires_at > NOW(3))) AS code_live`
// the event's one gallery code (gallery_codes.event_id is unique): whether the client can be sent its link
const BOOKING_FROM = `bookings b
  LEFT JOIN users h ON h.id = b.handled_by
  LEFT JOIN events e ON e.booking_id = b.id
  LEFT JOIN gallery_codes gc ON gc.event_id = e.id`

/** "50%_off" → "50\%\_off": typed text is matched literally inside LIKE. */
const likeEscape = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`)

async function create(row, db = pool) {
  await db.execute(
    `INSERT INTO bookings (id, client_name, email, phone, event_type, event_date, start_time, venue, coverage, crew, notes,
                           status, user_id, handled_by, source_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      row.email,
      row.phone ?? null,
      row.type,
      row.date,
      row.time ?? null,
      row.venue,
      row.coverage ?? null,
      row.crew,
      row.notes ?? null,
      row.status,
      row.userId ?? null,
      row.handledBy ?? null,
      row.ip ?? null,
    ],
  )
}

async function findById(id, db = pool) {
  const [rows] = await db.execute(`SELECT ${BOOKING_COLUMNS} FROM ${BOOKING_FROM} WHERE b.id = ? LIMIT 1`, [id])
  return rows[0] ?? null
}

/** Locks the booking while its status changes. */
async function lockById(id, db) {
  const [rows] = await db.execute("SELECT id, status FROM bookings WHERE id = ? FOR UPDATE", [id])
  return rows[0] ?? null
}

/**
 * Up to `limit` bookings, newest first, after `cursor` ({ createdAt, id }), filtered by status
 * ("all": everything but cancelled) and by search: `idPrefix` (a reference) or `text`.
 */
async function page({ status = "all", idPrefix, text, cursor, limit }) {
  const where = []
  const params = []
  if (status === "all") where.push("b.status <> 'cancelled'")
  else {
    where.push("b.status = ?")
    params.push(status)
  }
  if (idPrefix || text) {
    const any = []
    if (idPrefix) {
      any.push("b.id LIKE ?")
      params.push(`${idPrefix}%`)
    }
    if (text) {
      const like = `%${likeEscape(text)}%`
      any.push("b.client_name LIKE ?", "b.email LIKE ?", "b.venue LIKE ?", "b.phone LIKE ?")
      params.push(like, like, like, like)
    }
    where.push(`(${any.join(" OR ")})`)
  }
  if (cursor) {
    // keyset: strictly after the last row shown (ties on created_at broken by id)
    where.push("(b.created_at < ? OR (b.created_at = ? AND b.id < ?))")
    params.push(cursor.createdAt, cursor.createdAt, cursor.id)
  }
  params.push(Number(limit))
  const [rows] = await pool.query(
    `SELECT ${BOOKING_COLUMNS} FROM ${BOOKING_FROM}
      WHERE ${where.join(" AND ")}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ?`,
    params,
  )
  return rows
}

/** Who is sent to each of these bookings: Map(bookingId → [{ id, name }]). */
async function crewOf(bookingIds, db = pool) {
  const out = new Map()
  if (!bookingIds.length) return out
  const [rows] = await db.query(
    `SELECT c.booking_id, u.id, u.full_name, u.photo_key FROM booking_crew c JOIN users u ON u.id = c.user_id
      WHERE c.booking_id IN (?) ORDER BY c.assigned_at, u.full_name`,
    [bookingIds],
  )
  for (const r of rows) {
    if (!out.has(r.booking_id)) out.set(r.booking_id, [])
    out.get(r.booking_id).push({ id: r.id, name: r.full_name, photoKey: r.photo_key })
  }
  return out
}

/** The figures on the status lanes and tabs, over every booking. */
async function summary() {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(b.status = 'requested'), 0) AS requested,
            COALESCE(SUM(b.status = 'confirmed'), 0) AS confirmed,
            COALESCE(SUM(b.status = 'dispatched'), 0) AS dispatched,
            COALESCE(SUM(b.status = 'completed'), 0) AS completed,
            COALESCE(SUM(b.status = 'cancelled'), 0) AS cancelled,
            COALESCE(SUM(b.status IN ('requested', 'confirmed') AND b.event_date <= CURRENT_DATE + INTERVAL 7 DAY), 0) AS within_week,
            COALESCE(SUM(b.status = 'completed' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.booking_id = b.id)), 0) AS without_folder,
            (SELECT COUNT(DISTINCT c.user_id) FROM booking_crew c JOIN bookings d ON d.id = c.booking_id
              WHERE d.status = 'dispatched') AS crew_out
       FROM bookings b`,
  )
  return row
}

/** Moves the booking to `status`; `handledBy` is who did it. */
async function setStatus(id, { status, handledBy }, db = pool) {
  await db.execute("UPDATE bookings SET status = ?, handled_by = COALESCE(?, handled_by) WHERE id = ?", [status, handledBy ?? null, id])
}

/** Who goes: the list replaces the one before. */
async function setCrew(bookingId, userIds, assignedBy, db) {
  await db.execute("DELETE FROM booking_crew WHERE booking_id = ?", [bookingId])
  for (const userId of userIds) {
    await db.execute("INSERT INTO booking_crew (booking_id, user_id, assigned_by) VALUES (?, ?, ?)", [bookingId, userId, assignedBy ?? null])
  }
}

/**
 * The staff who can be sent, with the booking each one is out on now (status dispatched), if any,
 * and whether they are off on `day` (staff_days_off; the Photographers page):
 * [{ id, full_name, role_slug, mobile, off_today, busy_booking_id, busy_client, busy_venue }].
 */
async function crewMembers({ ids, day } = {}, db = pool) {
  const params = [day ?? new Date().toISOString().slice(0, 10), CREW_ROLES]
  let only = ""
  if (ids) {
    only = "AND u.id IN (?)"
    params.push(ids.length ? ids : [""])
  }
  const [rows] = await db.query(
    `SELECT u.id, u.full_name, u.role_slug, u.mobile, u.photo_key,
            EXISTS (SELECT 1 FROM staff_days_off o WHERE o.user_id = u.id AND o.day = ?) AS off_today,
            (SELECT d.id FROM booking_crew c JOIN bookings d ON d.id = c.booking_id
              WHERE c.user_id = u.id AND d.status = 'dispatched' ORDER BY d.event_date LIMIT 1) AS busy_booking_id
       FROM users u
      WHERE u.role_slug IN (?) AND u.status = 'active' ${only}
      ORDER BY u.full_name`,
    params,
  )
  const busyIds = [...new Set(rows.map((r) => r.busy_booking_id).filter(Boolean))]
  if (busyIds.length) {
    const [busy] = await db.query("SELECT id, client_name, venue FROM bookings WHERE id IN (?)", [busyIds])
    const byId = new Map(busy.map((b) => [b.id, b]))
    for (const r of rows) {
      const b = byId.get(r.busy_booking_id)
      if (b) Object.assign(r, { busy_client: b.client_name, busy_venue: b.venue })
    }
  }
  return rows
}

module.exports = { CREW_ROLES, create, findById, lockById, page, crewOf, summary, setStatus, setCrew, crewMembers }
