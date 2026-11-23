/**
 * Accounts and roles, for whoever holds users.view / users.manage (the studio lead).
 *
 * Rules, so nobody can raise themselves or overrule someone above them:
 * - you can't change your own role or status;
 * - you can only change someone ranked below you (utils/roles.js rank);
 * - you can only give a role up to your own rank.
 * A new role or a disabled account takes effect on the next request: cached sessions are
 * dropped, and a disabled account's sessions are ended.
 */
const users = require("../models/user")
const events = require("../models/auth-event")
const session = require("../utils/session")
const mail = require("../utils/mailer")
const { roleOf } = require("../utils/roles")
const { audit } = require("../utils/audit")
const { HttpError } = require("../utils/http-error")

const toPublic = (row) => ({
  id: row.id,
  name: row.full_name,
  email: row.email,
  role: { slug: row.role_slug, name: row.role_name, isStaff: Boolean(row.role_is_staff) },
  status: row.status,
  emailVerified: Boolean(row.email_verified_at),
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
})

async function list() {
  return (await users.list()).map(toPublic)
}

async function update(req, id, { role, status }) {
  if (id === req.user.id) throw new HttpError(403, "You can't change your own role or status.", { code: "FORBIDDEN" })
  const target = await users.findById(id)
  if (!target) throw new HttpError(404, "That account doesn't exist.", { code: "NOT_FOUND" })

  const mine = roleOf(req.user.role)?.rank ?? 0
  if (target.role_rank >= mine) {
    throw new HttpError(403, "You can only change accounts ranked below yours.", { code: "FORBIDDEN" })
  }
  if (role && (roleOf(role)?.rank ?? Infinity) > mine) {
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
    // A new sign-up approved: tell them they can sign in.
    if (target.status === "pending" && status === "active") {
      void mail.deliver(mail.sendAccountApprovedEmail({ to: target.email, name: target.full_name }))
    }
    const event = status === "disabled" ? "account_disabled" : target.status === "pending" ? "account_approved" : "account_enabled"
    audit(req, event, { userId: id, detail: { by: req.user.id } })
  }
  return toPublic(await users.findById(id))
}

/** The security log, newest first. */
async function auditLog({ userId, limit }) {
  return (await events.list({ userId, limit })).map((e) => ({
    id: String(e.id),
    at: e.at,
    event: e.event,
    userId: e.user_id,
    name: e.full_name,
    email: e.email,
    ip: e.ip,
    userAgent: e.user_agent,
    detail: typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail,
  }))
}

module.exports = { list, update, auditLog }
