/**
 * /api/v1/overview: the photographer panel's Overview page (staff: Bearer + panel.access).
 *
 *   GET /?offset=345   → { overview: { today, offset, media, bookings, clients, at } }
 *       media     (event.view)    what is on R2: files, photos, videos, bytes, events, 14 days of
 *                                 uploads (today last), this week and the week before
 *       bookings  (booking.view)  counts by state, upcoming, crewOut, the soonest confirmed bookings
 *                                 waiting for a photographer, and the ones under way with their crew
 *       clients   (client.view)   clients, and how many are new in the last 30 days
 *   A part the role can't see is null.
 */
const express = require("express")
const overview = require("../controllers/overview")
const { requireAuth } = require("../middleware/auth")
const { requireStaff } = require("../middleware/requireperm")
const { validateQuery } = require("../middleware/validate")
const { overviewQuery } = require("../validators/overview")

const router = express.Router()

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store") // names and venues
  next()
})
router.use(requireAuth, requireStaff)

router.get("/", validateQuery(overviewQuery), overview.get)

module.exports = router
