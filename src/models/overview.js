/**
 * The figures on the panel's Overview page (services/overview.js), read straight from the tables:
 * event_media (what is on R2: a file counts once R2 has all of it, status 'ready'), events, bookings
 * and booking_crew. Every query takes `?` parameters.
 */
const { pool } = require("../config/dbconfig")

/** Everything on R2: { files, photos, videos, bytes, events }. */
async function mediaTotals() {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS files,
            COALESCE(SUM(m.kind = 'photo'), 0) AS photos,
            COALESCE(SUM(m.kind = 'video'), 0) AS videos,
            COALESCE(SUM(m.size_bytes), 0) AS bytes,
            (SELECT COUNT(*) FROM events) AS events
       FROM event_media m WHERE m.status = 'ready'`,
  )
  return row
}

/**
 * Files that reached R2 each day since `since` ("YYYY-MM-DD HH:MM:SS", UTC), grouped by the studio's
 * own day (`offset`: minutes east of UTC) → [{ day: "2026-11-22", files, photos, bytes }].
 */
async function uploadsByDay({ since, offset }) {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(COALESCE(m.uploaded_at, m.created_at) + INTERVAL ? MINUTE, '%Y-%m-%d') AS day,
            COUNT(*) AS files,
            COALESCE(SUM(m.kind = 'photo'), 0) AS photos,
            COALESCE(SUM(m.size_bytes), 0) AS bytes
       FROM event_media m
      WHERE m.status = 'ready' AND COALESCE(m.uploaded_at, m.created_at) >= ?
      GROUP BY day ORDER BY day`,
    [offset, since],
  )
  return rows
}

/** Bookings by state, those still ahead (`today`: "YYYY-MM-DD") and how many people are out on a job. */
async function bookingCounts(today) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(b.status = 'requested'), 0) AS requested,
            COALESCE(SUM(b.status = 'confirmed'), 0) AS confirmed,
            COALESCE(SUM(b.status = 'dispatched'), 0) AS dispatched,
            COALESCE(SUM(b.status = 'completed'), 0) AS completed,
            COALESCE(SUM(b.status = 'cancelled'), 0) AS cancelled,
            COALESCE(SUM(b.status IN ('requested', 'confirmed') AND b.event_date >= ?), 0) AS upcoming,
            (SELECT COUNT(DISTINCT c.user_id) FROM booking_crew c JOIN bookings d ON d.id = c.booking_id
              WHERE d.status = 'dispatched') AS crew_out
       FROM bookings b`,
    [today],
  )
  return row
}

/** Bookings in one state, soonest first (the day, then the start time). */
async function bookingsIn(status, limit) {
  const [rows] = await pool.query(
    `SELECT b.id, b.client_name, b.event_type, DATE_FORMAT(b.event_date, '%Y-%m-%d') AS event_day,
            TIME_FORMAT(b.start_time, '%H:%i') AS start_hm, b.venue, b.crew, b.status
       FROM bookings b
      WHERE b.status = ?
      ORDER BY b.event_date, b.start_time IS NULL, b.start_time, b.created_at
      LIMIT ?`,
    [status, Number(limit)],
  )
  return rows
}

/**
 * Clients as the Clients page counts them: one per email address with a booking that wasn't
 * cancelled; "new" when their first such booking came in after `since` (UTC).
 */
async function clientCounts(since) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS clients, COALESCE(SUM(t.first_at >= ?), 0) AS recent
       FROM (SELECT b.email, MIN(b.created_at) AS first_at FROM bookings b WHERE b.status <> 'cancelled' GROUP BY b.email) t`,
    [since],
  )
  return row
}

module.exports = { mediaTotals, uploadsByDay, bookingCounts, bookingsIn, clientCounts }
