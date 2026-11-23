/**
 * The files of an event: photographs, videos, audio, graphics and 3D models. Files go from the
 * browser straight to R2; this service hands out the links and keeps the record (event_media):
 *
 *   1. start     the browser names the files: each gets a row ('pending'), a key inside the event's
 *                own folder, and a link that only accepts that file (its exact size and type), plus
 *                one for its preview. Only the formats of utils/filecheck.js are let through;
 *   2. (browser) checks each file's bytes, then PUTs the file and its preview to R2, with progress.
 *                A file over 64 MB goes up in parts instead (16 MB or more each, up to 10,000 of them):
 *                parts        the browser asks for links to a few parts at a time and sends four at
 *                             once; a part that fails is sent again by itself, the parts R2 has stay;
 *                parts (GET)  which parts R2 already has, so an upload that stopped (a dropped
 *                             connection, a closed tab) carries on with only the parts still missing.
 *                             Sending the same file again (same name, size, date, category, person)
 *                             finds its unfinished upload instead of starting a new one;
 *   3. complete  (in parts: every part must be on R2 at its right size, or 409 UPLOAD_INCOMPLETE names
 *                the missing ones; then R2 joins them into one file.) R2's copy is read back (its first 64 KB, all of an SVG): the size must match, and the
 *                bytes must really be the format its name says, with nothing in it that could run
 *                (utils/filecheck.js). A file that fails is deleted from R2 and refused (422
 *                FILE_BLOCKED, logged as upload_blocked); only a file that passes is 'ready' and shown;
 *      abort     a stopped upload: its row and anything already sent are removed.
 *
 * Every file is reached through its event (WHERE event_id = ?): a file id from another event is
 * "not found", and the links to view a file are only made by the routes of its own event.
 * Uploads left 'pending' for a day (a closed tab) are swept the next time someone uploads to the event;
 * one in parts is kept for 7 days after its last part, so it can still be carried on.
 */
const crypto = require("node:crypto")
const media = require("../models/media")
const {
  r2,
  signedUploadUrl,
  signedViewUrl,
  readObjectStart,
  headObject,
  removeObjects,
  startMultipart,
  signedPartUrl,
  listParts,
  finishMultipart,
  abortMultipart,
} = require("../config/r2config")
const { slugify } = require("../validators/events")
const { MAX_PREVIEW_BYTES, encodeCursor } = require("../validators/media")
const { formatOf, bytesToCheck, inspect, SHOWN_IN_BROWSER } = require("../utils/filecheck")
const { HttpError } = require("../utils/http-error")
const { audit } = require("../utils/audit")

/** How long an upload link works: enough to start a long batch's file after the queue reaches it. */
const UPLOAD_LINK_MS = 60 * 60_000
const UNCATEGORISED = "uncategorised"

/* ---------- Large files: in parts ---------- */

const MB = 1024 * 1024
/** A file larger than this goes up in parts; a smaller one in one PUT. */
const PARTS_FROM = 64 * MB
/** Each part is at least this big; a larger file gets larger parts, to stay within R2's 10,000. */
const MIN_PART = 16 * MB
const MAX_PARTS = 10_000
/** A part's link is asked for shortly before it goes, so an hour is plenty. */
const PART_LINK_MS = 60 * 60_000

const partSizeFor = (size) => Math.max(MIN_PART, Math.ceil(size / MAX_PARTS / MB) * MB)

/** How a file in parts is cut: { partSize, partCount }, and part n's size (the last is the rest). */
function plan(row) {
  const size = Number(row.size_bytes)
  const partSize = Number(row.part_size)
  const partCount = Math.ceil(size / partSize)
  return { partSize, partCount, bytesOf: (n) => (n < partCount ? partSize : size - partSize * (partCount - 1)) }
}

const every = (count) => Array.from({ length: count }, (_, i) => i + 1)

const fieldError = (status, field, message, code = "VALIDATION") =>
  new HttpError(status, message, { code, details: { field, errors: { [field]: message } } })

const notFound = () => new HttpError(404, "That file isn't in this event.", { code: "NOT_FOUND" })

function requireStorage() {
  if (!r2) throw new HttpError(503, "Photo storage (R2) isn't set up yet. Add the R2 keys to backend/.env.", { code: "STORAGE_OFF" })
}

