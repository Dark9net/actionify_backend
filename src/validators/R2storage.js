/** Zod schemas for /api/v1/storage (routes/R2storage.js). */
const { z } = require("zod")

/** GET /usage?refresh=1 asks Cloudflare again instead of using the kept answer. */
const usageQuery = z.object({
  refresh: z
    .enum(["0", "1", "true", "false"], { error: "refresh is 1 or 0." })
    .optional()
    .transform((v) => v === "1" || v === "true"),
})

module.exports = { usageQuery }
