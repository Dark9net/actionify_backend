/**
 * /api/v1/access-codes: the panel's Access codes page (staff: Bearer + permission).
 *
 *   GET   /?status=&q=&cursor=   access_code.view     → { codes (10), pageSize, nextCursor }
 *         status: all | active | expired | revoked; q: a whole code, or part of an event or label;
 *         cursor: nextCursor from the page before (none: the first page)
 *   GET   /summary               access_code.view     → { summary: { all, active, expired, revoked,
 *                                                         endingSoon, opens, activeEvents } }
 *   GET   /events                access_code.view     → { events: [{ id, name, date, codeId }] }  (the form's list;
 *                                                       codeId: the event has its code already)
 *   POST  /                      access_code.manage   { eventId, label?, maxUsers?, days?, code? } → 201 { code }
 *                                                     one code per event: 409 EVENT_HAS_CODE when it has one
 *   POST  /:id/regenerate        access_code.manage   { code? } → { code }  a new code in place of the old one
 *   PATCH /:id                   access_code.manage   { revoked?, extendDays?, maxUsers? } → { code }
 */
const express = require("express")
const accessCodes = require("../controllers/accesscode")
const { requireAuth } = require("../middleware/auth")
const { requirePerm, requireStaff } = require("../middleware/requireperm")
const limit = require("../middleware/rate-limit")
const { validate, validateQuery } = require("../middleware/validate")
const { listQuery, createSchema, updateSchema, regenerateSchema } = require("../validators/accesscode")

const router = express.Router()
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store") // codes are secrets: never kept by the browser or a proxy
  next()
})
router.use(requireAuth, requireStaff)

router.get("/", requirePerm("access_code.view"), validateQuery(listQuery), accessCodes.list)
router.get("/summary", requirePerm("access_code.view"), accessCodes.summary)
router.get("/events", requirePerm("access_code.view"), accessCodes.events)
router.post("/", limit.write, requirePerm("access_code.manage"), validate(createSchema), accessCodes.create)
router.post("/:id/regenerate", limit.write, requirePerm("access_code.manage"), validate(regenerateSchema), accessCodes.regenerate)
router.patch("/:id", limit.write, requirePerm("access_code.manage"), validate(updateSchema), accessCodes.update)

module.exports = router
