/**
 * /api/v1/payments: the panel's Payments page (staff: Bearer + permission). Every row is one payment
 * (bookings_payment), in Nepalese rupees.
 *
 *   GET   /?status=&q=&cursor=   payment.view   → { payments (10), pageSize, nextCursor }
 *         status: all | requested | paid | cancelled | refunded;
 *         q: the client's name, email or phone, the note, or a booking reference (BK-3F2A9C);
 *         cursor: nextCursor from the page before (none: the first page)
 *   GET   /summary?tz=           payment.view   → { summary: { all, requested, paid, cancelled, refunded
 *                                                 ({ n, npr } each), last30, prev30, months: [{ month, n, npr }] } }
 *                                                 tz: the browser's offset from UTC in minutes (Nepal: 345)
 *   GET   /bookings?q=           payment.view + one of payment.manage, client.manage
 *                                              → { bookings (≤ 6, not cancelled) } to record a payment for
 *   POST  /                      payment.view + one of payment.manage, client.manage
 *                                              { bookingId, amount (NPR), kind: advance | full,
 *                                                method: cash | bank | esewa | khalti | fonepay, note? }
 *                                              → 201 { payment } already received; nobody is emailed
 *   PATCH /:paymentId            payment.view + one of payment.manage, client.manage
 *                                              { status: paid | cancelled | refunded | requested } → { payment }
 *                                              refunding, or undoing a refund, needs payment.manage
 */
const express = require("express")
const payments = require("../controllers/payments")
const { requireAuth } = require("../middleware/auth")
const { requireAnyPerm, requirePerm, requireStaff } = require("../middleware/requireperm")
const limit = require("../middleware/rate-limit")
const { validate, validateQuery } = require("../middleware/validate")
const { listQuery, summaryQuery, bookingsQuery, recordSchema, statusSchema } = require("../validators/payments")

const router = express.Router()
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store") // names, emails and money
  next()
})
router.use(requireAuth, requireStaff, requirePerm("payment.view"))

// the same people who mark a payment received on Clients (client.manage), and the studio lead
const changes = requireAnyPerm("payment.manage", "client.manage")

router.get("/", validateQuery(listQuery), payments.list)
router.get("/summary", validateQuery(summaryQuery), payments.summary)
router.get("/bookings", changes, validateQuery(bookingsQuery), payments.bookings)
router.post("/", limit.write, changes, validate(recordSchema), payments.record)
router.patch("/:paymentId", limit.write, changes, validate(statusSchema), payments.setStatus)

module.exports = router
