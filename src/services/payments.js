/**
 * The Payments page: every payment (bookings_payment), newest first, in Nepalese rupees, with the
 * money received each month, what is still awaited and what was refunded.
 *
 * A payment is asked for from Clients (emailed with the studio's QR) or recorded here by hand once the
 * money is in (cash on the day, a bank transfer). Its status:
 *   requested  asked, not paid yet       → paid (received) or cancelled
 *   paid       the money arrived         → refunded, or back to requested (marked paid by mistake)
 *   cancelled  not wanted any more       → back to requested
 *   refunded   paid, then given back     → back to paid (refunded by mistake)
 * One recorded by hand was never asked for: it goes paid ↔ cancelled (recorded by mistake), or refunded.
 * Refunding (and undoing one) needs payment.manage: it is money going out.
 *
 * The list is read a page at a time: PAGE_SIZE payments with a cursor for the next page (keyset on
 * created_at and id, like Bookings and Clients).
 */
const crypto = require("node:crypto")
const payments = require("../models/payment")
const clients = require("../models/client")
const { encodeCursor, PAGE_SIZE } = require("../validators/payments")
const { refOf } = require("./bookings")
const { loadAccess } = require("../middleware/requireperm")
const { HttpError } = require("../utils/http-error")
const { audit } = require("../utils/audit")

const REF = /^BK-?([0-9A-F]{6})$/i
const DAY = 864e5
const MONTHS = 6

const rupees = (v) => Number(v ?? 0)
const person = (id, name) => (id ? { id, name: name ?? null } : null)

/** One payment, as the Clients window and the Payments page show it. */
const paymentOf = (p) => ({
  id: p.id,
  bookingId: p.booking_id,
  kind: p.kind,
  amount: rupees(p.amount_npr),
  status: p.status,
  method: p.method, // null: paid through the QR (or not said)
  note: p.note,
  emailTo: p.email_to,
  emailedAt: p.emailed_at,
  requestedBy: person(p.requested_by, p.requested_by_name),
  paidAt: p.paid_at,
  paidBy: person(p.paid_by, p.paid_by_name),
  refundedAt: p.refunded_at,
  refundedBy: person(p.refunded_by, p.refunded_by_name),
  createdAt: p.created_at,
})

/** A row of the Payments page: the payment and its booking. */
const rowOf = (p) => ({
  ...paymentOf(p),
  booking: {
    id: p.booking_id,
    ref: refOf(p.booking_id),
    name: p.client_name,
    email: p.client_email,
    phone: p.client_phone,
    type: p.event_type,
    date: p.event_day,
    venue: p.venue,
    status: p.booking_status,
  },
})

/** "BK-3F2A9C" searches by reference; anything else by name, email, phone or note. */
const searchOf = (q) => {
  const ref = q?.match(REF)
  return { idPrefix: ref ? ref[1].toLowerCase() : undefined, text: ref ? undefined : q }
}

/** GET / : one page (PAGE_SIZE, or `limit`). Asks for one row more, only to know whether another follows. */
async function list({ status, q, cursor, limit = PAGE_SIZE }) {
  const rows = await payments.page({ status, ...searchOf(q), cursor, limit: limit + 1 })
  const more = rows.length > limit
  const shown = more ? rows.slice(0, limit) : rows
  return { payments: shown.map(rowOf), pageSize: limit, nextCursor: more ? encodeCursor(shown[shown.length - 1]) : null }
}

/**
 * GET /summary : the count and sum in every status, money received in the last 30 days and the 30
 * before, and in each of the last six months (this one last). Months and days follow `tz`, the
 * browser's offset from UTC in minutes.
 */
