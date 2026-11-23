/**
 * The Clients page: every booking, with its client and what they have been asked to pay and have paid.
 *
 * Payments (bookings_payment): the studio asks for an advance or the full payment, in Nepalese rupees.
 * Asking emails the client the amount with the studio's own payment QR (uploaded once in Settings);
 * the studio marks it paid when the money arrives, or cancels it. A booking's payment state:
 *   none       nothing asked yet
 *   requested  asked, not paid yet
 *   advance    an advance paid (the full payment not yet)
 *   paid       the full payment received
 *
 * The table is read a page at a time: PAGE_SIZE bookings, newest first, with a cursor for the next page
 * (keyset on created_at and id, like the Bookings page).
 */
const crypto = require("node:crypto")
const clients = require("../models/client")
const { encodeCursor, PAGE_SIZE } = require("../validators/clients")
const { refOf } = require("./bookings")
const { paymentOf, changeStatus } = require("./payments")
const { r2, putObject, removeObject, getObjectBuffer, signedViewUrl } = require("../config/r2config")
const { inspect } = require("../utils/image")
const mail = require("../utils/mailer")
const { HttpError } = require("../utils/http-error")
const { audit } = require("../utils/audit")

const REF = /^BK-?([0-9A-F]{6})$/i
const QR_SETTING = "payment_qr_key"
const QR_TYPES = ["image/png", "image/jpeg", "image/webp"]
const QR_MAX_BYTES = 5 * 1024 * 1024
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }

const rupees = (v) => Number(v ?? 0)

/** One row of the table. */
const toPublic = (row) => ({
  id: row.id,
  ref: refOf(row.id),
  name: row.client_name,
  email: row.email,
  phone: row.phone,
  type: row.event_type,
  date: row.event_day,
  time: row.start_hm,
  venue: row.venue,
  status: row.status, // the booking's
  hasAccount: Boolean(row.user_id),
  payment: {
    state: row.pay_state,
    paid: rupees(row.paid),
    due: rupees(row.due),
    advancePaid: Boolean(Number(row.advance_paid)),
    fullPaid: Boolean(Number(row.full_paid)),
    requests: Number(row.requests),
    lastRequestAt: row.last_request_at,
  },
  event: row.event_id ? { id: row.event_id, name: row.event_name, hasCode: Boolean(Number(row.code_live)) } : null,
  createdAt: row.created_at,
})

/** GET / : one page. Asks for one row more than a page, only to know whether another follows. */
async function list({ payment, q, cursor }) {
  const ref = q?.match(REF)
  const rows = await clients.page({
    payment,
    idPrefix: ref ? ref[1].toLowerCase() : undefined,
    text: ref ? undefined : q,
    cursor,
    limit: PAGE_SIZE + 1,
  })
  const more = rows.length > PAGE_SIZE
  const shown = more ? rows.slice(0, PAGE_SIZE) : rows
  return {
    clients: shown.map(toPublic),
    pageSize: PAGE_SIZE,
    nextCursor: more ? encodeCursor(shown[shown.length - 1]) : null,
  }
}

/** GET /summary : the figures and the tab counts. */
async function summary() {
  const s = await clients.summary()
  const n = (v) => Number(v ?? 0)
  return {
    bookings: n(s.bookings),
    clients: n(s.clients),
    ahead: n(s.ahead),
    paid: rupees(s.paid_npr),
    due: rupees(s.due_npr),
    none: n(s.state_none),
    requested: n(s.state_requested),
    advance: n(s.state_advance),
    fullyPaid: n(s.state_paid),
  }
}

async function bookingOr404(id) {
  const booking = await clients.findBooking(id)
  if (!booking) throw new HttpError(404, "That booking doesn't exist.", { code: "NOT_FOUND" })
  return booking
}

/** GET /:bookingId/payments : the booking's row and every payment asked for it, newest first. */
async function payments(bookingId) {
  await bookingOr404(bookingId)
  return { client: toPublic(await clients.findRow(bookingId)), payments: (await clients.payments(bookingId)).map(paymentOf) }
}

/* ---------- The studio's payment QR ---------- */

/** GET /payment-qr : { url, updatedAt, updatedBy } | null */
async function paymentQr() {
  const s = await clients.getSetting(QR_SETTING)
  if (!s?.value || !r2) return null
  return { url: await signedViewUrl(s.value), updatedAt: s.updated_at, updatedBy: s.updated_by_name ?? null }
}

const qrError = (message, code = "QR_INVALID", status = 400) =>
  new HttpError(status, message, { code, details: { field: "qr", errors: { qr: message } } })