async function requireEvent(eventId) {
  const event = await media.findEvent(eventId)
  if (!event) throw new HttpError(404, "That event doesn't exist.", { code: "NOT_FOUND" })
  return event
}

/** What the panel sees, with links (valid for a while) to the preview and the file itself. */
async function toPublic(row, { download = false } = {}) {
  const out = {
    id: row.id,
    eventId: row.event_id,
    categoryId: row.category_id,
    kind: row.kind,
    name: row.file_name,
    originalName: row.original_name,
    contentType: row.content_type,
    size: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    fileModifiedAt: row.file_modified_at,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by ? { id: row.uploaded_by, name: row.uploaded_by_name } : null,
    previewUrl: row.preview_key ? await signedViewUrl(row.preview_key) : null,
    // a format no browser shows (RAW, PSD, a 3D model) is only ever downloaded, never opened from R2
    url: await signedViewUrl(row.object_key, SHOWN_IN_BROWSER.test(row.content_type) ? {} : { downloadAs: row.original_name }),
  }
  if (download) out.downloadUrl = await signedViewUrl(row.object_key, { downloadAs: row.original_name })
  return out
}

/** "IMG 0412 (1).JPG" → "img-0412-1" (the extension is added back from the checked type). */
const baseName = (name) => slugify(name.replace(/\.[^.]*$/, ""), 120)

