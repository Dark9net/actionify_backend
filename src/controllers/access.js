/** /api/v1/access: the HTTP side of services/access.js (the panel's Access page, studio leads). */
const access = require("../services/access")
const { idParam } = require("../validators/access")
const { HttpError } = require("../utils/http-error")

const idOf = (req) => {
  const parsed = idParam.safeParse(req.params.id)
  if (!parsed.success) throw new HttpError(400, "That isn't an account.", { code: "VALIDATION" })
  return parsed.data
}

async function list(req, res) {
  res.json({ ok: true, ...(await access.list(req, req.valid)) })
}

async function summary(req, res) {
  res.json({ ok: true, ...(await access.summary(req)) })
}

async function update(req, res) {
  res.json({ ok: true, user: await access.update(req, idOf(req), req.body) })
}

async function remove(req, res) {
  res.json({ ok: true, deleted: await access.remove(req, idOf(req), req.body) })
}

module.exports = { list, summary, update, remove }
