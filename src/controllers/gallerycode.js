/** /api/v1/gallery-codes: the HTTP side of services/gallerycode.js. */
const gallery = require("../services/gallerycode")
const { loadAccess } = require("../middleware/requireperm")
const { idParam } = require("../validators/gallerycode")
const { HttpError } = require("../utils/http-error")

const idOf = (req) => {
  const parsed = idParam.safeParse(req.params.id)
  if (!parsed.success) throw new HttpError(400, "That isn't a gallery code id.", { code: "VALIDATION" })
  return parsed.data
}

/* ---------- Guests and clients ---------- */

async function open(req, res) {
  res.json({ ok: true, ...(await gallery.openByCode(req, res, req.body)) })
}

async function session(req, res) {
  res.json({ ok: true, ...(await gallery.checkSession(req, res)) })
}

async function leave(req, res) {
  await gallery.leave(req, res)
  res.json({ ok: true })
}

async function mine(req, res) {
  res.json({ ok: true, galleries: await gallery.mine(req) })
}

async function enter(req, res) {
  const { can } = await loadAccess(req)
  res.json({ ok: true, ...(await gallery.enter(req, res, idOf(req), { canPreview: can("access_code.view") })) })
}

module.exports = { open, session, leave, mine, enter }
