/**
 * Zod schema for /api/v1/overview: the panel's Overview page.
 *
 *   GET /?offset=345   the browser's time zone, minutes east of UTC (Nepal: 345), so "today" and the
 *                      14 days of the uploads chart are the studio's own days, not UTC's.
 */
const { z } = require("zod")

const overviewQuery = z.object({
  offset: z
    .string()
    .regex(/^-?\d{1,3}$/, "Send the time zone as minutes east of UTC, like 345.")
    .transform(Number)
    .refine((n) => n >= -720 && n <= 840, "Send the time zone as minutes east of UTC, like 345.")
    .optional()
    .transform((n) => n ?? 0),
})

module.exports = { overviewQuery }
