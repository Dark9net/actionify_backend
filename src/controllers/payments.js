/** /api/v1/payments: the HTTP side of services/payments.js. */
const payments = require("../services/payments")
const { idParam } = require("../validators/payments")
const { HttpError } = require("../utils/http-error")

const paymentIdOf = (req) => {
  const parsed = idParam("payment").safeParse(req.params.paymentId)
  if (!parsed.success) throw new HttpError(400, "That isn't a payment id.", { code: "VALIDATION" })
  return parsed.data
}

async function list(req, res) {
  res.json({ ok: true, ...(await payments.list(req.valid)) })
}

async function summary(req, res) {
  res.json({ ok: true, summary: await payments.summary(req.valid) })
}

async function bookings(req, res) {
  res.json({ ok: true, bookings: await payments.bookings(req.valid) })
}

async function record(req, res) {
  res.status(201).json({ ok: true, ...(await payments.record(req, req.body)) })
}

async function setStatus(req, res) {
  res.json({ ok: true, ...(await payments.setStatus(req, paymentIdOf(req), req.body)) })
}

module.exports = { list, summary, bookings, record, setStatus }
