/** /api/v1/events: the HTTP side of services/events.js. */
const events = require("../services/events")
const { idParam } = require("../validators/events")
const { HttpError } = require("../utils/http-error")

const idOf = (req) => {
  const parsed = idParam.safeParse(req.params.id)
  if (!parsed.success) throw new HttpError(400, "That isn't an event id.", { code: "VALIDATION" })
  return parsed.data
}

const categoryIdOf = (req) => {
  const parsed = idParam.safeParse(req.params.categoryId)
  if (!parsed.success) throw new HttpError(404, "That category isn't part of this event.", { code: "NOT_FOUND" })
  return parsed.data
}

async function create(req, res) {
  const { event, code } = await events.create(req, req.body)
  res.status(201).json({ ok: true, message: `${event.name} created. Folder ${event.folder} is ready.`, event, code })
}

// Gallery codes are secrets: only roles with access_code.view get each event's code (assistants don't).
async function list(req, res) {
  res.json({ ok: true, events: await events.list({ withCodes: req.access.can("access_code.view") }) })
}

async function get(req, res) {
  res.json({ ok: true, event: await events.get(idOf(req), { withCode: req.access.can("access_code.view") }) })
}

async function rename(req, res) {
  const event = await events.rename(req, idOf(req), req.body.name)
  res.json({ ok: true, message: `Renamed to ${event.name}.`, event })
}

async function remove(req, res) {
  const out = await events.remove(req, idOf(req), req.body.confirmName)
  res.json({ ok: true, message: `${out.name} deleted, with its ${out.files} file${out.files === 1 ? "" : "s"}.`, ...out })
}

async function addCategory(req, res) {
  const out = await events.addCategory(req, idOf(req), req.body.name)
  res.status(out.created ? 201 : 200).json({ ok: true, ...out })
}

async function renameCategory(req, res) {
  res.json({ ok: true, event: await events.renameCategory(req, idOf(req), categoryIdOf(req), req.body.name) })
}

async function removeCategory(req, res) {
  res.json({ ok: true, event: await events.removeCategory(req, idOf(req), categoryIdOf(req)) })
}

module.exports = { create, list, get, rename, remove, addCategory, renameCategory, removeCategory }
