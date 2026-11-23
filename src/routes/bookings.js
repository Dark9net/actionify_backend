/**
 * /api/v1/bookings
 *
 * The website (anyone; signed in, the request is linked to the account):
 *   POST  /                      { name, email, phone?, type, date, time?, venue, coverage?, crew, notes? }
 *                                → 201 { booking: { ref, type, date, venue } }   status "requested"
 *
 * The panel's Bookings page (staff: Bearer + permission):
 *   GET   /?status=&q=&cursor=   booking.view    → { bookings (10), pageSize, nextCursor }
 *         status: all (not cancelled) | requested | confirmed | dispatched | completed | cancelled;
 *         q: part of the name, email, phone or venue, or a reference (BK-3F2A9C);
 *         cursor: nextCursor from the page before (none: the first page)
 *   GET   /summary               booking.view    → { summary: { all, requested, confirmed, dispatched,
 *                                                    completed, cancelled, withinWeek, withoutFolder, crewOut } }
 *   GET   /crew?day=             booking.view    → { crew: [{ id, name, role, mobile, off, busy }] }  (Send photographers)
 *   POST  /manual                booking.manage  the same fields → 201 { booking }   status "confirmed"
 *   PATCH /:id                   booking.manage  { status, crew? } → { booking, email }   crew: who goes
 *                                                (dispatched); the client is emailed their names and phones.
 *                                                On completion the client gets a thank-you with the gallery
 *                                                link, code and QR code. email { to, sent, gallery? }, null
 *                                                for other changes
 */
const express = require("express")
const bookings = require("../controllers/bookings")
const { requireAuth, optionalAuth } = require("../middleware/auth")
const { requirePerm, requireStaff } = require("../middleware/requireperm")
const limit = require("../middleware/rate-limit")
const { validate, validateQuery } = require("../middleware/validate")
const { requestSchema, manualSchema, listQuery, updateSchema, crewQuery } = require("../validators/bookings")

const router = express.Router()
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store") // names, emails and phone numbers
  next()
})

router.post("/", limit.booking, optionalAuth, validate(requestSchema), bookings.request)

router.use(requireAuth, requireStaff)
router.get("/", requirePerm("booking.view"), validateQuery(listQuery), bookings.list)
router.get("/summary", requirePerm("booking.view"), bookings.summary)
router.get("/crew", requirePerm("booking.view"), validateQuery(crewQuery), bookings.crew)
router.post("/manual", limit.write, requirePerm("booking.manage"), validate(manualSchema), bookings.manual)
router.patch("/:id", limit.write, requirePerm("booking.manage"), validate(updateSchema), bookings.update)

module.exports = router
