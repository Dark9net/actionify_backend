/** /api/v1/share-gallery: the HTTP side of services/sharegallery.js. */
const shareGallery = require("../services/sharegallery")
const { eventParam } = require("../validators/sharegallery")
const { HttpError } = require("../utils/http-error")

const eventOf = (req) => {
  const parsed = eventParam.safeParse(req.params.eventId)
  if (!parsed.success) throw new HttpError(400, "That isn't an event.", { code: "VALIDATION" })
  return parsed.data
}

/** GET /:eventId → { event, gallery, client } */
async function details(req, res) {
  res.json({ ok: true, ...(await shareGallery.details(eventOf(req))) })
}

/** POST /:eventId/email → { to, toClient, printed } */
async function sendEmail(req, res) {
  res.json({ ok: true, ...(await shareGallery.sendEmail(req, eventOf(req), req.body)) })
}

module.exports = { details, sendEmail }
