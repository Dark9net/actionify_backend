/** /api/v1/access-codes: the HTTP side of services/accesscode.js. */
const accessCodes = require("../services/accesscode")
const { idParam } = require("../validators/accesscode")
const { HttpError } = require("../utils/http-error")

const idOf = (req) => {
  const parsed = idParam.safeParse(req.params.id)
  if (!parsed.success) throw new HttpError(400, "That isn't an access code id.", { code: "VALIDATION" })
  return parsed.data
}

async function list(req, res) {
  res.json({ ok: true, ...(await accessCodes.list(req.valid)) })
}

async function summary(_req, res) {
  res.json({ ok: true, summary: await accessCodes.summary() })
}

async function events(_req, res) {
  res.json({ ok: true, events: await accessCodes.events() })
}

async function create(req, res) {
  res.status(201).json({ ok: true, code: await accessCodes.create(req, req.body) })
}

async function update(req, res) {
  res.json({ ok: true, code: await accessCodes.update(req, idOf(req), req.body) })
}

async function regenerate(req, res) {
  res.json({ ok: true, code: await accessCodes.regenerate(req, idOf(req), req.body) })
}

module.exports = { list, summary, events, create, update, regenerate }
