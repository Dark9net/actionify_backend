/** /api/v1/overview: the HTTP side of services/overview.js. */
const overview = require("../services/overview")

async function get(req, res) {
  res.json({ ok: true, overview: await overview.get(req, req.valid) })
}

module.exports = { get }
