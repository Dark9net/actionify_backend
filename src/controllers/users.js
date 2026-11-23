/** /api/v1/users: the HTTP side of services/users.js (studio leads). */
const users = require("../services/users")
const roles = require("../models/role")
const { idParam } = require("../validators/users")
const { HttpError } = require("../utils/http-error")

const idOf = (value) => {
  const parsed = idParam.safeParse(value)
  if (!parsed.success) throw new HttpError(400, "That isn't a user id.", { code: "VALIDATION" })
  return parsed.data
}

async function list(_req, res) {
  res.json({ ok: true, users: await users.list(), roles: await roles.list() })
}

async function update(req, res) {
  res.json({ ok: true, user: await users.update(req, idOf(req.params.id), req.body) })
}

async function auditLog(req, res) {
  const userId = req.query.userId ? idOf(String(req.query.userId)) : null
  const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 100))
  res.json({ ok: true, events: await users.auditLog({ userId, limit }) })
}

module.exports = { list, update, auditLog }
