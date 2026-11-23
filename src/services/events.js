/**
 * Events: made from the panel's Uploads page (New event). An event is one folder on R2,
 * events/<slug>/, with a folder per category inside it; its photographs and videos go in after
 * (services/media.js).
 *
 * Making one, in one transaction:
 * - the name must be new (case-insensitive): it is the gallery's title;
 * - the slug (folder) is made from the name, with -2, -3… when taken, and never changes;
 * - a booking can have only one event, and not a cancelled one; the booking's client account
 *   becomes the event's client unless another is chosen;
 * - the client must be a client account that isn't turned off;
 * - with `withCode`, a guest gallery code (365 days) is made for the event, and the client
 *   becomes a member of it, so the gallery opens on their dashboard.
 *
 * Renaming the event or a category changes only the name shown: the folders on R2 keep theirs, so
 * no file moves. Deleting a category leaves its files in the event, as Uncategorised.
 *
 * Deleting the whole event (event.delete: editors, photographers, the studio lead) needs its name
 * typed again. Its folder on R2 is emptied first (every file, preview and unfinished upload); only
 * when R2 has let go of everything is the event deleted, with its categories and gallery codes.
 * Should R2 keep some files, the event stays (without the files that did go), so it can be tried again.
 */
const crypto = require("node:crypto")
const { withTransaction } = require("../config/dbconfig")
const { r2, signedViewUrl, abortMultipart, removeFolder } = require("../config/r2config")
const events = require("../models/event")
const media = require("../models/media")
const galleryCodes = require("./gallerycode")
const accessCodes = require("./accesscode")
const { slugify, STARTER_CATEGORIES, MAX_EVENT_CATEGORIES } = require("../validators/events")
const { HttpError } = require("../utils/http-error")
const { audit } = require("../utils/audit")
const { CLIENT_ROLE } = require("../utils/roles")

const CODE_DAYS = 365
const CODE_LABEL = "Guests"

/** A 400/409 that the form shows under one field. */
const fieldError = (status, field, message, code = "VALIDATION") =>
  new HttpError(status, message, { code, details: { field, errors: { [field]: message } } })

const eventNotFound = () => new HttpError(404, "That event doesn't exist.", { code: "NOT_FOUND" })
const categoryNotFound = () => new HttpError(404, "That category isn't part of this event.", { code: "NOT_FOUND" })

const EMPTY_STATS = { files: 0, photos: 0, videos: 0, audio: 0, graphics: 0, models: 0, bytes: 0, lastUploadAt: null }
/** event_media.kind → the stats field that counts it */
const COUNTED = { photo: "photos", video: "videos", audio: "audio", graphic: "graphics", model: "models" }

/** What the panel sees. `stats` and `covers`: what's in it (the Uploads page's folders). */
function toPublic(row, categories = [], { stats = EMPTY_STATS, covers, uncategorised, code } = {}) {
  const folder = `events/${row.slug}/`
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    folder,
    kind: row.kind,
    date: row.event_date, // "2026-06-14" (DATE is read as a string)
    venue: row.venue ?? "",
    bookingId: row.booking_id,
    client: row.client_id ? { id: row.client_id, name: row.client_name } : null,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      folder: `${folder}${c.slug}/`,
      ...(c.files !== undefined && { files: c.files, bytes: c.bytes }),
    })),
    ...(uncategorised && { uncategorised }),
    stats,
    ...(covers && { covers }),
    // its gallery code ({ id, code, state, expiresAt… } or null); left out for roles that can't see codes
    ...(code !== undefined && { code }),
    createdBy: row.created_by ? { id: row.created_by, name: row.created_by_name } : null,
    createdAt: row.created_at,
  }
}

