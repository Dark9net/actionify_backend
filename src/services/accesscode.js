/**
 * The Access codes page: staff list, make, extend, revoke and restore gallery codes.
 * (Guests opening a code is services/gallerycode.js.)
 *
 * - The table is read a page at a time: PAGE_SIZE rows, newest first, with a cursor for the next
 *   page (keyset on created_at and id, so a page never skips or repeats a row as codes are added).
 * - Every code opens one event (gallery_codes.event_id); its name and booking come from the event.
 * - The code is kept AES-256-GCM encrypted (code_enc) and found by an HMAC (code_hash), so a search
 *   by code matches whole codes only.
 */
const crypto = require("node:crypto")
const codes = require("../models/gallery-code")
const pages = require("../models/access-code")
const { seal } = require("../utils/crypto")
const { hashCode, makeCode, readCode, codeState } = require("../utils/gallery-code")
const { normaliseCode, CODE } = require("../validators/gallerycode")
const { encodeCursor, PAGE_SIZE } = require("../validators/accesscode")
const { HttpError } = require("../utils/http-error")
const { audit } = require("../utils/audit")

const DAY_MS = 86_400_000

const fieldError = (status, field, message, code = "VALIDATION") =>
  new HttpError(status, message, { code, details: { field, errors: { [field]: message } } })

/** One row of the table. */
const toPublic = (row) => ({
  id: row.id,
  code: readCode(row),
  eventId: row.event_id,
  eventName: row.event_name,
  label: row.label,
  bookingId: row.booking_id,
  maxUsers: row.max_users,
  liveUsers: row.live_users === undefined ? undefined : Number(row.live_users),
  state: codeState(row),
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  opens: row.open_count,
  lastOpenedAt: row.last_opened_at,
  createdBy: row.created_by ? { id: row.created_by, name: row.created_by_name } : null,
  createdAt: row.created_at,
})

/**
 * GET / : one page. Asks the database for one row more than a page, only to know whether
 * another page follows; that row isn't sent.
 */
async function list({ status, q, cursor }) {
  const whole = q ? normaliseCode(q) : ""
  const rows = await pages.page({
    status,
    codeHash: CODE.test(whole) ? hashCode(whole) : undefined,
    text: q,
    cursor,
    limit: PAGE_SIZE + 1,
  })
  const more = rows.length > PAGE_SIZE
  const shown = more ? rows.slice(0, PAGE_SIZE) : rows
  return {
    codes: shown.map(toPublic),
    pageSize: PAGE_SIZE,
    nextCursor: more ? encodeCursor(shown[shown.length - 1]) : null,
  }
}

/** GET /summary : the stats and the counts on the status tabs. */
async function summary() {
  const s = await pages.summary()
  const n = (v) => Number(v ?? 0)
  return {
    all: n(s.total),
    active: n(s.active),
    expired: n(s.expired),
    revoked: n(s.revoked),
    endingSoon: n(s.ending_soon),
    opens: n(s.opens),
    activeEvents: n(s.active_events),
  }
}

/** Each event's code (any state), for the event list and folder: Map eventId → the code. */
async function byEvents(eventIds) {
  return new Map((await codes.findByEvents(eventIds)).map((row) => [row.event_id, toPublic(row)]))
}

/** GET /events : the form's Event list; `codeId` marks an event that has its code already. */
async function events() {
  return (await pages.events()).map((e) => ({ id: e.id, name: e.name, date: e.event_date, codeId: e.code_id ?? null }))
}

/**
 * POST / : a new code for an event. `db`: a transaction to join (services/events.js makes an event
 * and its first code together); the caller then writes the audit entry once it commits.
 */
