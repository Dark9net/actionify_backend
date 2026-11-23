/**
 * Signed-in routes. The access token comes in the Authorization header
 * (`Bearer …`), kept in the browser's memory only (see utils/session.js).
 *
 *   router.get("/me", requireAuth, auth.me)
 *   router.use(requireAuth, requireStaff)          // the photographer panel's API
 *
 * Checks, each failing with 401 UNAUTHENTICATED (the client then refreshes once):
 * 1. Token: signature (HS256 only), expiry, type "access"
 * 2. Session: not logged out or expired, user active and confirmed, token not
 *    older than the last password change (cached in Redis as sess:{id})
 *
 * On success: req.user = { id, sessionId, role }. What the role may do is checked
 * by middleware/requireperm.js.
 */
const jwt = require("jsonwebtoken")
const env = require("../config/env")
const { findLiveSession, issuedBeforePasswordChange } = require("../utils/session")
const { HttpError } = require("../utils/http-error")

const unauthenticated = () =>
  new HttpError(401, "Your session has ended. Please sign in again.", { code: "UNAUTHENTICATED" })

function bearerToken(req) {
  const [scheme, token, extra] = (req.get("authorization") ?? "").split(" ")
  return scheme?.toLowerCase() === "bearer" && token && extra === undefined && token.length < 2048 ? token : null
}

/** The signed-in user behind the request, or null (never throws). */
async function identify(req) {
  const token = bearerToken(req)
  if (!token) return null
  let payload
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] })
  } catch {
    return null // bad signature or expired
  }
  if (payload.typ !== "access" || typeof payload.sid !== "string" || typeof payload.sub !== "string") return null

  // Logout revokes the session at once, even though the access token itself hasn't expired yet.
  const session = await findLiveSession(payload.sid)
  if (!session || session.userId !== payload.sub) return null
  if (issuedBeforePasswordChange(payload.iat, session.passwordChangedAt)) return null
  return { id: payload.sub, sessionId: payload.sid, role: session.role }
}

/** Refuses the request without a live session. */
async function requireAuth(req, _res, next) {
  const user = await identify(req)
  if (!user) return next(unauthenticated())
  req.user = user
  next()
}

/** Sets req.user when a valid token is sent, and carries on either way. */
async function optionalAuth(req, _res, next) {
  req.user = (await identify(req)) ?? undefined
  next()
}

module.exports = { requireAuth, optionalAuth, identify }
