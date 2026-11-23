/**
 * event_media: the photographs and videos of each event (services/media.js). Every query names the
 * event (`WHERE event_id = ?`), so a file is only ever found through its own event. Every query takes
 * `?` parameters; pass `db` to join a transaction.
 */
const { pool } = require("../config/dbconfig")

const COLUMNS = `m.id, m.event_id, m.category_id, m.kind, m.object_key, m.preview_key, m.file_name, m.original_name,
  m.content_type, m.size_bytes, m.width, m.height, m.duration_ms, m.file_modified_at, m.etag, m.status,
  m.upload_id, m.part_size, m.uploaded_by, u.full_name AS uploaded_by_name, m.created_at, m.uploaded_at`
const FROM = "event_media m LEFT JOIN users u ON u.id = m.uploaded_by"

/** The event a file goes into: its folder (slug) and name. */
async function findEvent(eventId, db = pool) {
  const [rows] = await db.execute("SELECT id, name, slug FROM events WHERE id = ? LIMIT 1", [eventId])
  return rows[0] ?? null
}

/** The event's categories by id: { id → { id, name, slug } }. */
async function categoriesOf(eventId, db = pool) {
  const [rows] = await db.execute("SELECT id, name, slug FROM event_categories WHERE event_id = ?", [eventId])
  return new Map(rows.map((r) => [r.id, r]))
}

/**
 * The file names already used in one folder of the event that start like `base` (to pick base-2,
 * base-3…). Names are only a-z, 0-9, dots and dashes, so LIKE needs no escaping.
 */
async function namesLike(eventId, folder, base, db = pool) {
  const [rows] = await db.execute("SELECT object_key FROM event_media WHERE event_id = ? AND object_key LIKE ?", [
    eventId,
    `${folder}${base}%`,
  ])
  return new Set(rows.map((r) => r.object_key.slice(folder.length)))
}

/** New files, all 'pending' until the browser has sent them. */
async function insertPending(list, db = pool) {
  if (!list.length) return
  await db.query(
    `INSERT INTO event_media (id, event_id, category_id, kind, object_key, preview_key, file_name, original_name,
       content_type, size_bytes, file_modified_at, uploaded_by) VALUES ?`,
    [
      list.map((m) => [
        m.id,
        m.eventId,
        m.categoryId,
        m.kind,
        m.key,
        m.previewKey,
        m.fileName,
        m.originalName,
        m.contentType,
        m.size,
        m.fileModifiedAt,
        m.uploadedBy,
      ]),
    ],
  )
}

/** Files of this event by id (other events' files are never returned). */
async function findInEvent(eventId, ids, db = pool) {
  if (!ids.length) return []
  const [rows] = await db.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE m.event_id = ? AND m.id IN (?)`, [eventId, ids])
  return rows
}

async function findOne(eventId, id, db = pool) {
  const [row] = await findInEvent(eventId, [id], db)
  return row ?? null
}

/** A large file's upload in parts: its R2 upload and part size (a new upload when the old one expired). */
async function setUpload(eventId, id, { uploadId, partSize }, db = pool) {
  await db.execute(
    "UPDATE event_media SET upload_id = ?, part_size = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE event_id = ? AND id = ? AND status = 'pending'",
    [uploadId, partSize, eventId, id],
  )
}

/** Parts of it are still being sent: it isn't swept as abandoned. */
async function touch(eventId, id, db = pool) {
  await db.execute("UPDATE event_media SET updated_at = CURRENT_TIMESTAMP(3) WHERE event_id = ? AND id = ? AND status = 'pending'", [eventId, id])
}

/** Its preview goes to a new key (an upload carried on with a preview where it had none). */
async function setPreviewKey(eventId, id, previewKey, db = pool) {
  await db.execute("UPDATE event_media SET preview_key = ? WHERE event_id = ? AND id = ? AND status = 'pending'", [previewKey, eventId, id])
}

/**
 * An unfinished upload in parts of this very file, by this person, into the same place (the tab was
 * closed or the computer restarted): sending the file again carries on with it instead of starting over.
 */
async function findResumable(eventId, { userId, categoryId, originalName, size, fileModifiedAt }, db = pool) {
  const [rows] = await db.execute(
    `SELECT ${COLUMNS} FROM ${FROM}
      WHERE m.event_id = ? AND m.status = 'pending' AND m.upload_id IS NOT NULL AND m.uploaded_by = ?
        AND m.category_id <=> ? AND m.original_name = ? AND m.size_bytes = ? AND m.file_modified_at <=> ?
        AND m.updated_at > CURRENT_TIMESTAMP(3) - INTERVAL 7 DAY
      ORDER BY m.updated_at DESC LIMIT 1`,
    [eventId, userId, categoryId, originalName, size, fileModifiedAt],
  )
  return rows[0] ?? null
}

/** R2 has the whole file: record what it said and what the browser read from it. */
async function markReady(eventId, id, { etag, width, height, durationMs, previewKey }, db = pool) {
  await db.execute(
    `UPDATE event_media SET status = 'ready', uploaded_at = CURRENT_TIMESTAMP(3), etag = ?, width = ?, height = ?,
       duration_ms = ?, preview_key = ?, upload_id = NULL
     WHERE event_id = ? AND id = ? AND status = 'pending'`,
    [etag ?? null, width ?? null, height ?? null, durationMs ?? null, previewKey ?? null, eventId, id],
  )
}

/**
 * One page of an event's ready files, by name: `limit` rows after `cursor`.
 * category: "all", "none" (Uncategorised) or a category id; kind: "all", photo, video, audio, graphic or model.
 */
async function page({ eventId, category, kind, cursor, limit }) {
  const where = ["m.event_id = ?", "m.status = 'ready'"]
  const params = [eventId]
  if (category === "none") where.push("m.category_id IS NULL")
  else if (category !== "all") {
    where.push("m.category_id = ?")
    params.push(category)
  }
  if (kind !== "all") {
    where.push("m.kind = ?")
    params.push(kind)
  }
  if (cursor) {
    where.push("(m.file_name > ? OR (m.file_name = ? AND m.id > ?))")
    params.push(cursor.name, cursor.name, cursor.id)
  }
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(" AND ")} ORDER BY m.file_name, m.id LIMIT ?`,
    [...params, Number(limit)],
  )
  return rows
}

