/**
 * An error meant for the client: the error handler in app.js sends its status,
 * message, `code` (for the client to branch on) and any public `details`.
 *
 *   throw new HttpError(401, "Email or password is incorrect.", { code: "INVALID_CREDENTIALS" })
 */
class HttpError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.expose = true
    this.code = code
    /** Extra fields added to the JSON response. Never put secrets here. */
    this.details = details
  }
}

module.exports = { HttpError }