async function summary({ tz }) {
  const now = Date.now()
  const local = new Date(now + tz * 6e4)
  const monthStart = (back) => new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - back, 1) - tz * 6e4)
  const months = Array.from({ length: MONTHS }, (_, i) => [monthStart(MONTHS - 1 - i), monthStart(MONTHS - 2 - i)])
  const soon = new Date(now + DAY) // paid_at is written by the database's clock: leave it room
  const windows = [[new Date(now - 30 * DAY), soon], [new Date(now - 60 * DAY), new Date(now - 30 * DAY)], ...months]
  const row = await payments.summary(windows)
  const n = (v) => Number(v ?? 0)
  const total = (s) => ({ n: n(row[`${s}_n`]), npr: rupees(row[`${s}_npr`]) })
  const win = (i) => ({ n: n(row[`w${i}_n`]), npr: rupees(row[`w${i}_npr`]) })
  return {
    all: n(row.all_n),
    requested: total("requested"),
    paid: total("paid"),
    cancelled: total("cancelled"),
    refunded: total("refunded"),
    last30: win(0),
    prev30: win(1),
    months: months.map(([from], i) => {
      const at = new Date(from.getTime() + tz * 6e4)
      return { month: `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`, ...win(i + 2) }
    }),
  }
}

/** GET /bookings : up to 6 bookings (not cancelled) matching the search, to record a payment for. */
async function bookings({ q }) {
  const rows = await clients.page({ ...searchOf(q), limit: 6, active: true })
  return rows.map((b) => ({
    id: b.id,
    ref: refOf(b.id),
    name: b.client_name,
    email: b.email,
    type: b.event_type,
    date: b.event_day,
    venue: b.venue,
    status: b.status,
    paid: rupees(b.paid),
    due: rupees(b.due),
  }))
}

/** POST / : a payment already received, recorded by hand. Nobody is emailed. → { payment } */
async function record(req, { bookingId, amount, kind, method, note }) {
  const booking = await clients.findBooking(bookingId)
  if (!booking) throw new HttpError(404, "That booking doesn't exist.", { code: "NOT_FOUND" })
  if (booking.status === "cancelled") {
    throw new HttpError(409, "That booking was cancelled. Restore it on Bookings before recording a payment.", { code: "BOOKING_CANCELLED" })
  }
  const id = crypto.randomUUID()
  await clients.createPayment({ id, bookingId, kind, amount, note, method, requestedBy: req.user.id, paidBy: req.user.id })
  audit(req, "payment_record", { userId: req.user.id, detail: { bookingId, paymentId: id, kind, amount, method } })
  return { payment: rowOf(await payments.findRow(id)) }
}

// what a payment may become: one asked for from Clients, and one recorded by hand (it has a method)
const NEXT = { requested: ["paid", "cancelled"], paid: ["requested", "refunded"], cancelled: ["requested"], refunded: ["paid"] }
const NEXT_BY_HAND = { paid: ["cancelled", "refunded"], cancelled: ["paid"], refunded: ["paid"] }

/**
 * Moves a payment to `status` (Clients and Payments both come here). bookingId, when given, must be
 * the payment's booking. → the payment's row (from the Payments page's query)
 */
async function changeStatus(req, { bookingId, paymentId, status }) {
  const payment = await payments.findRow(paymentId)
  if (!payment || (bookingId && payment.booking_id !== bookingId)) throw new HttpError(404, "That payment doesn't exist.", { code: "NOT_FOUND" })
  if (payment.status === status) return payment
  if (!(payment.method ? NEXT_BY_HAND : NEXT)[payment.status]?.includes(status)) {
    throw new HttpError(409, `A ${payment.status} payment can't become ${status}.`, { code: "BAD_TRANSITION" })
  }
  if ((status === "refunded" || payment.status === "refunded") && !(await loadAccess(req)).can("payment.manage")) {
    throw new HttpError(403, "Only the studio lead can refund a payment.", { code: "FORBIDDEN", details: { required: ["payment.manage"] } })
  }
  await clients.setPaymentStatus(paymentId, status, req.user.id)
  audit(req, "payment_update", { userId: req.user.id, detail: { bookingId: payment.booking_id, paymentId, from: payment.status, to: status } })
  return payments.findRow(paymentId)
}

/** PATCH /:paymentId : { status } → { payment } */
async function setStatus(req, paymentId, { status }) {
  return { payment: rowOf(await changeStatus(req, { paymentId, status })) }
}

module.exports = { list, summary, bookings, record, setStatus, changeStatus, paymentOf, rowOf }
