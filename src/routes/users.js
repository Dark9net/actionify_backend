/**
 * /api/v1/users: accounts and roles, for the studio lead (Authorization: Bearer).
 *
 *   GET   /         users.view      → { users, roles }
 *   PATCH /:id      users.manage    { role?, status? } → { user }   (rank rules: services/users.js)
 *   GET   /audit    audit.view      ?userId=&limit=    → { events }
 */
const express = require("express")
const users = require("../controllers/users")
const { requireAuth } = require("../middleware/auth")
const { requirePerm, requireStaff } = require("../middleware/requireperm")
const limit = require("../middleware/rate-limit")
const { validate } = require("../middleware/validate")
const { updateUserSchema } = require("../validators/users")

const router = express.Router()
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store")
  next()
})
router.use(requireAuth, requireStaff)

router.get("/", requirePerm("users.view"), users.list)
router.get("/audit", requirePerm("audit.view"), users.auditLog)
router.patch("/:id", limit.write, requirePerm("users.manage"), validate(updateUserSchema), users.update)

module.exports = router
