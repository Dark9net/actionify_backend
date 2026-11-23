/**
 * /api/v1/storage (staff: Bearer + storage.view)
 *
 *   GET /usage            → { usage }   what Cloudflare R2 holds and has served this billing month,
 *                                       against what the plan includes (services/R2storage.js)
 *       ?refresh=1        asks Cloudflare again (at most once a minute) instead of the kept answer
 *
 * usage:
 *   source            "cloudflare" (GraphQL Analytics, needs CLOUDFLARE_API_TOKEN) or "bucket" (listed)
 *   bucket, plan      { name, storage, classA, classB, billingDay }
 *   period            { start, end } of the billing month (ISO)
 *   storage           { used, included, remaining, over, objects, pendingUploads, measuredAt,
 *                       billed: { byteMonths, projected } | null, bucket: { name, used, objects } }
 *   classA, classB    { used, included, remaining, over, bucket } | null without the token
 *   freeOperations, notCharged, otherOperations: [{ action, requests }]
 *   partial           some of the month is missing (row limit, or a very large bucket)
 *   stale, error      Cloudflare couldn't be asked just now: this is the last answer, and why
 *   checkedAt, note
 *
 * Errors: 503 R2_DISABLED (no R2 keys), 502 R2_USAGE_UNAVAILABLE (Cloudflare refused or didn't answer,
 * with nothing kept to fall back on).
 */
const express = require("express")
const r2storage = require("../controllers/R2storage")
const { requireAuth } = require("../middleware/auth")
const { requirePerm, requireStaff } = require("../middleware/requireperm")
const { validateQuery } = require("../middleware/validate")
const { usageQuery } = require("../validators/R2storage")

const router = express.Router()
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store")
  next()
})
router.use(requireAuth, requireStaff)

router.get("/usage", requirePerm("storage.view"), validateQuery(usageQuery), r2storage.usage)

module.exports = router
