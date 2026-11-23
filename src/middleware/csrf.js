/**
 * CSRF protection (signed double-submit token).
 *
 * GET /api/v1/auth/csrf sets an HttpOnly cookie holding a signed token and
 * returns the same token in the body. The client sends it back in the
 * X-CSRF-Token header on every POST/PUT/PATCH/DELETE. Another site can make the
 * browser send the cookie, but can't read the token to put in the header, so its
 * forged requests (e.g. logging a victim into the attacker's account) fail.
 * The signature stops a planted cookie from being accepted.
 */
const crypto = require("node:crypto")
const env = require("../config/env")
const { HttpError } = require("../utils/http-error")
const { randomToken, safeEqual } = require("../utils/crypto")

// A key used only for CSRF, derived from the access-token secret.
const KEY = crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update("csrf-token-v1").digest()
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const cookieOptions = { httpOnly: true, secure: env.IS_PRODUCTION, sameSite: "lax", path: "/api" }

const sign = (nonce) => crypto.createHmac("sha256", KEY).update(nonce).digest("base64url")

/** "<nonce>.<signature>" */
function issue() {
  const nonce = randomToken()
  return `${nonce}.${sign(nonce)}`
}

function isGenuine(token) {
  if (typeof token !== "string" || token.length > 128) return false
  const [nonce, signature, extra] = token.split(".")
  return Boolean(nonce && signature && extra === undefined && safeEqual(signature, sign(nonce)))
}

/** GET /auth/csrf: keeps a valid existing token, so other open tabs keep working. */
function csrfToken(req, res) {
  const existing = req.cookies?.[env.COOKIE_CSRF]
  const token = isGenuine(existing) ? existing : issue()
  res.cookie(env.COOKIE_CSRF, token, cookieOptions)
  res.set("Cache-Control", "no-store")
  res.json({ csrfToken: token })
}

const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/

/**
 * A second line of defence: browsers send Origin on every cross-site POST, so a request that
 * names another site is refused even before the token is looked at. No Origin (curl, server to
 * server) falls through to the token check.
 */
function originAllowed(req) {
  const origin = req.get("origin")
  if (!origin) return true
  if (env.ALLOWED_ORIGINS.includes(origin)) return true
  return !env.IS_PRODUCTION && LOCALHOST.test(origin)
}

/** Rejects unsafe requests from another site, or whose X-CSRF-Token header doesn't match the cookie. */
function requireCsrf(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next()
  if (!originAllowed(req)) {
    return next(new HttpError(403, "This request came from a site that isn't allowed to use this account.", { code: "ORIGIN_DENIED" }))
  }
  const cookie = req.cookies?.[env.COOKIE_CSRF]
  const header = req.get("x-csrf-token")
  if (!isGenuine(cookie) || !header || !safeEqual(header, cookie)) {
    return next(new HttpError(403, "Your form expired. Please try again.", { code: "CSRF_INVALID" }))
  }
  next()
}

module.exports = { csrfToken, requireCsrf }
