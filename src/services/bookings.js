/**
 * Bookings: requests from the website's booking form, and the studio's work on them in the panel.
 *
 *   requested   sent from the website (Hire Us, the booking sheet)
 *   confirmed   the studio agreed it (a booking taken by phone or email starts here)
 *   dispatched  photographers sent (booking_crew): they are on site
 *   completed   shot; the panel then makes its event (folder) on Uploads
 *   cancelled   can be restored
 *
 * The panel reads the list a page at a time: PAGE_SIZE rows, newest first, with a cursor for the next
 * page (keyset on created_at and id, so a page never skips or repeats a row as requests arrive).
 */
const crypto = require("node:crypto")
const { pool } = require("../config/dbconfig")
const bookings = require("../models/booking")
const { encodeCursor, PAGE_SIZE } = require("../validators/bookings")
const { HttpError } = require("../utils/http-error")
const { audit } = require("../utils/audit")
const mail = require("../utils/mailer")
const env = require("../config/env")
const codes = require("../models/gallery-code")
const { readCode, codeState } = require("../utils/gallery-code")
const { photoUrl } = require("./profile-photo")

// what each status may move to (back steps undo a click: a cancel, a completion, a dispatch)
const NEXT = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["dispatched", "requested", "cancelled"],
  dispatched: ["completed", "confirmed", "cancelled"],
  completed: ["dispatched"],
  cancelled: ["requested", "confirmed"],
}

/** "BK-3F2A9C": the first six characters of the id, for people to quote. */
const refOf = (id) => `BK-${id.slice(0, 6).toUpperCase()}`
const REF = /^BK-?([0-9A-F]{6})$/i

const fieldError = (status, field, message, code = "VALIDATION") =>
  new HttpError(status, message, { code, details: { field, errors: { [field]: message } } })

