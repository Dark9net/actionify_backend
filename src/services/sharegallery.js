/**
 * Sharing an event's gallery (the panel's Uploads page: the share button on each event).
 *
 * - GET  : what the share window shows: the event, its live gallery code with the private link and
 *          a QR code of that link (a PNG data URL, shown and downloadable), and the event's client
 *          with the email on record (from the client's account, else from the booking), if any.
 * - POST : emails the link, the code and the QR code to an address, with how to open, favourite,
 *          download and share the photos. The address has to be confirmed in the window first
 *          (`confirmed`): the client's address on record by a tick, a new one by typing it twice.
 *
 * Only a live code is shared: an event without one (none yet, revoked or expired) answers
 * 409 NO_LIVE_CODE, and the window offers to create one (POST /api/v1/access-codes).
 */
const QRCode = require("qrcode")
const env = require("../config/env")
const events = require("../models/event")
const codes = require("../models/gallery-code")
const people = require("../models/share-gallery")
const mail = require("../utils/mailer")
const { isSmtp } = require("../config/mail")
const { readCode, codeState } = require("../utils/gallery-code")
const { HttpError } = require("../utils/http-error")
const { audit } = require("../utils/audit")

const QR_OPTIONS = { width: 480, margin: 2, errorCorrectionLevel: "M", color: { dark: "#1d1a16", light: "#ffffff" } }

const fieldError = (status, field, message, code = "VALIDATION") =>
  new HttpError(status, message, { code, details: { field, errors: { [field]: message } } })

/** The private link a code opens: the client's gallery page with the code filled in. */
const linkFor = (code) => `${env.APP_URL}/dashboard?code=${encodeURIComponent(code)}`

async function eventOr404(id) {
  const ev = await events.findById(id)
  if (!ev) throw new HttpError(404, "That event no longer exists.", { code: "NOT_FOUND" })
  return ev
}

/**
 * The event's gallery code: { id, code, link, state, expiresAt, maxUsers, opens } for a live one;
 * { state } alone when it has one that is revoked or expired; null when it has none.
 */
async function galleryOf(ev) {
  const row = await codes.findByEvent(ev.id)
  if (!row) return null
  const state = codeState(row)
  if (state !== "active") return { id: row.id, state }
  const code = readCode(row)
  return {
    id: row.id,
    code,
    link: linkFor(code),
    state,
    expiresAt: row.expires_at,
    maxUsers: row.max_users,
    opens: row.open_count,
  }
}

/**
 * The event's client and the email on record: the account named on the event, else the booking it
 * was made for. → { name, email, verified, source: "account" | "booking" } | null
 *   verified: the account behind that address has confirmed it (true / false), or null when the
 *   address belongs to no account (a booking made without one).
 */
async function clientOf(ev) {
  if (ev.client_id) {
    const u = await people.clientAccount(ev.client_id)
    if (u?.email) return { name: u.full_name, email: u.email, verified: Boolean(u.email_verified_at), source: "account" }
  }
  if (ev.booking_id) {
    const b = await people.bookingContact(ev.booking_id)
    if (b?.email) {
      const same = b.account_email && b.account_email.toLowerCase() === b.email.toLowerCase()
      return { name: b.client_name, email: b.email, verified: same ? Boolean(b.email_verified_at) : null, source: "booking" }
    }
  }
  return null
}

const eventPublic = (ev) => ({ id: ev.id, name: ev.name, date: ev.event_date, venue: ev.venue, kind: ev.kind })

/** GET /:eventId → { event, gallery, client } (gallery.qr: the QR code as a PNG data URL) */
async function details(eventId) {
  const ev = await eventOr404(eventId)
  const [gallery, client] = await Promise.all([galleryOf(ev), clientOf(ev)])
  if (gallery?.link) gallery.qr = await QRCode.toDataURL(gallery.link, QR_OPTIONS)
  return { event: eventPublic(ev), gallery, client }
}

/**
 * POST /:eventId/email { email, confirmed, message? } → { to, toClient, printed }
 *   printed: no mail server is set (development), so the email went to the server console.
 */
async function sendEmail(req, eventId, { email, confirmed, message }) {
  const ev = await eventOr404(eventId)
  const [gallery, client] = await Promise.all([galleryOf(ev), clientOf(ev)])
  if (!gallery?.code) {
    throw new HttpError(409, "This event has no live gallery code to share. Create one first.", {
      code: "NO_LIVE_CODE",
      details: { state: gallery?.state ?? "none" },
    })
  }
  const toClient = Boolean(client && client.email.toLowerCase() === email)
  if (!confirmed) {
    throw fieldError(
      400,
      "confirmed",
      toClient ? `Confirm that ${client.email} is still the right address for ${client.name}.` : "Type the email address twice to confirm it.",
    )
  }

  const from = await people.staffName(req.user.id)
  try {
    await mail.sendGalleryShareEmail({
      to: email,
      name: toClient ? client.name : null,
      event: { name: ev.name, date: ev.event_date, venue: ev.venue },
      gallery,
      message,
      from,
    })
  } catch (err) {
    console.error(`Sharing the gallery of event ${ev.id}: the email could not be sent:`, err.message)
    throw new HttpError(502, "The email could not be sent. Check the studio's mail settings, then try again.", { code: "MAIL_FAILED" })
  }

  audit(req, "gallery_shared", { userId: req.user.id, email, detail: { eventId: ev.id, codeId: gallery.id, toClient } })
  return { to: email, toClient, printed: !isSmtp }
}

module.exports = { details, sendEmail, linkFor }
