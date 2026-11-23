/**
 * What a client's gallery shows (services/customer-gallery.js): one event, its albums (the event's
 * categories) and its photographs and videos. Every query is fenced to one event id, which the service
 * takes from the browser's gallery session, never from the request. Only files R2 has whole
 * (status 'ready') and that a browser can show (a preview, or a format it opens itself) are listed.
 */
const { pool } = require("../config/dbconfig")

// what a browser shows itself (utils/filecheck.js SHOWN_IN_BROWSER, photos and videos only)
const VIEWABLE_TYPES = [
  "image/jpeg", "image/png", "image/apng", "image/gif", "image/webp", "image/avif", "image/bmp",
  "video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "video/ogg",
]
const SHOWN = `m.event_id = ? AND m.status = 'ready' AND m.kind IN ('photo', 'video')
  AND (m.preview_key IS NOT NULL OR m.content_type IN (${VIEWABLE_TYPES.map(() => "?").join(", ")}))`
const shownParams = (eventId) => [eventId, ...VIEWABLE_TYPES]

/** The event: its name, kind, day, venue, client and who made it. */
async function findEvent(eventId) {
  const [rows] = await pool.execute(
    `SELECT e.id, e.name, e.slug, e.kind, DATE_FORMAT(e.event_date, '%Y-%m-%d') AS event_day, e.venue, e.booking_id,
            cl.full_name AS client_name, cr.full_name AS created_by_name
       FROM events e LEFT JOIN users cl ON cl.id = e.client_id LEFT JOIN users cr ON cr.id = e.created_by
      WHERE e.id = ? LIMIT 1`,
    [eventId],
  )
  return rows[0] ?? null
}

/** The photographers the studio sent to the event's booking, in the order they were sent. */
async function crewNames(bookingId) {
  if (!bookingId) return []
  const [rows] = await pool.execute(
    "SELECT u.full_name FROM booking_crew c JOIN users u ON u.id = c.user_id WHERE c.booking_id = ? ORDER BY c.assigned_at, u.full_name",
    [bookingId],
  )
  return rows.map((r) => r.full_name)
}

/** The albums (categories, in their order), each with how many of its files are shown. */
async function albums(eventId) {
  const [rows] = await pool.query(
    `SELECT c.id, c.name, c.slug, COUNT(m.id) AS n
       FROM event_categories c
       LEFT JOIN event_media m ON m.category_id = c.id AND ${SHOWN}
      WHERE c.event_id = ?
      GROUP BY c.id, c.name, c.slug, c.position, c.created_at
      ORDER BY c.position, c.created_at`,
    [...shownParams(eventId), eventId],
  )
  return rows
}

/** How much is shown: { files, photos, videos, bytes, loose } (loose: files in no album). */
async function totals(eventId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS files, COALESCE(SUM(m.kind = 'photo'), 0) AS photos, COALESCE(SUM(m.kind = 'video'), 0) AS videos,
            COALESCE(SUM(m.size_bytes), 0) AS bytes, COALESCE(SUM(m.category_id IS NULL), 0) AS loose
       FROM event_media m WHERE ${SHOWN}`,
    shownParams(eventId),
  )
  return row
}

/** The cover: a photograph with a preview, landscape first, the first by name. */
async function cover(eventId) {
  const [rows] = await pool.query(
    `SELECT m.id, m.preview_key, m.object_key, m.content_type, m.original_name FROM event_media m
      WHERE ${SHOWN} AND m.kind = 'photo'
      ORDER BY (m.preview_key IS NULL), (COALESCE(m.width, 0) >= COALESCE(m.height, 0)) DESC, m.file_name, m.id
      LIMIT 1`,
    shownParams(eventId),
  )
  return rows[0] ?? null
}

const ITEM_COLUMNS = `m.id, m.category_id, m.kind, m.object_key, m.preview_key, m.file_name, m.original_name,
  m.content_type, m.size_bytes, m.width, m.height, m.duration_ms`

/** One page of what is shown, by file name (keyset: strictly after `cursor`). */
async function page(eventId, { cursor, limit }) {
  const params = shownParams(eventId)
  let after = ""
  if (cursor) {
    after = "AND (m.file_name > ? OR (m.file_name = ? AND m.id > ?))"
    params.push(cursor.name, cursor.name, cursor.id)
  }
  params.push(Number(limit))
  const [rows] = await pool.query(`SELECT ${ITEM_COLUMNS} FROM event_media m WHERE ${SHOWN} ${after} ORDER BY m.file_name, m.id LIMIT ?`, params)
  return rows
}

module.exports = { findEvent, crewNames, albums, totals, cover, page }
