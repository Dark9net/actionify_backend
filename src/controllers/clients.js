/** /api/v1/clients: the HTTP side of services/clients.js. */
const clients = require("../services/clients")
const { idParam } = require("../validators/clients")
const { HttpError } = require("../utils/http-error")

const bookingIdOf = (req) => {
  const parsed = idParam("booking").safeParse(req.params.bookingId)
  if (!parsed.success) throw new HttpError(400, "That isn't a booking id.", { code: "VALIDATION" })
  return parsed.data
}
const paymentIdOf = (req) => {
  const parsed = idParam("payment").safeParse(req.params.paymentId)
  if (!parsed.success) throw new HttpError(400, "That isn't a payment id.", { code: "VALIDATION" })
  return parsed.data
}

async function list(req, res) {
  res.json({ ok: true, ...(await clients.list(req.valid)) })
}

async function summary(_req, res) {
  res.json({ ok: true, summary: await clients.summary() })
}

async function payments(req, res) {
  res.json({ ok: true, ...(await clients.payments(bookingIdOf(req))) })
}

async function requestPayment(req, res) {
  res.status(201).json({ ok: true, ...(await clients.requestPayment(req, bookingIdOf(req), req.body)) })
}

async function setPaymentStatus(req, res) {
  res.json({ ok: true, ...(await clients.setPaymentStatus(req, bookingIdOf(req), paymentIdOf(req), req.body)) })
}

async function paymentQr(_req, res) {
  res.json({ ok: true, qr: await clients.paymentQr() })
}

async function setPaymentQr(req, res) {
  res.json({ ok: true, qr: await clients.setPaymentQr(req, req.body) })
}

async function removePaymentQr(req, res) {
  res.json({ ok: true, qr: await clients.removePaymentQr(req) })
}

module.exports = { list, summary, payments, requestPayment, setPaymentStatus, paymentQr, setPaymentQr, removePaymentQr }
