/**
 * Writes to the auth_events security log. Logging never fails a request: if
 * the insert fails, the problem goes to the server log instead.
 *
 *   audit(req, "login_fail", { userId, email, detail: { reason: "wrong_password" } })
 */
const events = require("../models/auth-event")

function audit(req, event, { userId, email, detail } = {}) {
  return events
    .create({ userId, email, event, ip: req.ip, userAgent: req.get("user-agent"), detail })
    .catch((err) => console.error(`Couldn't record auth event "${event}":`, err.message))
}

module.exports = { audit }