/** The first free folder name: base, base-2, base-3… */
async function freeSlug(name, conn) {
  const base = slugify(name, 60)
  const taken = await events.slugsLike(base, conn)
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

async function create(req, { name, date, kind, venue, bookingId, clientId, categories, withCode }) {
  const starting = categories?.length ? categories : STARTER_CATEGORIES[kind].map((n) => ({ name: n, slug: slugify(n, 40) }))

  const made = await withTransaction(async (conn) => {
    if (bookingId) {
      const booking = await events.lockBooking(bookingId, conn)
      if (!booking) throw fieldError(400, "bookingId", "That booking doesn't exist.")
      if (booking.status === "cancelled") throw fieldError(400, "bookingId", "That booking was cancelled. Choose another, or none.")
      clientId ??= booking.user_id ?? undefined
    }
    if (clientId) {
      const account = await events.findAccount(clientId, conn)
      if (!account || account.role_slug !== CLIENT_ROLE) throw fieldError(400, "clientId", "Choose a client account.")
      if (account.status === "disabled") throw fieldError(400, "clientId", "That client's account is turned off.")
    }

    const eventId = crypto.randomUUID()
    for (let attempt = 0; ; attempt++) {
      const slug = await freeSlug(name, conn)
      try {
        await events.create({ id: eventId, name, slug, kind, date, venue, bookingId, clientId, createdBy: req.user.id }, conn)
        break
      } catch (err) {
        if (err.code !== "ER_DUP_ENTRY") throw err
        if (err.message.includes("uq_events_name")) {
          throw fieldError(409, "name", "There is already an event with this name. Add the year or the venue.", "EVENT_NAME_TAKEN")
        }
        if (err.message.includes("uq_events_booking")) {
          throw fieldError(409, "bookingId", "That booking already has an event.", "BOOKING_HAS_EVENT")
        }
        if (attempt >= 2) throw err // the folder name was taken in between, three times over
      }
    }
    await events.addCategories(
      eventId,
      starting.map((c, position) => ({ id: crypto.randomUUID(), name: c.name, slug: c.slug, position })),
      conn,
    )

    let guestCode = null
    if (withCode) {
      guestCode = await accessCodes.create(req, { eventId, label: CODE_LABEL, days: CODE_DAYS }, conn)
      if (clientId) await galleryCodes.addMember(guestCode.id, clientId, "staff", conn)
    }
    return { eventId, guestCode }
  })

  const { eventId, guestCode } = made
  audit(req, "event_create", { userId: req.user.id, detail: { eventId, name, bookingId: bookingId ?? null, clientId: clientId ?? null } })
  if (guestCode) audit(req, "code_create", { userId: req.user.id, detail: { codeId: guestCode.id, eventName: name, eventId, maxUsers: null } })
  return { event: await get(eventId), code: guestCode }
}

const statsOf = (row) =>
  row
    ? {
        files: Number(row.n),
        photos: Number(row.photos),
        videos: Number(row.videos),
        audio: Number(row.audio ?? 0),
        graphics: Number(row.graphics ?? 0),
        models: Number(row.models ?? 0),
        bytes: Number(row.bytes),
        lastUploadAt: row.last,
      }
    : EMPTY_STATS

/** One event, with how many files each category holds. `withCode`: add its gallery code (access_code.view). */
async function get(eventId, { withCode = false } = {}) {
  const row = await events.findById(eventId)
  if (!row) throw eventNotFound()
  const cats = (await events.categoriesOf([eventId])).get(eventId)
  const code = withCode ? ((await accessCodes.byEvents([eventId])).get(eventId) ?? null) : undefined

  const byCategory = new Map()
  const totals = { n: 0, photos: 0, videos: 0, audio: 0, graphics: 0, models: 0, bytes: 0, last: null }
  for (const c of await media.countsOf(eventId)) {
    const at = c.category_id ?? "none"
    const entry = byCategory.get(at) ?? { files: 0, bytes: 0 }
    entry.files += Number(c.n)
    entry.bytes += Number(c.bytes)
    byCategory.set(at, entry)
    totals.n += Number(c.n)
    totals[COUNTED[c.kind] ?? "photos"] += Number(c.n)
    totals.bytes += Number(c.bytes)
    if (c.last && (!totals.last || c.last > totals.last)) totals.last = c.last
  }
  const counted = cats.map((c) => ({ ...c, ...(byCategory.get(c.id) ?? { files: 0, bytes: 0 }) }))
  return toPublic(row, counted, {
    stats: statsOf(totals.n ? totals : null),
    uncategorised: byCategory.get("none") ?? { files: 0, bytes: 0 },
    ...(withCode && { code }),
  })
}

/**
 * Every event, newest first, with what's in it and up to four previews of its newest files.
 * `withCodes`: each with its gallery code (or null), for roles that may see codes (access_code.view).
 */
async function list({ withCodes = false } = {}) {
  const rows = await events.list()
  const eventIds = rows.map((r) => r.id)
  const [cats, stats, covers, codes] = await Promise.all([
    events.categoriesOf(eventIds),
    media.statsByEvent(eventIds),
    r2 ? media.coversOf(eventIds) : new Map(),
    withCodes ? accessCodes.byEvents(eventIds) : null,
  ])
  return Promise.all(
    rows.map(async (row) =>
      toPublic(row, cats.get(row.id), {
        stats: statsOf(stats.get(row.id)),
        covers: await Promise.all(
          (covers.get(row.id) ?? []).map(async (c) => ({ id: c.id, kind: c.kind, previewUrl: await signedViewUrl(c.preview_key) })),
        ),
        ...(codes && { code: codes.get(row.id) ?? null }),
      }),
    ),
  )
}

async function rename(req, eventId, name) {
  const row = await events.findById(eventId)
  if (!row) throw eventNotFound()
  if (row.name === name) return get(eventId)
  try {
    await events.rename(eventId, name)
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY" && err.message.includes("uq_events_name")) {
      throw fieldError(409, "name", "There is already an event with this name.", "EVENT_NAME_TAKEN")
    }
    throw err
  }
  audit(req, "event_rename", { userId: req.user.id, detail: { eventId, from: row.name, to: name } })
  return get(eventId)
}

