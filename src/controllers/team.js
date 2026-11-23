/** /api/v1/team: the HTTP side of services/team.js. */
const team = require("../services/team")
const { idParam } = require("../validators/team")
const { HttpError } = require("../utils/http-error")

const idOf = (req) => {
  const parsed = idParam.safeParse(req.params.id)
  if (!parsed.success) throw new HttpError(400, "That isn't a team member.", { code: "VALIDATION" })
  return parsed.data
}

async function list(req, res) {
  res.json({ ok: true, ...(await team.list(req.valid)) })
}

async function summary(req, res) {
  res.json({ ok: true, summary: await team.summary(req.valid) })
}

async function setOff(req, res) {
  res.json({ ok: true, member: await team.setOff(req, idOf(req), req.body) })
}

module.exports = { list, summary, setOff }
