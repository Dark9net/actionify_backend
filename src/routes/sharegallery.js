/**
 * /api/v1/share-gallery: sharing an event's gallery from the panel's Uploads page
 * (staff: Bearer + permission).
 *
 *   GET   /:eventId          access_code.view     → { event, gallery, client }
 *         gallery: { id, code, link, qr (PNG data URL), state, expiresAt, maxUsers, opens }
 *                  | { id, state: "revoked" | "expired" } | null (no code yet)
 *         client:  { name, email, verified, source: "account" | "booking" } | null
 *   POST  /:eventId/email    access_code.manage   { email, confirmed: true, message? }
 *                                                 → { to, toClient, printed }
 *         emails the link, the code and its QR code, and how to open and download the photos;
 *         409 NO_LIVE_CODE without a live code, 400 (field confirmed) unless confirmed,
 *         502 MAIL_FAILED when the mail server refuses it
 */
const express = require("express")
const shareGallery = require("../controllers/sharegallery")
const { requireAuth } = require("../middleware/auth")
const { requirePerm, requireStaff } = require("../middleware/requireperm")
const limit = require("../middleware/rate-limit")
const { validate } = require("../middleware/validate")
const { shareEmailSchema } = require("../validators/sharegallery")

// every share sends an email: at most 5 an hour to one address, 30 from one place
const shareLimit = limit.limiter({ name: "share-gallery", windowSeconds: 60 * 60, perIp: 30, perEmail: 5 })

const router = express.Router()
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store") // the answer holds a gallery code: never kept by the browser or a proxy
  next()
})
router.use(requireAuth, requireStaff)

router.get("/:eventId", requirePerm("access_code.view"), shareGallery.details)
router.post("/:eventId/email", requirePerm("access_code.manage"), validate(shareEmailSchema), shareLimit, shareGallery.sendEmail)

module.exports = router
