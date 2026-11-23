/**
 * Zod schemas for /api/v1/access: the panel's Access page, every account with its role and status
 * (Frontend/src/pages/photographer_panel/photographer_pages/Access.jsx). Studio leads only.
 */
const { z } = require("zod")
const { SYSTEM_ROLES } = require("../utils/roles")

const PAGE_SIZE = 25
const ROLES = SYSTEM_ROLES.map((r) => r.slug)
// pending: signed up, waiting for a studio lead to approve them
const STATUSES = ["pending", "active", "disabled"]
// what a studio lead can set: approving a sign-up makes it active; nothing goes back to pending
const SETTABLE = ["active", "disabled"]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// "2026-11-23 09:41:07.512": how the cursor carries created_at back to MySQL (UTC)
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/

const clean = (v) => v.normalize("NFKC").replace(/\s+/g, " ").trim()

/* ---------- The cursor: where the next page starts ---------- */

/** "2026-11-23T09:41:07.512Z" (or a Date) → "2026-11-23 09:41:07.512" */
const stamp = (at) => new Date(at).toISOString().replace("T", " ").replace("Z", "")

/** Newest first, then id; a cursor is the last row's pair: base64url("<id><created_at>"). */
const encodeCursor = (row) => Buffer.from(`${row.id}${stamp(row.created_at)}`).toString("base64url")

function decodeCursor(value) {
  const raw = Buffer.from(value, "base64url").toString("utf8")
  const id = raw.slice(0, 36)
  const at = raw.slice(36)
  return UUID.test(id) && STAMP.test(at) ? { id, at } : null
}

const BROKEN = "That page link is broken. Go back to the first page."
const cursor = z
  .string()
  .max(200, BROKEN)
  .regex(/^[A-Za-z0-9_-]+$/, BROKEN)
  .transform((v, ctx) => {
    const out = decodeCursor(v)
    if (!out) {
      ctx.addIssue({ code: "custom", message: BROKEN })
      return z.NEVER
    }
    return out
  })

/** GET / ?status=&role=&q=&cursor= : one page of PAGE_SIZE accounts, newest first. */
const listQuery = z.object({
  status: z.enum(["all", ...STATUSES], { error: `Show all, ${STATUSES.join(", ")}.` }).default("all"),
  role: z.enum(["all", ...ROLES], { error: `Show all or one of the roles: ${ROLES.join(", ")}.` }).default("all"),
  // part of the name, email or mobile
  q: z
    .string()
    .max(100, "Search with at most 100 characters.")
    .optional()
    .transform((v) => (v && clean(v) ? clean(v) : undefined)),
  cursor: cursor.optional(),
})

/** PATCH /:id : { role?, status? } */
const updateSchema = z
  .object({
    role: z.enum(ROLES, { error: `Choose one of the roles: ${ROLES.join(", ")}.` }).optional(),
    status: z.enum(SETTABLE, { error: "Status is active or disabled." }).optional(),
  })
  .refine((d) => d.role !== undefined || d.status !== undefined, { message: "Nothing to change." })

/** DELETE /:id : { confirmEmail }, the account's email typed again (checked by services/access.js) */
const removeSchema = z.object({
  confirmEmail: z
    .string({ error: "Type the account's email to delete it." })
    .max(254, "Type the account's email to delete it.")
    .transform((v) => v.trim()),
})

const idParam = z.string().regex(UUID, "That isn't an account.")

module.exports = { listQuery, updateSchema, removeSchema, idParam, encodeCursor, PAGE_SIZE, ROLES, STATUSES }
