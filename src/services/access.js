/**
 * The Access page (routes/access.js): every account in users with its role, status, email and
 * mobile, for the studio lead, who can change an account's role, approve or disable it, or delete it.
 *
 * Rules, so nobody can lock the studio out or overrule another lead:
 * - you can't change or delete your own account;
 * - you can only change or delete accounts ranked below yours (utils/roles.js rank), so one studio
 *   lead can't demote, disable or delete another;
 * - you can give a role up to your own rank (making someone a studio lead is allowed, and from then
 *   on their account is theirs and the other leads' to keep).
 * Every change takes effect on the account's next request: a new role drops the cached sessions, and
 * disabling or deleting an account ends its sessions at once.
 */
const users = require("../models/user")
const access = require("../models/access")
const session = require("../utils/session")
const mail = require("../utils/mailer")
const { photoUrl } = require("./profile-photo")
const { r2, removeObject } = require("../config/r2config")
const { SYSTEM_ROLES, roleOf } = require("../utils/roles")
const { encodeCursor, PAGE_SIZE, ROLES, STATUSES } = require("../validators/access")
const { audit } = require("../utils/audit")
const { HttpError } = require("../utils/http-error")

const rankOf = (slug) => roleOf(slug)?.rank ?? 0

/** Why the signed-in lead can't change this account, or null: "self" | "rank". */
function lockOf(req, row) {
  if (row.id === req.user.id) return "self"
  if (Number(row.role_rank) >= rankOf(req.user.role)) return "rank"
  return null
}

const LOCKED = {
  self: "You can't change or delete your own account. Another studio lead can.",
  rank: "Studio leads can't change or delete each other's accounts.",
}

async function toPublic(req, row) {
  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    mobile: row.mobile, // "+9779812345678", or null
    photo: await photoUrl(row.photo_key), // staff set one in Settings; null: initials
    role: { slug: row.role_slug, name: row.role_name, isStaff: Boolean(row.role_is_staff) },
    status: row.status, // pending | active | disabled
    emailVerified: Boolean(row.email_verified_at),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    isMe: row.id === req.user.id,
    locked: lockOf(req, row), // null: the lead can change it
  }
}

/** One page: { users, pageSize, nextCursor }. */
async function list(req, { status, role, q, cursor }) {
  const rows = await access.page({
    status: status === "all" ? undefined : status,
    role: role === "all" ? undefined : role,
    text: q,
    cursor,
    limit: PAGE_SIZE + 1,
  })
  const more = rows.length > PAGE_SIZE
  const shown = rows.slice(0, PAGE_SIZE)
  return {
    users: await Promise.all(shown.map((row) => toPublic(req, row))),
    pageSize: PAGE_SIZE,
    nextCursor: more ? encodeCursor(shown[shown.length - 1]) : null,
  }
}

/**
 * The filters' counts and the roles to choose from:
 * { summary: { all, staff, pending, active, disabled, roles: { client: n, … } }, roles: [{ slug, name, description, isStaff, assignable }] }
 */
async function summary(req) {
  const out = { all: 0, staff: 0, ...Object.fromEntries(STATUSES.map((s) => [s, 0])), roles: Object.fromEntries(ROLES.map((r) => [r, 0])) }
  for (const { status, role, n } of await access.counts()) {
    out.all += n
    if (status in out) out[status] += n
    if (role in out.roles) out.roles[role] += n
    if (roleOf(role)?.isStaff) out.staff += n
  }
  const mine = rankOf(req.user.role)
  const roles = SYSTEM_ROLES.map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    isStaff: r.isStaff,
    assignable: r.rank <= mine,
  }))
  return { summary: out, roles }
}

/** The account, or 404; then 403 when the lead may not touch it. */
async function changeable(req, id) {
  const target = await users.findById(id)
  if (!target) throw new HttpError(404, "That account doesn't exist any more.", { code: "NOT_FOUND" })
  const lock = lockOf(req, target)
  if (lock) throw new HttpError(403, LOCKED[lock], { code: "FORBIDDEN" })
  return target
}

/** PATCH /:id : a new role, approve (active) or disable. → the account as listed */
async function update(req, id, { role, status }) {
  const target = await changeable(req, id)
  if (role && rankOf(role) > rankOf(req.user.role)) {
    throw new HttpError(403, "You can't give a role above your own.", { code: "FORBIDDEN" })
  }

  if (role && role !== target.role_slug) {
    await users.setRole(id, role)
    await session.forgetCachedSessions(id)
    audit(req, "role_change", { userId: id, detail: { from: target.role_slug, to: role, by: req.user.id } })
  }
  if (status && status !== target.status) {
    await users.setStatus(id, status)
    if (status === "disabled") await session.revokeAllSessions(id)
    // a new sign-up approved: tell them they can sign in
    if (target.status === "pending" && status === "active") {
      void mail.deliver(mail.sendAccountApprovedEmail({ to: target.email, name: target.full_name }))
    }
    const event = status === "disabled" ? "account_disabled" : target.status === "pending" ? "account_approved" : "account_enabled"
    audit(req, event, { userId: id, detail: { by: req.user.id } })
  }
  return toPublic(req, await users.findById(id))
}

/**
 * DELETE /:id : the account, for good, once its email is typed again. Its sessions end first (so a
 * token still in a browser stops working at once), then the row goes with everything that belongs
 * only to it (models/access.js remove), then its profile photo on R2. → { id, name, email }
 */
async function remove(req, id, { confirmEmail }) {
  const target = await changeable(req, id)
  if (confirmEmail.toLowerCase() !== target.email.toLowerCase()) {
    const message = "That isn't this account's email. Type it exactly as shown."
    throw new HttpError(400, message, { code: "VALIDATION", details: { field: "confirmEmail", errors: { confirmEmail: message } } })
  }
  const payments = await access.paymentCount(id)
  if (payments) {
    throw new HttpError(409, "This account has package payments on record, which the studio has to keep. Disable it instead.", {
      code: "HAS_PAYMENTS",
      details: { payments },
    })
  }

  await session.revokeAllSessions(id)
  let deleted
  try {
    deleted = await access.remove(id)
  } catch (err) {
    // a payment recorded since the check above (hire_payments: ON DELETE RESTRICT)
    if (err.errno === 1451) {
      throw new HttpError(409, "This account has records the studio has to keep. Disable it instead.", { code: "HAS_PAYMENTS" })
    }
    throw err
  }
  if (!deleted) throw new HttpError(404, "That account doesn't exist any more.", { code: "NOT_FOUND" })

  if (target.photo_key && r2) {
    removeObject(target.photo_key).catch((err) => console.error(`Couldn't remove the profile photo ${target.photo_key}:`, err.message))
  }
  // the row is gone, so the log keeps the email and who it was (user_id would point at nothing)
  audit(req, "account_deleted", {
    userId: null,
    email: target.email,
    detail: { id, name: target.full_name, role: target.role_slug, by: req.user.id },
  })
  return { id, name: target.full_name, email: target.email }
}

module.exports = { list, summary, update, remove }
