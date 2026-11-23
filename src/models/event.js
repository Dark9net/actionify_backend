/**
 * events and event_categories (services/events.js). Every query takes `?` parameters;
 * pass `db` to join a transaction.
 */
const { pool } = require("../config/dbconfig")

const EVENT_COLUMNS = `e.id, e.name, e.slug, e.kind, e.event_date, e.venue, e.booking_id, e.client_id, e.created_by, e.created_at,
  cl.full_name AS client_name, cr.full_name AS created_by_name`
const EVENT_FROM = "events e LEFT JOIN users cl ON cl.id = e.client_id LEFT JOIN users cr ON cr.id = e.created_by"

async function create({ id, name, slug, kind, date, venue, bookingId, clientId, createdBy }, db = pool) {
  await db.execute(
    `INSERT INTO events (id, name, slug, kind, event_date, venue, booking_id, client_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, slug, kind, date, venue ?? null, bookingId ?? null, clientId ?? null, createdBy ?? null],
  )
}

/** [{ id, name, slug, position }] in one insert. */
async function addCategories(eventId, rows, db = pool) {
  if (!rows.length) return
  await db.query("INSERT INTO event_categories (id, event_id, name, slug, position) VALUES ?", [
    rows.map((c) => [c.id, eventId, c.name, c.slug, c.position]),
  ])
}

/** The slugs already taken by `base` and `base-N` (base is only a-z, 0-9 and dashes, so LIKE is safe). */
async function slugsLike(base, db = pool) {
  const [rows] = await db.execute("SELECT slug FROM events WHERE slug = ? OR slug LIKE ?", [base, `${base}-%`])
  return new Set(rows.map((r) => r.slug))
}

async function findById(id, db = pool) {
  const [rows] = await db.execute(`SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM} WHERE e.id = ? LIMIT 1`, [id])
  return rows[0] ?? null
}

async function list({ limit = 500 } = {}) {
  const [rows] = await pool.query(`SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM} ORDER BY e.created_at DESC LIMIT ?`, [Number(limit)])
  return rows
}

/** { eventId: [category, …] } for the given events, in form order. */
async function categoriesOf(eventIds, db = pool) {
  const out = new Map(eventIds.map((id) => [id, []]))
  if (!eventIds.length) return out
  const [rows] = await db.query(
    "SELECT id, event_id, name, slug, position FROM event_categories WHERE event_id IN (?) ORDER BY position, created_at",
    [eventIds],
  )
  for (const row of rows) out.get(row.event_id)?.push(row)
  return out
}

/** Locks the booking an event is made for, so two events can't both claim it. */
async function lockBooking(id, db) {
  const [rows] = await db.execute("SELECT id, status, user_id FROM bookings WHERE id = ? FOR UPDATE", [id])
  return rows[0] ?? null
}

/** The account named as the event's client: its role and whether it is turned off. */
async function findAccount(id, db = pool) {
  const [rows] = await db.execute("SELECT id, role_slug, status FROM users WHERE id = ? LIMIT 1", [id])
  return rows[0] ?? null
}

/** A new name for the event, and for the gallery codes that show it. */
async function rename(id, name, db = pool) {
  const [res] = await db.execute("UPDATE events SET name = ? WHERE id = ?", [name, id])
  await db.execute("UPDATE gallery_codes SET event_name = ? WHERE event_id = ?", [name, id])
  return res.affectedRows
}

/** One category of one event (null when it's another event's, or gone). */
async function findCategory(eventId, categoryId, db = pool) {
  const [rows] = await db.execute("SELECT id, event_id, name, slug, position FROM event_categories WHERE event_id = ? AND id = ? LIMIT 1", [
    eventId,
    categoryId,
  ])
  return rows[0] ?? null
}

/** The next position on the list, and how many categories the event has. */
async function categorySlots(eventId, db = pool) {
  const [[row]] = await db.execute("SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) + 1 AS next FROM event_categories WHERE event_id = ?", [
    eventId,
  ])
  return { count: Number(row.n), next: Math.min(255, Number(row.next)) }
}

async function renameCategory(eventId, categoryId, name, db = pool) {
  await db.execute("UPDATE event_categories SET name = ? WHERE event_id = ? AND id = ?", [name, eventId, categoryId])
}

/**
 * Deletes the event. Its files go first: a file points at its category, and that link doesn't
 * cascade, so the categories couldn't go while files are in them. The categories and gallery codes
 * then go with the event (ON DELETE CASCADE). Run it in a transaction.
 */
async function remove(id, db = pool) {
  await db.execute("DELETE FROM event_media WHERE event_id = ?", [id])
  const [res] = await db.execute("DELETE FROM events WHERE id = ?", [id])
  return res.affectedRows
}

async function removeCategory(eventId, categoryId, db = pool) {
  const [res] = await db.execute("DELETE FROM event_categories WHERE event_id = ? AND id = ?", [eventId, categoryId])
  return res.affectedRows
}

module.exports = {
  create,
  addCategories,
  slugsLike,
  findById,
  list,
  categoriesOf,
  lockBooking,
  findAccount,
  rename,
  findCategory,
  remove,
  categorySlots,
  renameCategory,
  removeCategory,
}