function freeName(base, ext, taken) {
  let name = `${base}.${ext}`
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}.${ext}`
  taken.add(name)
  return name
}

/** Removes uploads that never finished (best effort: a failure here never stops a new upload). */
async function sweep(eventId) {
  const stale = await media.stalePending(eventId)
  if (!stale.length) return
  // (R2 also drops the parts of an upload left for 7 days by itself)
  await Promise.all(stale.filter((r) => r.upload_id).map((r) => abortMultipart(r.object_key, r.upload_id).catch(() => {})))
  const failed = new Set(await removeObjects(stale.flatMap((r) => [r.object_key, r.preview_key])))
  const gone = stale.filter((r) => !failed.has(r.object_key) && !failed.has(r.preview_key)).map((r) => r.id)
  await media.remove(eventId, gone)
}

/* ---------- Uploading ---------- */

async function start(req, eventId, files) {
  requireStorage()
  const event = await requireEvent(eventId)
  sweep(eventId).catch((err) => console.error(`Couldn't sweep unfinished uploads of event ${eventId}:`, err.message))

  const categories = await media.categoriesOf(eventId)
  files.forEach((file, i) => {
    if (file.categoryId && !categories.has(file.categoryId)) {
      throw fieldError(400, `files.${i}.categoryId`, "That category isn't part of this event.")
    }
  })

  // a large file sent again (the tab was closed, the computer restarted) carries on where it stopped
  const resumed = new Map() // index in `files` -> its unfinished row
  for (const [i, file] of files.entries()) {
    if (file.size <= PARTS_FROM) continue
    const row = await media.findResumable(eventId, {
      userId: req.user.id,
      categoryId: file.categoryId,
      originalName: file.name,
      size: file.size,
      fileModifiedAt: file.lastModified,
    })
    if (row && ![...resumed.values()].some((r) => r.id === row.id)) resumed.set(i, row)
  }
  const fresh = files.filter((_, i) => !resumed.has(i))

  // Names are picked from what's already in each folder; two uploads racing for the same name
  // meet the unique key, and the batch picks again.
  let rows
  for (let attempt = 0; ; attempt++) {
    const taken = new Map()
    rows = []
    for (const file of fresh) {
      const category = file.categoryId ? categories.get(file.categoryId) : null
      const folder = `events/${event.slug}/${category ? category.slug : UNCATEGORISED}/`
      const base = baseName(file.name)
      const at = folder + base
      if (!taken.has(at)) taken.set(at, await media.namesLike(eventId, folder, base))
      const fileName = freeName(base, file.ext, taken.get(at))
      const id = crypto.randomUUID()
      rows.push({
        id,
        eventId,
        categoryId: category?.id ?? null,
        kind: file.kind,
        key: folder + fileName,
        previewKey: file.previewSize ? `events/${event.slug}/_previews/${id}.jpg` : null,
        previewSize: file.previewSize,
        fileName,
        originalName: file.name,
        contentType: file.contentType,
        size: file.size,
        fileModifiedAt: file.lastModified,
        uploadedBy: req.user.id,
        partSize: file.size > PARTS_FROM ? partSizeFor(file.size) : null,
      })
    }
    try {
      await media.insertPending(rows)
      break
    } catch (err) {
      if (err.code !== "ER_DUP_ENTRY" || attempt >= 2) throw err
    }
  }

  // each large file gets its upload in parts on R2 (one request each)
  try {
    await Promise.all(
      rows
        .filter((m) => m.partSize)
        .map(async (m) => {
          m.uploadId = await startMultipart(m.key, { contentType: m.contentType })
          await media.setUpload(eventId, m.id, { uploadId: m.uploadId, partSize: m.partSize })
        }),
    )
  } catch (err) {
    await Promise.all(rows.filter((m) => m.uploadId).map((m) => abortMultipart(m.key, m.uploadId).catch(() => {})))
    await media.remove(
      eventId,
      rows.map((m) => m.id),
    )
    console.error(`Couldn't open uploads in parts on R2 for event ${eventId}:`, err.message)
    throw new HttpError(502, "R2 couldn't get ready for the large files. Try again.", { code: "STORAGE_ERROR" })
  }

  const previewLink = (key, size) => signedUploadUrl(key, { contentType: "image/jpeg", size, expiresIn: UPLOAD_LINK_MS })
  let next = 0
  return Promise.all(
    files.map(async (file, i) => {
      const row = resumed.get(i)
      if (row) {
        // the same record and parts as before; the preview is sent again (it is small)
        let previewKey = row.preview_key
        if (!previewKey && file.previewSize) {
          previewKey = `events/${event.slug}/_previews/${row.id}.jpg`
          await media.setPreviewKey(eventId, row.id, previewKey)
        }
        const { partSize, partCount } = plan(row)
        return {
          id: row.id,
          name: row.file_name,
          originalName: row.original_name,
          kind: row.kind,
          key: row.object_key,
          contentType: row.content_type,
          size: Number(row.size_bytes),
          url: null,
          parts: { size: partSize, count: partCount },
          resumed: true,
          previewUrl: previewKey && file.previewSize ? await previewLink(previewKey, file.previewSize) : null,
        }
      }
      const m = rows[next++]
      return {
        id: m.id,
        name: m.fileName,
        originalName: m.originalName,
        kind: m.kind,
        key: m.key,
        contentType: m.contentType,
        size: m.size,
        // a large file has no link of its own: its parts get theirs (signParts)
        url: m.partSize ? null : await signedUploadUrl(m.key, { contentType: m.contentType, size: m.size, expiresIn: UPLOAD_LINK_MS }),
        parts: m.partSize ? { size: m.partSize, count: Math.ceil(m.size / m.partSize) } : null,
        resumed: false,
        previewUrl: m.previewKey ? await previewLink(m.previewKey, m.previewSize) : null,
      }
    }),
  )
}

/** An upload of this event that goes in parts, or 404 / 409. */
async function inParts(eventId, mediaId) {
  const row = await media.findOne(eventId, mediaId)
  if (!row) throw notFound()
  if (!row.part_size) throw new HttpError(409, "This file goes up in one piece, not in parts.", { code: "NOT_IN_PARTS" })
  return row
}

/** Links for some parts of a large file: [{ number, size, url }]. Each accepts exactly its part's bytes. */
async function signParts(req, eventId, mediaId, numbers) {
  requireStorage()
  const row = await inParts(eventId, mediaId)
  if (row.status !== "pending" || !row.upload_id) {
    throw new HttpError(409, "This file is already on R2.", { code: "ALREADY_UPLOADED" })
  }
  const { partCount, bytesOf } = plan(row)
  if (numbers.some((n) => n > partCount)) throw fieldError(400, "parts", `This file has ${partCount} parts.`)
  await media.touch(eventId, mediaId) // still going: not swept as abandoned
  return Promise.all(
    numbers.map(async (n) => ({
      number: n,
      size: bytesOf(n),
      url: await signedPartUrl(row.object_key, { uploadId: row.upload_id, partNumber: n, size: bytesOf(n), expiresIn: PART_LINK_MS }),
    })),
  )
}

