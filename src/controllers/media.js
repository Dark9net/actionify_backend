/** /api/v1/events/:eventId/media: the HTTP side of services/media.js. */
const media = require("../services/media")
const { idParam } = require("../validators/media")
const { HttpError } = require("../utils/http-error")

/** The event in the path, and the file when there is one; both must be ids. */
function ids(req) {
  if (!idParam.safeParse(req.params.eventId).success) throw new HttpError(400, "That isn't an event id.", { code: "VALIDATION" })
  if (req.params.mediaId !== undefined && !idParam.safeParse(req.params.mediaId).success) {
    throw new HttpError(404, "That file isn't in this event.", { code: "NOT_FOUND" })
  }
  return { eventId: req.params.eventId, mediaId: req.params.mediaId }
}

async function list(req, res) {
  const { eventId } = ids(req)
  res.json({ ok: true, ...(await media.list(eventId, req.valid)) })
}

async function get(req, res) {
  const { eventId, mediaId } = ids(req)
  res.json({ ok: true, media: await media.get(eventId, mediaId, req.valid) })
}

async function start(req, res) {
  const { eventId } = ids(req)
  res.status(201).json({ ok: true, uploads: await media.start(req, eventId, req.body.files) })
}

async function signParts(req, res) {
  const { eventId, mediaId } = ids(req)
  res.json({ ok: true, parts: await media.signParts(req, eventId, mediaId, req.body.parts) })
}

async function partsStatus(req, res) {
  const { eventId, mediaId } = ids(req)
  res.json({ ok: true, ...(await media.partsStatus(req, eventId, mediaId)) })
}

async function complete(req, res) {
  const { eventId, mediaId } = ids(req)
  res.json({ ok: true, media: await media.complete(req, eventId, mediaId, req.body) })
}

async function abort(req, res) {
  const { eventId, mediaId } = ids(req)
  res.json({ ok: true, ...(await media.abort(req, eventId, mediaId)) })
}

async function move(req, res) {
  const { eventId } = ids(req)
  const out = await media.move(req, eventId, req.body.ids, req.body.categoryId)
  res.json({ ok: true, message: `${out.moved} moved.`, ...out })
}

async function remove(req, res) {
  const { eventId } = ids(req)
  const out = await media.remove(req, eventId, req.body.ids)
  res.json({ ok: true, message: `${out.removed} deleted.`, ...out })
}

module.exports = { list, get, start, signParts, partsStatus, complete, abort, move, remove }
