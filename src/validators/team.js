/**
 * Zod schemas for /api/v1/team: the panel's Photographers page
 * (Frontend/src/pages/photographer_panel/photographer_pages/Team.jsx).
 */
const { z } = require("zod")

const PAGE_SIZE = 10
// who the page lists
const TEAM_ROLES = ["photographer", "editor"]
// free: active, not on site, not off; onsite: out on a dispatched booking; off: off today
const STATES = ["all", "free", "onsite", "off"]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86_400_000

const clean = (v) => v.normalize("NFKC").replace(/\s+/g, " ").trim()
const isoDay = (d) => d.toISOString().slice(0, 10)

/**
 * "Today" as the panel's browser sees it ("2026-11-19"), so "Off today" follows the studio's clock
 * and not the server's (UTC). Within a day of the server's date; missing: the server's date.
 */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Send the day like 2026-11-19.")
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00Z`)
    return !Number.isNaN(t) && isoDay(new Date(t)) === v && Math.abs(t - Date.parse(`${isoDay(new Date())}T00:00:00Z`)) <= DAY_MS
  }, "That isn't today.")

const today = () => isoDay(new Date())

/* ---------- The cursor: where the next page starts ---------- */

/** Rows go by name, then id; a cursor is the last row's pair: base64url("<id><name>") (the id is 36 characters). */
const encodeCursor = (row) => Buffer.from(`${row.id}${row.full_name}`).toString("base64url")

function decodeCursor(value) {
  const raw = Buffer.from(value, "base64url").toString("utf8")
  const id = raw.slice(0, 36)
  const name = raw.slice(36)
  if (!UUID.test(id) || name.length < 1 || name.length > 100) return null
  return { id, name }
}

const BROKEN = "That page link is broken. Go back to the first page."
const cursor = z
  .string()
  .max(300, BROKEN)
  .regex(/^[A-Za-z0-9_-]+$/, BROKEN)
  .transform((v, ctx) => {
    const out = decodeCursor(v)
    if (!out) {
      ctx.addIssue({ code: "custom", message: BROKEN })
      return z.NEVER
    }
    return out
  })

/** GET / ?status=&role=&q=&day=&cursor= : one page of PAGE_SIZE people. */
const listQuery = z.object({
  status: z.enum(STATES, { error: "Show all, free, onsite or off." }).default("all"),
  role: z.enum(["all", ...TEAM_ROLES], { error: "Show all, photographer or editor." }).default("all"),
  // part of the name, email or mobile
  q: z
    .string()
    .max(80, "Search with at most 80 characters.")
    .optional()
    .transform((v) => (v && clean(v) ? clean(v) : undefined)),
  day: day.optional().transform((v) => v ?? today()),
  cursor: cursor.optional(),
})

/** GET /summary ?day= */
const summaryQuery = z.object({ day: day.optional().transform((v) => v ?? today()) })

/** PATCH /:id/off : { off, day } */
const offSchema = z.object({
  off: z.boolean({ error: "off is true or false." }),
  day: day.optional().transform((v) => v ?? today()),
})

const idParam = z.string().regex(UUID, "That isn't a team member.")

module.exports = { listQuery, summaryQuery, offSchema, idParam, day, today, encodeCursor, PAGE_SIZE, TEAM_ROLES }