/**
 * Which parts R2 already has (at their right size): { partSize, partCount, done: [numbers] }, so an
 * upload that stopped sends only the rest. An upload R2 dropped (left 7 days) starts again, empty.
 */
async function partsStatus(req, eventId, mediaId) {
  requireStorage()
  const row = await inParts(eventId, mediaId)
  const { partSize, partCount, bytesOf } = plan(row)
  // joined already (a retry after R2 finished it): nothing left to send, only /complete
  if (row.status === "ready" || !row.upload_id) return { partSize, partCount, done: every(partCount) }
  const parts = await listParts(row.object_key, row.upload_id)
  if (parts) return { partSize, partCount, done: parts.filter((p) => p.size === bytesOf(p.number)).map((p) => p.number) }

  const whole = await headObject(row.object_key)
  if (whole && whole.size === Number(row.size_bytes)) return { partSize, partCount, done: every(partCount) }
  const uploadId = await startMultipart(row.object_key, { contentType: row.content_type })
  await media.setUpload(eventId, mediaId, { uploadId, partSize })
  return { partSize, partCount, done: [], restarted: true }
}

/**
 * Every part on R2 at its right size: R2 joins them into the one file. Otherwise 409 UPLOAD_INCOMPLETE
 * with the `missing` part numbers, for the browser to send only those.
 */
async function joinParts(row) {
  const { partCount, bytesOf } = plan(row)
  const parts = await listParts(row.object_key, row.upload_id)
  if (!parts) {
    // R2 joined them already (this is a retry) when the whole file is there
    const whole = await headObject(row.object_key)
    if (whole && whole.size === Number(row.size_bytes)) return media.setUpload(row.event_id, row.id, { uploadId: null, partSize: row.part_size })
    throw new HttpError(409, "R2 no longer has the parts of this file (an upload left for 7 days is dropped). Send it again.", {
      code: "UPLOAD_MISSING",
    })
  }
  const have = new Map(parts.map((p) => [p.number, p]))
  const missing = every(partCount).filter((n) => have.get(n)?.size !== bytesOf(n))
  if (missing.length) {
    throw new HttpError(409, `${missing.length} of the ${partCount} parts haven't reached R2. Send them again.`, {
      code: "UPLOAD_INCOMPLETE",
      details: { missing },
    })
  }
  await finishMultipart(
    row.object_key,
    row.upload_id,
    every(partCount).map((n) => have.get(n)),
  )
  await media.setUpload(row.event_id, row.id, { uploadId: null, partSize: row.part_size })
}

async function complete(req, eventId, mediaId, { width, height, durationMs }) {
  requireStorage()
  const row = await media.findOne(eventId, mediaId)
  if (!row) throw notFound()
  if (row.status === "ready") return toPublic(row) // asked twice (a retry): the same answer
  if (row.upload_id) await joinParts(row)

  // the first bytes R2 received (all of an SVG): its size, and what the file really is
  const { ext } = formatOf(row.file_name) ?? { ext: "" }
  const head = await readObjectStart(row.object_key, bytesToCheck(ext, Number(row.size_bytes)))
  if (!head) throw new HttpError(409, "R2 doesn't have this file. Send it again.", { code: "UPLOAD_MISSING" })
  if (head.size !== Number(row.size_bytes)) {
    if (row.part_size) await media.remove(eventId, [mediaId]) // its parts are joined: it can only go again whole
    await removeObjects([row.object_key]).catch(() => {})
    throw new HttpError(409, "Only part of the file reached R2. Send it again.", { code: "UPLOAD_INCOMPLETE" })
  }
  const problem = inspect(ext, head.head, head.size)
  if (problem) await block(req, row, problem)

  // the preview must be the small JPEG the browser made, nothing else
  let previewKey = null
  if (row.preview_key) {
    const preview = await readObjectStart(row.preview_key, 16)
    if (preview && preview.size <= MAX_PREVIEW_BYTES && inspect("jpg", preview.head, preview.size) === null) previewKey = row.preview_key
    else if (preview) await removeObjects([row.preview_key]).catch(() => {})
  }

  await media.markReady(eventId, mediaId, {
    etag: head.etag,
    width,
    height,
    durationMs: row.kind === "video" || row.kind === "audio" ? durationMs : null,
    previewKey,
  })
  return toPublic(await media.findOne(eventId, mediaId))
}

