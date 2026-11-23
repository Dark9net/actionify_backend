/**
 * /api/v1/events/:eventId/media (staff: Bearer + permission; mounted by routes/events.js)
 *
 * The photographs and videos of one event. Files go from the browser straight to R2 through links
 * made here; this API never carries the files themselves.
 *
 *   GET   /                       event.view     ?category=all|none|<id>&kind=all|photo|video|audio|graphic|model&cursor=&limit=
 *                                                → { media, nextCursor, pageSize }  (by name; links last 15+ min)
 *   GET   /:mediaId               event.view     ?download=1 → { media }  (fresh links; downloadUrl with ?download)
 *   POST  /                       photo.upload   { files: [{ name, size, categoryId?, lastModified?, previewSize? }] } (≤ 25)
 *                                                → 201 { uploads: [{ id, name, contentType, url, parts, resumed, previewUrl }] }
 *   GET   /:mediaId/parts         photo.upload   → { partSize, partCount, done: [numbers], restarted? }  (a file in parts)
 *   POST  /:mediaId/parts         photo.upload   { parts: [numbers] } (≤ 100) → { parts: [{ number, size, url }] }
 *   POST  /:mediaId/complete      photo.upload   { width?, height?, durationMs? } → { media }
 *   POST  /:mediaId/abort         photo.upload   → { removed }   (only an upload that didn't finish)
 *   PATCH /                       photo.manage   { ids, categoryId | null } → { moved }
 *   POST  /remove                 photo.manage   { ids } → { removed }   (deleted from R2 too)
 *
 * The browser PUTs each file to its `url` with the Content-Type given, then its preview (a JPEG) to
 * `previewUrl`, then calls /complete. A file over 64 MB has no `url` but `parts: { size, count }`: each
 * part is PUT to a link from POST /parts, a failed part is sent again on its own, and GET /parts says
 * which parts R2 already has, so a stopped upload carries on (sending the same file again finds it:
 * `resumed`). /complete then has R2 join the parts (409 UPLOAD_INCOMPLETE { missing } names any not there), which reads R2's copy back and checks it is really the format its name
 * says (utils/filecheck.js). Errors: 400 VALIDATION { field, errors }, 404 NOT_FOUND (also a
 * file of another event), 409 UPLOAD_MISSING / UPLOAD_INCOMPLETE / NOT_IN_PARTS / ALREADY_UPLOADED, 422 FILE_BLOCKED (removed from R2), 503 STORAGE_OFF.
 */
const express = require("express")
const media = require("../controllers/media")
const { requirePerm } = require("../middleware/requireperm")
const limit = require("../middleware/rate-limit")
const { validate, validateQuery } = require("../middleware/validate")
const { listQuery, getQuery, startSchema, completeSchema, partsSchema, moveSchema, removeSchema } = require("../validators/media")

// mergeParams: :eventId comes from the events router this is mounted on
const router = express.Router({ mergeParams: true })

router.get("/", requirePerm("event.view"), validateQuery(listQuery), media.list)
router.post("/", limit.upload, requirePerm("photo.upload"), validate(startSchema), media.start)
router.patch("/", limit.write, requirePerm("photo.manage"), validate(moveSchema), media.move)
router.post("/remove", limit.write, requirePerm("photo.manage"), validate(removeSchema), media.remove)
router.get("/:mediaId", requirePerm("event.view"), validateQuery(getQuery), media.get)
router.get("/:mediaId/parts", limit.upload, requirePerm("photo.upload"), media.partsStatus)
router.post("/:mediaId/parts", limit.upload, requirePerm("photo.upload"), validate(partsSchema), media.signParts)
router.post("/:mediaId/complete", limit.upload, requirePerm("photo.upload"), validate(completeSchema), media.complete)
router.post("/:mediaId/abort", limit.upload, requirePerm("photo.upload"), media.abort)

module.exports = router