async function create(req, { eventId, label, maxUsers, days, code }, db) {
  const event = await pages.findEvent(eventId, db)
  if (!event) throw fieldError(400, "eventId", "That event doesn't exist. Choose another.")
  const existing = await codes.findByEvent(event.id, db)
  if (existing) throw hasCode(event, existing.id)
  const expiresAt = days ? new Date(Date.now() + days * DAY_MS) : null
  for (let attempt = 0; attempt < 5; attempt++) {
    const value = code ?? makeCode()
    const id = crypto.randomUUID()
    try {
      await codes.create(
        {
          id,
          codeHash: hashCode(value),
          codeEnc: seal(value),
          eventName: event.name,
          label: label ?? "Guests",
          eventId: event.id,
          bookingId: event.booking_id,
          maxUsers: maxUsers ?? null,
          expiresAt,
          createdBy: req.user.id,
        },
        db,
      )
      if (!db) audit(req, "code_create", { userId: req.user.id, detail: { codeId: id, eventId: event.id, maxUsers: maxUsers ?? null } })
      return toPublic(await codes.findById(id, db))
    } catch (err) {
      if (err.code !== "ER_DUP_ENTRY") throw err
      // another request made the event's code in the meantime
      if (err.message.includes("uq_gallery_codes_event")) throw hasCode(event, (await codes.findByEvent(event.id, db))?.id)
      if (code) throw fieldError(409, "code", "That code is already in use. Choose another.", "CODE_TAKEN")
      // a made-up code collided (vanishingly rare): try another
    }
  }
  throw new Error("Couldn't make a unique gallery code in 5 tries")
}

/** An event has one code: a second one is refused, and the panel offers to regenerate the first. */
function hasCode(event, codeId) {
  const message = `${event.name} already has an access code. Regenerate it instead of making a second one.`
  return new HttpError(409, message, { code: "EVENT_HAS_CODE", details: { field: "eventId", codeId: codeId ?? null, errors: { eventId: message } } })
}

/**
 * POST /:id/regenerate : a new code for the same event, in the same row. The old code stops opening
 * the gallery and every browser viewing with it is sent away; client accounts that hold the
 * gallery keep it. Without `code` one is made up.
 */
async function regenerate(req, id, { code } = {}) {
  const row = await codes.findById(id)
  if (!row) throw new HttpError(404, "That access code doesn't exist.", { code: "NOT_FOUND" })
  for (let attempt = 0; attempt < 5; attempt++) {
    const value = code ?? makeCode()
    if (value === readCode(row)) {
      if (code) throw fieldError(409, "code", "That is the current code. Choose a new one.", "CODE_TAKEN")
      continue
    }
    try {
      await codes.replaceCode(id, { codeHash: hashCode(value), codeEnc: seal(value), createdBy: req.user.id })
      await codes.endSessionsForCode(id)
      audit(req, "code_regenerate", { userId: req.user.id, detail: { codeId: id, eventId: row.event_id } })
      return toPublic(await codes.findById(id))
    } catch (err) {
      if (err.code !== "ER_DUP_ENTRY") throw err
      if (code) throw fieldError(409, "code", "That code is already in use. Choose another.", "CODE_TAKEN")
    }
  }
  throw new Error("Couldn't make a unique gallery code in 5 tries")
}

/** PATCH /:id : revoke or restore, extend, or change the viewer limit. */
async function update(req, id, { revoked, extendDays, maxUsers }) {
  const row = await codes.findById(id)
  if (!row) throw new HttpError(404, "That access code doesn't exist.", { code: "NOT_FOUND" })
  let expiresAt
  if (extendDays) {
    // from today when it has already ended, else from its current end
    const from = row.expires_at && row.expires_at > new Date() ? row.expires_at.getTime() : Date.now()
    expiresAt = new Date(from + extendDays * DAY_MS)
  }
  await codes.update(id, { revoked, revokedBy: req.user.id, expiresAt, maxUsers })
  if (revoked) await codes.endSessionsForCode(id) // everyone viewing it is sent away at their next check-in
  const event = revoked ? "code_revoke" : revoked === false ? "code_restore" : "code_update"
  audit(req, event, { userId: req.user.id, detail: { codeId: id, extendDays, maxUsers } })
  return toPublic(await codes.findById(id))
}

module.exports = { list, summary, events, byEvents, create, update, regenerate }