/** One row of the panel's table. */
const toPublic = (row, team = []) => ({
  id: row.id,
  ref: refOf(row.id),
  name: row.client_name,
  email: row.email,
  phone: row.phone,
  type: row.event_type,
  date: row.event_day,
  time: row.start_hm,
  venue: row.venue,
  coverage: row.coverage,
  crewSize: row.crew,
  notes: row.notes,
  status: row.status,
  userId: row.user_id,
  handledBy: row.handled_by ? { id: row.handled_by, name: row.handled_by_name } : null,
  crew: team,
  event: row.event_id ? { id: row.event_id, name: row.event_name, hasCode: Boolean(Number(row.code_live)) } : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/** booking id → [{ id, name, photo }]: who was sent, each with their profile photo's link (or null). */
async function crewWithPhotos(bookingIds) {
  const teams = await bookings.crewOf(bookingIds)
  for (const [id, team] of teams) {
    teams.set(id, await Promise.all(team.map(async ({ photoKey, ...m }) => ({ ...m, photo: await photoUrl(photoKey) }))))
  }
  return teams
}

async function withCrew(row) {
  return toPublic(row, (await crewWithPhotos([row.id])).get(row.id) ?? [])
}

/**
 * POST / : a request from the website's form. Signed in, it is linked to the account. Answers
 * only what the visitor needs to see again, never the stored row.
 */
async function request(req, body) {
  const id = crypto.randomUUID()
  await bookings.create({ ...body, id, status: "requested", userId: req.user?.id, ip: req.ip })
  audit(req, "booking_request", { userId: req.user?.id, email: body.email, detail: { bookingId: id, type: body.type, date: body.date } })
  return { ref: refOf(id), type: body.type, date: body.date, venue: body.venue }
}

/** POST /manual : a booking the studio took by phone or email; it starts confirmed. */
async function manual(req, body) {
  const id = crypto.randomUUID()
  await bookings.create({ ...body, id, status: "confirmed", handledBy: req.user.id, ip: req.ip })
  audit(req, "booking_create", { userId: req.user.id, detail: { bookingId: id } })
  return withCrew(await bookings.findById(id))
}

/** GET / : one page. Asks for one row more than a page, only to know whether another follows. */
async function list({ status, q, cursor }) {
  const ref = q?.match(REF)
  const rows = await bookings.page({
    status,
    idPrefix: ref ? ref[1].toLowerCase() : undefined,
    text: ref ? undefined : q,
    cursor,
    limit: PAGE_SIZE + 1,
  })
  const more = rows.length > PAGE_SIZE
  const shown = more ? rows.slice(0, PAGE_SIZE) : rows
  const teams = await crewWithPhotos(shown.map((r) => r.id))
  return {
    bookings: shown.map((r) => toPublic(r, teams.get(r.id) ?? [])),
    pageSize: PAGE_SIZE,
    nextCursor: more ? encodeCursor(shown[shown.length - 1]) : null,
  }
}

/** GET /summary : the lanes and the tab counts. */
async function summary() {
  const s = await bookings.summary()
  const n = (v) => Number(v ?? 0)
  return {
    all: n(s.total) - n(s.cancelled),
    requested: n(s.requested),
    confirmed: n(s.confirmed),
    dispatched: n(s.dispatched),
    completed: n(s.completed),
    cancelled: n(s.cancelled),
    withinWeek: n(s.within_week),
    withoutFolder: n(s.without_folder),
    crewOut: n(s.crew_out),
  }
}

/** GET /crew?day= : who can be sent, where each one is now, and who is off today. */
async function crew({ day } = {}) {
  const members = await bookings.crewMembers({ day })
  return Promise.all(members.map(async (m) => ({
    id: m.id,
    name: m.full_name,
    photo: await photoUrl(m.photo_key),
    role: m.role_slug,
    mobile: m.mobile ?? null,
    off: Boolean(Number(m.off_today)),
    busy: m.busy_booking_id ? { bookingId: m.busy_booking_id, ref: refOf(m.busy_booking_id), name: m.busy_client, venue: m.busy_venue } : null,
  })))
}

/**
 * The client hears who is coming: names and phones, and that they will be on site on time.
 * Never fails the change itself: a mail outage comes back as { sent: false } for the panel to say so.
 */
async function emailCrew(booking, team) {
  const email = { to: booking.email, sent: false }
  try {
    await mail.sendCrewAssignedEmail({
      to: booking.email,
      name: booking.client_name,
      ref: refOf(booking.id),
      type: booking.event_type,
      day: booking.event_day,
      time: booking.start_hm,
      venue: booking.venue,
      crew: team.map((m) => ({ name: m.full_name, mobile: m.mobile })),
    })
    email.sent = true
  } catch (err) {
    console.error(`Booking ${refOf(booking.id)}: the crew email could not be sent:`, err.message)
  }
  return email
}

/** The client's gallery, when its event has a live access code: { link, code, expiresAt } | null. */
async function galleryOf(booking) {
  if (!booking.event_id) return null
  const row = await codes.findByEvent(booking.event_id)
  const code = row && codeState(row) === "active" ? readCode(row) : null
  if (!code) return null
  return { link: `${env.APP_URL}/dashboard?code=${encodeURIComponent(code)}`, code, expiresAt: row.expires_at }
}

/**
 * The event is done: a thank-you to the client, with the private gallery link, its code and QR code
 * when the gallery has a live code (otherwise it says they follow). Like emailCrew, never fails
 * the change. → { to, sent, gallery }
 */
async function emailCompleted(booking) {
  const email = { to: booking.email, sent: false, gallery: false }
  try {
    const gallery = await galleryOf(booking)
    email.gallery = Boolean(gallery)
    await mail.sendEventCompletedEmail({
      to: booking.email,
      name: booking.client_name,
      ref: refOf(booking.id),
      type: booking.event_type,
      day: booking.event_day,
      venue: booking.venue,
      gallery,
    })
    email.sent = true
  } catch (err) {
    console.error(`Booking ${refOf(booking.id)}: the thank-you email could not be sent:`, err.message)
  }
  return email
}

/**
 * PATCH /:id : move the booking on (or a step back). Dispatching names who goes and emails the
 * client their names and phones; completing emails them a thank-you with their gallery link.
 * → { booking, email: { to, sent, gallery? } | null }
 */
async function update(req, id, { status, crew: crewIds }) {
  const conn = await pool.getConnection()
  let team = null // who was sent, in the order chosen
  let completed // it became completed just now (not a repeat)
  try {
    await conn.beginTransaction()
    const row = await bookings.lockById(id, conn)
    if (!row) throw new HttpError(404, "That booking doesn't exist.", { code: "NOT_FOUND" })
    if (row.status !== status && !NEXT[row.status].includes(status)) {
      throw fieldError(409, "status", `A ${row.status} booking can't become ${status}.`, "BAD_TRANSITION")
    }
    if (status === "dispatched") {
      const ids = [...new Set(crewIds)]
      const found = await bookings.crewMembers({ ids }, conn)
      if (found.length !== ids.length) throw fieldError(400, "crew", "Someone chosen can't be sent: choose from the studio's photographers.")
      await bookings.setCrew(id, ids, req.user.id, conn)
      team = ids.map((uid) => found.find((m) => m.id === uid))
    }
    completed = status === "completed" && row.status !== "completed"
    await bookings.setStatus(id, { status, handledBy: req.user.id }, conn)
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  const fresh = await bookings.findById(id)
  const email = team ? await emailCrew(fresh, team) : completed ? await emailCompleted(fresh) : null
  audit(req, "booking_update", { userId: req.user.id, detail: { bookingId: id, status, crew: crewIds ?? undefined, emailed: email?.sent } })
  return { booking: await withCrew(fresh), email }
}

module.exports = { request, manual, list, summary, crew, update, refOf }
