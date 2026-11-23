/** /api/v1/bookings: the HTTP side of services/bookings.js. */
const bookings = require("../services/bookings")
const { idParam } = require("../validators/bookings")
const { HttpError } = require("../utils/http-error")

const idOf = (req) => {
  const parsed = idParam.safeParse(req.params.id)
  if (!parsed.success) throw new HttpError(400, "That isn't a booking id.", { code: "VALIDATION" })
  return parsed.data
}

async function request(req, res) {
  const booking = await bookings.request(req, req.body)
  res.status(201).json({ ok: true, message: `Booking request ${booking.ref} sent. We will reply by email.`, booking })
}

async function manual(req, res) {
  res.status(201).json({ ok: true, booking: await bookings.manual(req, req.body) })
}

async function list(req, res) {
  res.json({ ok: true, ...(await bookings.list(req.valid)) })
}

async function summary(_req, res) {
  res.json({ ok: true, summary: await bookings.summary() })
}

async function crew(req, res) {
  res.json({ ok: true, crew: await bookings.crew(req.valid) })
}

async function update(req, res) {
  res.json({ ok: true, ...(await bookings.update(req, idOf(req), req.body)) })
}

module.exports = { request, manual, list, summary, crew, update }
