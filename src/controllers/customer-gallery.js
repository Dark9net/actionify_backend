/** /api/v1/customer-gallery: the HTTP side of services/customer-gallery.js. */
const customerGallery = require("../services/customer-gallery")

async function details(req, res) {
  res.json({ ok: true, ...(await customerGallery.details(req, res)) })
}

async function items(req, res) {
  res.json({ ok: true, ...(await customerGallery.items(req, res, req.valid)) })
}

module.exports = { details, items }