/** Per category of one event: { categoryId | "none" → { count, bytes } }, plus kinds for the whole event. */
async function countsOf(eventId) {
  const [rows] = await pool.execute(
    `SELECT category_id, kind, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes, MAX(uploaded_at) AS last
       FROM event_media WHERE event_id = ? AND status = 'ready' GROUP BY category_id, kind`,
    [eventId],
  )
  return rows
}

/** For the Uploads page: per event, how many files, how big, and when the last one arrived. */
async function statsByEvent(eventIds) {
  if (!eventIds.length) return new Map()
  const [rows] = await pool.query(
    `SELECT event_id, COUNT(*) AS n, SUM(kind = 'photo') AS photos, SUM(kind = 'video') AS videos,
            SUM(kind = 'audio') AS audio, SUM(kind = 'graphic') AS graphics, SUM(kind = 'model') AS models,
            COALESCE(SUM(size_bytes), 0) AS bytes, MAX(uploaded_at) AS last
       FROM event_media WHERE event_id IN (?) AND status = 'ready' GROUP BY event_id`,
    [eventIds],
  )
  return new Map(rows.map((r) => [r.event_id, r]))
}

/** The newest `per` files with a preview, per event: the covers of the folders on the Uploads page. */
async function coversOf(eventIds, per = 4) {
  if (!eventIds.length) return new Map()
  const [rows] = await pool.query(
    `SELECT id, event_id, kind, preview_key FROM (
        SELECT id, event_id, kind, preview_key,
               ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY uploaded_at DESC, id DESC) AS n
          FROM event_media WHERE event_id IN (?) AND status = 'ready' AND preview_key IS NOT NULL
      ) ranked WHERE n <= ? ORDER BY event_id, n`,
    [eventIds, per],
  )
  const out = new Map()
  for (const r of rows) {
    if (!out.has(r.event_id)) out.set(r.event_id, [])
    out.get(r.event_id).push(r)
  }
  return out
}

/** Moves ready files of this event to a category of this event (null: Uncategorised). */
async function move(eventId, ids, categoryId, db = pool) {
  const [res] = await db.query(
    "UPDATE event_media SET category_id = ? WHERE event_id = ? AND id IN (?) AND status = 'ready'",
    [categoryId, eventId, ids],
  )
  return res.affectedRows
}

/** Every file of an event, finished or not, with where it is on R2 (to delete the whole event). */
async function allOf(eventId, db = pool) {
  const [rows] = await db.execute(
    "SELECT id, object_key, preview_key, upload_id, size_bytes, status FROM event_media WHERE event_id = ?",
    [eventId],
  )
  return rows
}

async function remove(eventId, ids, db = pool) {
  if (!ids.length) return 0
  const [res] = await db.query("DELETE FROM event_media WHERE event_id = ? AND id IN (?)", [eventId, ids])
  return res.affectedRows
}

/**
 * Uploads that never finished (the tab closed, the connection died): one sent whole that began more than
 * `hours` ago, or one in parts nobody has carried on with for `days` (R2 drops its parts after 7 days).
 */
async function stalePending(eventId, { hours = 24, days = 7 } = {}) {
  const [rows] = await pool.execute(
    `SELECT id, object_key, preview_key, upload_id FROM event_media
      WHERE event_id = ? AND status = 'pending'
        AND ((upload_id IS NULL AND created_at < CURRENT_TIMESTAMP(3) - INTERVAL ? HOUR)
          OR (upload_id IS NOT NULL AND updated_at < CURRENT_TIMESTAMP(3) - INTERVAL ? DAY))
      LIMIT 500`,
    [eventId, hours, days],
  )
  return rows
}

/** Files in a category leave it (before the category is deleted): they become Uncategorised. */
async function uncategorise(eventId, categoryId, db = pool) {
  await db.execute("UPDATE event_media SET category_id = NULL WHERE event_id = ? AND category_id = ?", [eventId, categoryId])
}

module.exports = {
  allOf,
  findEvent,
  categoriesOf,
  namesLike,
  insertPending,
  findInEvent,
  findOne,
  setUpload,
  touch,
  setPreviewKey,
  findResumable,
  markReady,
  page,
  countsOf,
  statsByEvent,
  coversOf,
  move,
  remove,
  stalePending,
  uncategorise,
}
