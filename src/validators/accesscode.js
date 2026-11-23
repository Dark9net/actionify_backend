/**
 * Zod schemas for /api/v1/access-codes: the panel's Access codes page
 * (Frontend/src/pages/photographer_panel/photographer_pages/AccessCodes.jsx).
 */
const { z } = require("zod")
const { code } = require("./gallerycode")

const PAGE_SIZE = 10
const STATUSES = ["all", "active", "expired", "revoked"]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/* ---------- The cursor: where the next page starts ---------- */

/**
 * Rows go newest first by (created_at, id). A cursor is the last row's pair, opaque to the
 * panel: base64url("<created_at in ms>.<id>").
 */
const encodeCursor = (row) => Buffer.from(`${new Date(row.created_at).getTime()}.${row.id}`).toString("base64url")

function decodeCursor(value) {
  const raw = Buffer.from(value, "base64url").toString("utf8")
  const dot = raw.indexOf(".")
  const ms = Number(raw.slice(0, dot))
  const id = raw.slice(dot + 1)
  if (dot < 1 || !Number.isSafeInteger(ms) || ms < 0 || !UUID.test(id)) return null
  return { createdAt: new Date(ms), id }
}

const cursor = z
  .string()
  .max(120, "That page link is broken. Go back to the first page.")
  .regex(/^[A-Za-z0-9_-]+$/, "That page link is broken. Go back to the first page.")
  .transform((v, ctx) => {
    const out = decodeCursor(v)
    if (!out) {
      ctx.addIssue({ code: "custom", message: "That page link is broken. Go back to the first page." })
      return z.NEVER
    }
    return out
  })

const clean = (v) => v.normalize("NFKC").replace(/\s+/g, " ").trim()
const SAFE = /^[^\p{Cc}\p{Cf}<>]+$/u

/* ---------- Schemas, one per route ---------- */

/** GET / ?status=&q=&cursor= : one page of PAGE_SIZE codes. */
const listQuery = z.object({
  status: z.enum(STATUSES, { error: "Show all, active, expired or revoked codes." }).default("all"),
  // a whole code (found by its hash), or part of an event name or label
  q: z
    .string()
    .max(80, "Search with at most 80 characters.")
    .optional()
    .transform((v) => (v && clean(v) ? clean(v) : undefined)),
  cursor: cursor.optional(),
})

/** POST / : a code from the New access code form. Without `code` one is made up (fully random). */
const createSchema = z.object({
  eventId: z.string({ error: "Choose the event this code opens." }).uuid("Choose the event this code opens."),
  label: z
    .string()
    .nullish()
    .transform((v) => (v && clean(v) ? clean(v) : undefined))
    .pipe(z.string().max(40, "Keep who it is for under 40 characters.").regex(SAFE, "Use letters, numbers and simple punctuation.").optional()),
  // how many browsers may view the gallery at the same time; missing or null: no limit
  maxUsers: z.number({ error: "The limit must be a number." }).int("The limit must be a whole number.").min(1, "Allow at least 1 viewer.").max(10000, "At most 10,000 viewers.").nullish(),
  // 0 or missing: no end date (until revoked)
  days: z.number({ error: "Days must be a number." }).int().min(0).max(730, "A code can last at most two years.").optional(),
  code: code.optional(),
})

/** PATCH /:id : revoke or restore, extend, change the viewer limit. */
const updateSchema = z
  .object({
    revoked: z.boolean().optional(),
    extendDays: z.number().int().min(1).max(730).optional(),
    // null: no limit
    maxUsers: z.number().int().min(1).max(10000).nullable().optional(),
  })
  .refine((d) => d.revoked !== undefined || d.extendDays !== undefined || d.maxUsers !== undefined, { message: "Nothing to change." })

/** POST /:id/regenerate : optionally the new code itself (else one is made up). */
const regenerateSchema = z.object({ code: code.optional() })

const idParam = z.string().uuid("That isn't an access code id.")

module.exports = { listQuery, createSchema, updateSchema, regenerateSchema, idParam, encodeCursor, PAGE_SIZE, STATUSES }
