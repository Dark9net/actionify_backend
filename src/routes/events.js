/**
 * /api/v1/events (staff: Bearer + permission)
 *
 *   GET    /                               event.view     → { events }  (each with stats and covers)
 *   GET    /:id                            event.view     → { event }   (categories with their file counts)
 *   POST   /                               event.manage   { name, date: "YYYY-MM-DD", kind, venue?, bookingId?, clientId?,
 *                                                           categories?: string[] | "a, b, c", withCode? = true }
 *                                                        → 201 { event, code }   (code: the guest gallery code, or null)
 *   PATCH  /:id                            event.manage   { name } → { event }
 *   DELETE /:id                            event.delete   { confirmName } → { name, files, bytes }
 *                                                        (the name typed again; every file goes from R2 too,
 *                                                         with the categories and gallery codes. Editors,
 *                                                         photographers and the studio lead)
 *   POST   /:id/categories                 photo.upload or photo.manage   { name } → 201 { category, event }
 *                                                        (200, created: false, when one with that folder exists)
 *   PATCH  /:id/categories/:categoryId     photo.manage   { name } → { event }
 *   DELETE /:id/categories/:categoryId     photo.manage   → { event }  (its files become Uncategorised)
 *
 *   /:eventId/media/…                      the event's photographs and videos: routes/media.js
 *
 * Errors: 400 VALIDATION / NAME_MISMATCH and 409 EVENT_NAME_TAKEN / BOOKING_HAS_EVENT / CATEGORY_NAME_TAKEN
 * carry { field, errors }; deleting: 502 STORAGE_ERROR (R2 kept some files: the event stays), 503 STORAGE_OFF.
 */
const express = require("express")
const events = require("../controllers/events")
const { requireAuth } = require("../middleware/auth")
const { requireAnyPerm, requirePerm, requireStaff } = require("../middleware/requireperm")
const limit = require("../middleware/rate-limit")
const { validate } = require("../middleware/validate")
const { createSchema, renameSchema, categorySchema, removeSchema } = require("../validators/events")

const router = express.Router()
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store")
  next()
})
router.use(requireAuth, requireStaff)

router.get("/", requirePerm("event.view"), events.list)
router.post("/", limit.write, requirePerm("event.manage"), validate(createSchema), events.create)
router.use("/:eventId/media", require("./media"))
router.get("/:id", requirePerm("event.view"), events.get)
router.patch("/:id", limit.write, requirePerm("event.manage"), validate(renameSchema), events.rename)
router.delete("/:id", limit.write, requirePerm("event.delete"), validate(removeSchema), events.remove)
router.post(
  "/:id/categories",
  limit.write,
  requireAnyPerm("photo.upload", "photo.manage"),
  validate(categorySchema),
  events.addCategory,
)
router.patch("/:id/categories/:categoryId", limit.write, requirePerm("photo.manage"), validate(categorySchema), events.renameCategory)
router.delete("/:id/categories/:categoryId", limit.write, requirePerm("photo.manage"), events.removeCategory)

module.exports = router
