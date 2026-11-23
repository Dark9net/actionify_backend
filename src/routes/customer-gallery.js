/**
 * /api/v1/customer-gallery: the client's gallery page (Frontend/src/pages/authpanel/Dashboard.jsx).
 *
 * No sign-in: the browser's gallery session (the HttpOnly cookie a gallery code or QR link set,
 * services/gallerycode.js) decides everything, and it opens one event only.
 *
 *   GET /             → { event, albums, totals, cover, gallery: { code, label, expiresAt, link, qr },
 *                         visit: { endsAt }, linksUntil }
 *   GET /items?cursor → { items: [{ id, kind, album, name, contentType, size, width, height, durationMs,
 *                         previewUrl, url, downloadUrl }], nextCursor, linksUntil }  (200 a page)
 *
 * Errors: 401 GALLERY_SESSION_ENDED (no open gallery here), 410 GALLERY_EXPIRED (the code was revoked
 * or ran out), 410 GALLERY_GONE (its event was deleted), 503 R2_DISABLED, 429 (too many requests).
 */
const express = require("express")
const customerGallery = require("../controllers/customer-gallery")
const limit = require("../middleware/rate-limit")
const { validateQuery } = require("../middleware/validate")
const { itemsQuery } = require("../validators/customer-gallery")

const router = express.Router()

// generous: a big gallery asks a page every few hundred photos, and again before the links run out
const browseLimit = limit.limiter({ name: "customer-gallery", windowSeconds: 5 * 60, perIp: 300 })

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store") // the code, and links to the photographs
  next()
})

router.get("/", browseLimit, customerGallery.details)
router.get("/items", browseLimit, validateQuery(itemsQuery), customerGallery.items)

module.exports = router
