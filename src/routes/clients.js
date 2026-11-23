/**
 * /api/v1/clients: the panel's Clients page (staff: Bearer + permission). Every row is a booking.
 *
 *   GET    /?payment=&q=&cursor=              client.view    → { clients (10), pageSize, nextCursor }
 *          payment: all | none | requested | advance | paid;
 *          q: part of the name, email, phone or venue, or a reference (BK-3F2A9C);
 *          cursor: nextCursor from the page before (none: the first page)
 *   GET    /summary                           client.view    → { summary: { bookings, clients, ahead, paid,
 *                                                               due, none, requested, advance, fullyPaid } }
 *   GET    /payment-qr                        client.view    → { qr: { url, updatedAt, updatedBy } | null }
 *   PUT    /payment-qr                        client.manage  the studio's payment QR as the body (PNG, JPEG
 *                                                            or WebP, ≤ 5 MB) → { qr }
 *   DELETE /payment-qr                        client.manage  → { qr: null }
 *   GET    /:bookingId/payments               client.view    → { client, payments }
 *   POST   /:bookingId/payments               client.manage  { amount (NPR), kind: advance | full, note? }
 *                                                            → 201 { payment, client, email: { to, sent } }
 *                                                            emails the client the amount and the QR
 *   PATCH  /:bookingId/payments/:paymentId    client.manage  { status: paid | cancelled | refunded | requested }
 *                                                            → { payment, client } (refunds: payment.manage too)
 */
const express = require("express")
const clients = require("../controllers/clients")
const service = require("../services/clients")
const { requireAuth } = require("../middleware/auth")
const { requirePerm, requireStaff } = require("../middleware/requireperm")
const limit = require("../middleware/rate-limit")
const { validate, validateQuery } = require("../middleware/validate")
const { listQuery, requestSchema, paymentStatusSchema } = require("../validators/clients")

const router = express.Router()
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store") // names, emails, phone numbers and money
  next()
})
router.use(requireAuth, requireStaff)

router.get("/", requirePerm("client.view"), validateQuery(listQuery), clients.list)
router.get("/summary", requirePerm("client.view"), clients.summary)

// the picture itself is the body: read only once the session and permission are checked
const qrBody = express.raw({ type: service.QR_TYPES, limit: service.QR_MAX_BYTES })
router.get("/payment-qr", requirePerm("client.view"), clients.paymentQr)
router.put("/payment-qr", limit.write, requirePerm("client.manage"), qrBody, clients.setPaymentQr)
router.delete("/payment-qr", limit.write, requirePerm("client.manage"), clients.removePaymentQr)

router.get("/:bookingId/payments", requirePerm("client.view"), clients.payments)
router.post("/:bookingId/payments", limit.write, requirePerm("client.manage"), validate(requestSchema), clients.requestPayment)
router.patch("/:bookingId/payments/:paymentId", limit.write, requirePerm("client.manage"), validate(paymentStatusSchema), clients.setPaymentStatus)

module.exports = router
