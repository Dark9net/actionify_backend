/**
 * /api/v1/team: the panel's Photographers page (staff: Bearer + permission).
 *
 *   GET   /?status=&role=&q=&day=&cursor=   team.view   → { members (10), pageSize, nextCursor }
 *         status: all | free | onsite | off;  role: all | photographer | editor;
 *         q: part of the name, email or mobile;  day: today as the panel sees it ("2026-11-19");
 *         cursor: nextCursor from the page before (none: the first page)
 *   GET   /summary?day=                     team.view   → { summary: { all, photographers, editors,
 *                                                          free, onsite, off, inactive } }
 *   PATCH /:id/off                          team.view   { off, day } → { member }
 *                                                       yourself; anyone else needs team.manage
 */
const express = require("express")
const team = require("../controllers/team")
const { requireAuth } = require("../middleware/auth")
const { requirePerm, requireStaff } = require("../middleware/requireperm")
const limit = require("../middleware/rate-limit")
const { validate, validateQuery } = require("../middleware/validate")
const { listQuery, summaryQuery, offSchema } = require("../validators/team")

const router = express.Router()
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store") // names, emails and phone numbers
  next()
})
router.use(requireAuth, requireStaff)

router.get("/", requirePerm("team.view"), validateQuery(listQuery), team.list)
router.get("/summary", requirePerm("team.view"), validateQuery(summaryQuery), team.summary)
router.patch("/:id/off", limit.write, requirePerm("team.view"), validate(offSchema), team.setOff)

module.exports = router