/* ---------- Categories ---------- */

/**
 * A new category (a folder inside the event, an album in the gallery). A name whose folder already
 * exists answers with that category instead (created: false), so an upload can always ask for it.
 */
async function addCategory(req, eventId, name) {
  const slug = slugify(name, 40)
  const out = await withTransaction(async (conn) => {
    const event = await events.findById(eventId, conn)
    if (!event) throw eventNotFound()
    const existing = (await events.categoriesOf([eventId], conn)).get(eventId).find((c) => c.slug === slug)
    if (existing) return { category: existing, created: false }
    const { count, next } = await events.categorySlots(eventId, conn)
    if (count >= MAX_EVENT_CATEGORIES) throw fieldError(400, "name", `An event can have at most ${MAX_EVENT_CATEGORIES} categories.`)
    const category = { id: crypto.randomUUID(), name, slug, position: next }
    try {
      await events.addCategories(eventId, [category], conn)
    } catch (err) {
      if (err.code !== "ER_DUP_ENTRY") throw err
      // made by someone else a moment ago
      return { category: (await events.categoriesOf([eventId], conn)).get(eventId).find((c) => c.slug === slug), created: false }
    }
    return { category, created: true }
  })
  if (out.created) audit(req, "category_create", { userId: req.user.id, detail: { eventId, name } })
  const event = await get(eventId)
  return { category: event.categories.find((c) => c.id === out.category.id), created: out.created, event }
}

async function renameCategory(req, eventId, categoryId, name) {
  const category = await events.findCategory(eventId, categoryId)
  if (!category) throw categoryNotFound()
  const cats = (await events.categoriesOf([eventId])).get(eventId)
  if (cats.some((c) => c.id !== categoryId && c.name.toLowerCase() === name.toLowerCase())) {
    throw fieldError(409, "name", "Another category already has this name.", "CATEGORY_NAME_TAKEN")
  }
  await events.renameCategory(eventId, categoryId, name)
  audit(req, "category_rename", { userId: req.user.id, detail: { eventId, categoryId, from: category.name, to: name } })
  return get(eventId)
}

/** Deletes the category; its files stay in the event, as Uncategorised (they don't move on R2). */
async function removeCategory(req, eventId, categoryId) {
  await withTransaction(async (conn) => {
    const category = await events.findCategory(eventId, categoryId, conn)
    if (!category) throw categoryNotFound()
    await media.uncategorise(eventId, categoryId, conn)
    await events.removeCategory(eventId, categoryId, conn)
  })
  audit(req, "category_remove", { userId: req.user.id, detail: { eventId, categoryId } })
  return get(eventId)
}

/* ---------- Deleting the event ---------- */

/**
 * Deletes the event, every file in it (on R2 too), its categories and its gallery codes.
 * `confirmName`: the event's name, typed again exactly. → { name, files, bytes }
 */
async function remove(req, eventId, confirmName) {
  const row = await events.findById(eventId)
  if (!row) throw eventNotFound()
  if (String(confirmName ?? "").trim() !== row.name) {
    throw fieldError(400, "confirmName", "That isn't the event's name. Type it exactly as it is shown.", "NAME_MISMATCH")
  }

  const files = await media.allOf(eventId)
  const bytes = files.reduce((sum, f) => sum + Number(f.size_bytes ?? 0), 0)
  const folder = `events/${row.slug}/`

  if (!r2) {
    if (files.length) {
      throw new HttpError(503, "Photo storage (R2) isn't set up, so the event's files can't be deleted. Add the R2 keys to backend/.env.", {
        code: "STORAGE_OFF",
      })
    }
  } else {
    await Promise.all(files.filter((f) => f.upload_id).map((f) => abortMultipart(f.object_key, f.upload_id).catch(() => {})))
    const { failed } = await removeFolder(folder)
    if (failed.length) {
      // the files R2 did delete leave the event; the rest stay, so it can be tried again
      const kept = new Set(failed)
      const gone = files.filter((f) => !kept.has(f.object_key)).map((f) => f.id)
      if (gone.length) await media.remove(eventId, gone)
      audit(req, "event_delete_fail", { userId: req.user.id, detail: { eventId, name: row.name, left: failed.length } })
      throw new HttpError(502, `R2 couldn't delete ${failed.length} of the event's files, so the event is kept. Try again.`, {
        code: "STORAGE_ERROR",
        details: { left: failed.length },
      })
    }
  }

  await withTransaction((conn) => events.remove(eventId, conn))
  // anything that reached the folder while it was being emptied (an upload already under way)
  if (r2) await removeFolder(folder).catch((err) => console.error(`Couldn't sweep ${folder} after deleting the event:`, err.message))

  audit(req, "event_delete", { userId: req.user.id, detail: { eventId, name: row.name, files: files.length, bytes } })
  return { name: row.name, files: files.length, bytes }
}

module.exports = { create, get, list, rename, remove, addCategory, renameCategory, removeCategory }