/**
 * A file that isn't what its name says (a program renamed to .jpg, an SVG with a script): it goes from
 * R2 and the event at once, the attempt is logged, and the upload is refused for good (422).
 */
async function block(req, row, reason) {
  await removeObjects([row.object_key, row.preview_key]).catch((err) => console.error(`Couldn't remove blocked file ${row.object_key}:`, err.message))
  await media.remove(row.event_id, [row.id])
  audit(req, "upload_blocked", {
    userId: req.user.id,
    detail: { eventId: row.event_id, name: row.original_name, size: Number(row.size_bytes), reason },
  })
  throw new HttpError(422, `${row.original_name} was blocked: ${reason}. Only real photos, videos, audio, graphics and 3D models can be uploaded.`, {
    code: "FILE_BLOCKED",
    details: { reason },
  })
}

/** A stopped or failed upload: the row goes, and whatever part of it reached R2. Ready files are kept. */
async function abort(req, eventId, mediaId) {
  const row = await media.findOne(eventId, mediaId)
  if (!row) throw notFound()
  if (row.status !== "pending") return { removed: false }
  if (r2) {
    if (row.upload_id) await abortMultipart(row.object_key, row.upload_id).catch(() => {})
    await removeObjects([row.object_key, row.preview_key]).catch(() => {})
  }
  await media.remove(eventId, [mediaId])
  return { removed: true }
}

/* ---------- Seeing them ---------- */

async function list(eventId, { category, kind, cursor, limit }) {
  requireStorage()
  await requireEvent(eventId)
  if (category !== "all" && category !== "none") {
    const categories = await media.categoriesOf(eventId)
    if (!categories.has(category)) throw fieldError(400, "category", "That category isn't part of this event.")
  }
  const rows = await media.page({ eventId, category, kind, cursor, limit: limit + 1 })
  const more = rows.length > limit
  const shown = more ? rows.slice(0, limit) : rows
  return {
    media: await Promise.all(shown.map((row) => toPublic(row))),
    nextCursor: more ? encodeCursor(shown[shown.length - 1]) : null,
    pageSize: limit,
  }
}

async function get(eventId, mediaId, { download }) {
  requireStorage()
  const row = await media.findOne(eventId, mediaId)
  if (!row || row.status !== "ready") throw notFound()
  return toPublic(row, { download })
}

/* ---------- Sorting and removing ---------- */

async function move(req, eventId, ids, categoryId) {
  await requireEvent(eventId)
  if (categoryId) {
    const categories = await media.categoriesOf(eventId)
    if (!categories.has(categoryId)) throw fieldError(400, "categoryId", "That category isn't part of this event.")
  }
  const moved = await media.move(eventId, ids, categoryId)
  audit(req, "media_move", { userId: req.user.id, detail: { eventId, count: moved, categoryId } })
  return { moved }
}

/** Deletes the files from R2 first; a row goes only once R2 has let go of its file. */
async function remove(req, eventId, ids) {
  requireStorage()
  await requireEvent(eventId)
  const rows = await media.findInEvent(eventId, ids)
  if (!rows.length) return { removed: 0, failed: 0 }
  const failed = new Set(await removeObjects(rows.flatMap((r) => [r.object_key, r.preview_key])))
  const gone = rows.filter((r) => !failed.has(r.object_key)).map((r) => r.id)
  const removed = await media.remove(eventId, gone)
  // a preview R2 kept is only a stray small file: the photograph itself is gone
  audit(req, "media_remove", { userId: req.user.id, detail: { eventId, count: removed, failed: rows.length - gone.length } })
  if (gone.length < rows.length) {
    throw new HttpError(502, `R2 couldn't delete ${rows.length - gone.length} of the files. Try again.`, {
      code: "STORAGE_ERROR",
      details: { removed },
    })
  }
  return { removed, failed: 0 }
}

module.exports = { start, signParts, partsStatus, complete, abort, list, get, move, remove, toPublic }