/** PUT /payment-qr : the picture as the body. Kept as it is (a QR must not be cropped or shrunk). */
async function setPaymentQr(req, body) {
  if (!r2) throw qrError("Photo storage (R2) isn't set up yet, so the QR can't be saved.", "R2_DISABLED", 503)
  if (!Buffer.isBuffer(body) || !body.length) throw qrError("Choose the QR as a JPEG, PNG or WebP picture.", "QR_MISSING")
  const image = inspect(body)
  if (!image) throw qrError("That file isn't a JPEG, PNG or WebP picture.")
  if (image.width < 100 || image.height < 100) throw qrError("That picture is too small to scan. Use one at least 100 pixels a side.")
  if (image.width > 6000 || image.height > 6000) throw qrError("That picture is too large. Use one at most 6000 pixels a side.")
  const before = await clients.getSetting(QR_SETTING)
  const key = `studio/payment-qr/${crypto.randomBytes(12).toString("hex")}.${EXT[image.type]}`
  await putObject(key, body, { contentType: image.type, cacheControl: "private, max-age=31536000, immutable" })
  await clients.setSetting(QR_SETTING, key, req.user.id)
  if (before?.value) removeObject(before.value).catch((err) => console.error("Couldn't remove the old payment QR:", err.message))
  audit(req, "payment_qr_set", { userId: req.user.id, detail: { type: image.type, width: image.width, height: image.height } })
  return paymentQr()
}

/** DELETE /payment-qr */
async function removePaymentQr(req) {
  const before = await clients.getSetting(QR_SETTING)
  if (!before?.value) return null
  await clients.setSetting(QR_SETTING, null, req.user.id)
  if (r2) removeObject(before.value).catch((err) => console.error("Couldn't remove the payment QR:", err.message))
  audit(req, "payment_qr_remove", { userId: req.user.id })
  return null
}

/* ---------- Asking for a payment ---------- */

/**
 * POST /:bookingId/payments : records the request and emails the client the amount with the studio's
 * QR. Refused without a QR (the email would have nothing to pay with). The email failing doesn't
 * undo the request: { sent: false } lets the panel say so. → { payment, client, email: { to, sent } }
 */
async function requestPayment(req, bookingId, { amount, kind, note }) {
  const booking = await bookingOr404(bookingId)
  if (booking.status === "cancelled") {
    throw new HttpError(409, "That booking was cancelled. Restore it on Bookings before asking for a payment.", { code: "BOOKING_CANCELLED" })
  }
  const qrSetting = await clients.getSetting(QR_SETTING)
  if (!qrSetting?.value || !r2) {
    throw new HttpError(409, "Upload the studio's payment QR in Settings first: every payment email carries it.", { code: "NO_PAYMENT_QR" })
  }
  const id = crypto.randomUUID()
  await clients.createPayment({ id, bookingId, kind, amount, note, emailTo: booking.email, requestedBy: req.user.id })
  const before = await clients.findRow(bookingId)

  const email = { to: booking.email, sent: false }
  try {
    const qr = await getObjectBuffer(qrSetting.value)
    await mail.sendPaymentRequestEmail({
      to: booking.email,
      name: booking.client_name,
      ref: refOf(booking.id),
      type: booking.event_type,
      day: booking.event_day,
      venue: booking.venue,
      amount,
      kind,
      note,
      paidSoFar: rupees(before.paid),
      qr: { body: qr.body, contentType: qr.contentType || "image/png" },
    })
    await clients.markEmailed(id)
    email.sent = true
  } catch (err) {
    console.error(`Booking ${refOf(booking.id)}: the payment email could not be sent:`, err.message)
  }
  audit(req, "payment_request", { userId: req.user.id, detail: { bookingId, paymentId: id, kind, amount, emailed: email.sent } })
  return {
    payment: paymentOf(await clients.findPayment(bookingId, id)),
    client: toPublic(await clients.findRow(bookingId)),
    email,
  }
}

/** PATCH /:bookingId/payments/:paymentId : { status } → { payment, client } (the rules: services/payments.js) */
async function setPaymentStatus(req, bookingId, paymentId, { status }) {
  const payment = await changeStatus(req, { bookingId, paymentId, status })
  return { payment: paymentOf(payment), client: toPublic(await clients.findRow(bookingId)) }
}

module.exports = {
  list,
  summary,
  payments,
  paymentQr,
  setPaymentQr,
  removePaymentQr,
  requestPayment,
  setPaymentStatus,
  QR_TYPES,
  QR_MAX_BYTES,
}
