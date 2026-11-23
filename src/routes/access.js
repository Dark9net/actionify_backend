/**
 * /api/v1/access: the panel's Access page. Every account, its role and status; studio leads only
 * (by role, not permission: Bearer + panel.access + role studio_lead). Anyone else: 403 FORBIDDEN.
 *
 *   GET    /?status=&role=&q=&cursor=   → { users (25), pageSize, nextCursor }
 *          status: all | pending | active | disabled;  role: all | client | assistant | editor |
 *          photographer | studio_lead;  q: part of the name, email or mobile;
 *          cursor: nextCursor from the page before (none: the first page). Newest first.
 *   GET    /summary                     → { summary: { all, staff, pending, active, disabled, roles }, roles }
 *   PATCH  /:id    { role?, status? }   → { user }        status: active (approve, enable) | disabled
 *   DELETE /:id    { confirmEmail }     → { deleted: { id, name, email } }
 *
 * Not your own account, and not another studio lead's (services/access.js).
 */
const express = require("express")
const access = require("../controllers/access")
const { requireAuth } = require("../middleware/auth")
const { requireRole, requireStaff } = require("../middleware/requireperm")
const limit = require("../middleware/rate-limit")
const { validate, validateQuery } = require("../middleware/validate")
const { listQuery, updateSchema, removeSchema } = require("../validators/access")

const router = express.Router()
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store") // names, emails and phone numbers
  next()
})
router.use(requireAuth, requireStaff, requireRole("studio_lead"))

router.get("/", validateQuery(listQuery), access.list)
router.get("/summary", access.summary)
router.patch("/:id", limit.write, validate(updateSchema), access.update)
router.delete("/:id", limit.write, validate(removeSchema), access.remove)

module.exports = router
