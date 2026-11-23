/**
 * The team on the Photographers page (services/team.js): photographer and editor accounts, with
 * where each one is now. Every query takes `?` parameters.
 *
 *   onsite  on the crew of a booking that is dispatched (booking_crew + bookings)
 *   off     a row in staff_days_off for the day asked about
 *   free    an active account, neither of those
 */
const { pool } = require("../config/dbconfig")

const ONSITE = `EXISTS (SELECT 1 FROM booking_crew c JOIN bookings d ON d.id = c.booking_id
                         WHERE c.user_id = u.id AND d.status = 'dispatched')`
const OFF = "EXISTS (SELECT 1 FROM staff_days_off o WHERE o.user_id = u.id AND o.day = ?)"

/** "50%_off" → "50\%\_off": typed text is matched literally inside LIKE. */
const likeEscape = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`)

/** The WHERE for a state; `day` goes in params where OFF needs it. */
function stateWhere(status, day, params) {
  if (status === "onsite") return [ONSITE]
  if (status === "off") {
    params.push(day)
    return [OFF, `NOT ${ONSITE}`]
  }
  if (status === "free") {
    params.push(day)
    return ["u.status = 'active'", `NOT ${ONSITE}`, `NOT ${OFF}`]
  }
  return []
}

/**
 * Up to `limit` people by name (then id), after `cursor` ({ name, id }) (or the one `id`), with:
 * onsite_booking_id, off_today, completed (bookings they were on), last_booking_id (latest completed).
 */
async function page({ roles, status, text, day, cursor, limit, id }) {
  const params = [day]
  const where = ["u.role_slug IN (?)"]
  params.push(roles)
  if (id) {
    where.push("u.id = ?")
    params.push(id)
  }
  where.push(...stateWhere(status, day, params))
  if (text) {
    const like = `%${likeEscape(text)}%`
    where.push("(u.full_name LIKE ? OR u.email LIKE ? OR u.mobile LIKE ?)")
    params.push(like, like, like)
  }
  if (cursor) {
    where.push("(u.full_name > ? OR (u.full_name = ? AND u.id > ?))")
    params.push(cursor.name, cursor.name, cursor.id)
  }
  params.push(limit)
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.mobile, u.photo_key, u.role_slug, u.status, u.last_login_at, u.created_at,
            EXISTS (SELECT 1 FROM staff_days_off o WHERE o.user_id = u.id AND o.day = ?) AS off_today,
            (SELECT d.id FROM booking_crew c JOIN bookings d ON d.id = c.booking_id
              WHERE c.user_id = u.id AND d.status = 'dispatched'
              ORDER BY d.event_date, d.start_time LIMIT 1) AS onsite_booking_id,
            (SELECT COUNT(*) FROM booking_crew c JOIN bookings d ON d.id = c.booking_id
              WHERE c.user_id = u.id AND d.status = 'completed') AS completed,
            (SELECT d.id FROM booking_crew c JOIN bookings d ON d.id = c.booking_id
              WHERE c.user_id = u.id AND d.status = 'completed'
              ORDER BY d.event_date DESC, d.updated_at DESC LIMIT 1) AS last_booking_id
       FROM users u
      WHERE ${where.join(" AND ")}
      ORDER BY u.full_name, u.id
      LIMIT ?`,
    params,
  )
  return rows
}

/** The bookings a page points at: id → { id, client_name, event_type, event_day, start_hm, venue }. */
async function bookingsByIds(ids) {
  if (!ids.length) return new Map()
  const [rows] = await pool.query(
    `SELECT id, client_name, event_type, DATE_FORMAT(event_date, '%Y-%m-%d') AS event_day,
            TIME_FORMAT(start_time, '%H:%i') AS start_hm, venue
       FROM bookings WHERE id IN (?)`,
    [ids],
  )
  return new Map(rows.map((r) => [r.id, r]))
}

/** The counts on the page: everyone, by role and by state. */
async function summary({ roles, day }) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(u.role_slug = 'photographer'), 0) AS photographers,
            COALESCE(SUM(u.role_slug = 'editor'), 0) AS editors,
            COALESCE(SUM(${ONSITE}), 0) AS onsite,
            COALESCE(SUM(NOT ${ONSITE} AND EXISTS (SELECT 1 FROM staff_days_off o WHERE o.user_id = u.id AND o.day = ?)), 0) AS off,
            COALESCE(SUM(u.status = 'active' AND NOT ${ONSITE}
                         AND NOT EXISTS (SELECT 1 FROM staff_days_off o WHERE o.user_id = u.id AND o.day = ?)), 0) AS free,
            COALESCE(SUM(u.status <> 'active'), 0) AS inactive
       FROM users u
      WHERE u.role_slug IN (?)`,
    [day, day, roles],
  )
  return row
}

/** One account, if it is on the team: { id, full_name, role_slug, status }. */
async function findMember(id, roles) {
  const [rows] = await pool.query("SELECT id, full_name, role_slug, status FROM users WHERE id = ? AND role_slug IN (?) LIMIT 1", [id, roles])
  return rows[0] ?? null
}

/** Off (or back) on `day`. */
async function setOff(userId, day, off, setBy) {
  if (off) {
    await pool.execute("INSERT IGNORE INTO staff_days_off (user_id, day, set_by) VALUES (?, ?, ?)", [userId, day, setBy ?? null])
  } else {
    await pool.execute("DELETE FROM staff_days_off WHERE user_id = ? AND day = ?", [userId, day])
  }
}

module.exports = { page, bookingsByIds, summary, findMember, setOff }
