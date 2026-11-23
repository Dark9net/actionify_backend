/**
 * /api/v1/gallery-codes
 *
 * Guests and clients (the gallery cookie is sent to /api/v1: these routes and /api/v1/customer-gallery):
 *   POST  /open        { code }        → { role: "client", gallery, session }   (Bearer optional)
 *   GET   /session                     → the same, while this browser's gallery is open | 401 | 410
 *   POST  /leave                       frees the seat, forgets the gallery here
 *   GET   /mine                        → { galleries }   a signed-in client's own   (Bearer)
 *   POST  /:id/enter                   opens one of them in this browser           (Bearer)
 *
 * A visit lasts GALLERY_SESSION_HOURS (24) from when the code was entered, and is always a client's
 * (gallery_code_sessions.role). After it, /session answers 401 and /:id/enter answers
 * 403 GALLERY_VISIT_ENDED (403 GALLERY_CODE_REQUIRED when the account never entered the code):
 * the code has to be entered again.
 *
 * Staff make, extend and revoke codes on the Access codes page: routes/accesscode.js.
 *
 * Wrong codes are counted per IP and block it for a while (services/gallerycode.js); the rate
 * limit below is a second, coarser net.
 */
const express = require("express")
const gallery = require("../controllers/gallerycode")
const { requireAuth, optionalAuth } = require("../middleware/auth")
const limit = require("../middleware/rate-limit")
const { validate } = require("../middleware/validate")
const { openSchema } = require("../validators/gallerycode")

const router = express.Router()
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store")
  next()
})

router.post("/open", limit.openCode, optionalAuth, validate(openSchema), gallery.open)
router.get("/session", limit.gallerySession, gallery.session)
router.post("/leave", gallery.leave)
router.get("/mine", requireAuth, gallery.mine)
router.post("/:id/enter", limit.write, requireAuth, gallery.enter)

module.exports = router
