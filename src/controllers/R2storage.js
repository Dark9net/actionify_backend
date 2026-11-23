/** /api/v1/storage: the HTTP side of services/R2storage.js. */
const r2storage = require("../services/R2storage")

async function usage(req, res) {
  res.json({ ok: true, usage: await r2storage.usage({ refresh: req.valid.refresh }) })
}

module.exports = { usage }
