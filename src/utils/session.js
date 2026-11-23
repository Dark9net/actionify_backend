/**
 * Login sessions.
 *
 * - Access token: a short JWT (JWT_ACCESS_EXPIRES_IN) returned in the response
 *   body. The browser keeps it in memory only and sends it as
 *   `Authorization: Bearer …` (middleware/auth.js).
 * - Refresh token: a long JWT in an HttpOnly cookie sent only to /api/v1/auth.
 *   The database keeps only its SHA-256 (user_sessions.token_hash).
 *
 * POST /auth/refresh rotates the refresh token on every use. If a token that
 * was already exchanged shows up again, someone copied it: every session of
 * that user is revoked. (A token rotated a moment ago by another tab is
 * accepted for GRACE_SECONDS, so two tabs refreshing together aren't mistaken
 * for theft.)
 *
 * "Remember me" decides whether the cookie outlives the browser; without it
 * the server-side session lasts at most SHORT_SESSION_MS. Sessions never
 * extend: refreshing keeps the original expires_at.
 */
const crypto = require("node:crypto")
const jwt = require("jsonwebtoken")
const env = require("../config/env")
const sessions = require("../models/session")
const cache = require("./cache")
const { sha256 } = require("./crypto")
const { HttpError } = require("./http-error")

/** user_sessions.token_hash is BINARY(32): the raw digest bytes. */
const tokenHash = (token) => Buffer.from(sha256(token), "hex")

const SHORT_SESSION_MS = 12 * 60 * 60 * 1000 // 12 hours without "remember me"
const ALGORITHM = "HS256"
const REFRESH_PATH = "/api/v1/auth"
/** Where the access cookie lived before tokens moved to memory; cleared so old cookies don't linger. */
const LEGACY_ACCESS_PATH = "/api"
const GRACE_SECONDS = 30
const ACCESS_TTL_SECONDS = Math.floor(env.JWT_ACCESS_EXPIRES_IN.ms / 1000)

const sessionKey = (sessionId) => `sess:${sessionId}`
const graceKey = (hash) => `rt:grace:${hash.toString("hex")}`

const cookieBase = {
  httpOnly: true, // page scripts can't read it
  secure: env.IS_PRODUCTION, // HTTPS only in production (localhost is plain http)
  sameSite: "lax",
}

/* ---------- Tokens and cookies ---------- */

/** A new access token for the session: { accessToken, expiresIn } (seconds). */
function signAccess(userId, sessionId) {
  const accessToken = jwt.sign({ sid: sessionId, typ: "access" }, env.JWT_ACCESS_SECRET, {
    algorithm: ALGORITHM,
    subject: String(userId),
    expiresIn: ACCESS_TTL_SECONDS,
  })
  return { accessToken, expiresIn: ACCESS_TTL_SECONDS }
}

/** A refresh token that ends with the session. `jti` makes every token unique, even two in the same second. */
function signRefresh(userId, sessionId, expiresAt) {
  const seconds = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
  return jwt.sign({ sid: sessionId, typ: "refresh", jti: crypto.randomUUID() }, env.JWT_REFRESH_SECRET, {
    algorithm: ALGORITHM,
    subject: String(userId),
    expiresIn: seconds,
  })
}

function setRefreshCookie(res, token, { remember, expiresAt }) {
  // maxAge makes the cookie persistent; without it the browser drops it on close.
  const maxAge = Math.max(0, new Date(expiresAt).getTime() - Date.now())
  res.cookie(env.COOKIE_REFRESH, token, { ...cookieBase, path: REFRESH_PATH, ...(remember && { maxAge }) })
}

function clearAuthCookies(res) {
  res.clearCookie(env.COOKIE_REFRESH, { ...cookieBase, path: REFRESH_PATH })
  res.clearCookie(env.COOKIE_ACCESS, { ...cookieBase, path: LEGACY_ACCESS_PATH })
}

/**
 * Was the token issued before the password was last changed? Compared in whole
 * seconds (JWT `iat`), so the token issued right after a change still counts.
 */
function issuedBeforePasswordChange(iat, passwordChangedAt) {
  if (!passwordChangedAt || typeof iat !== "number") return false
  return iat < Math.floor(new Date(passwordChangedAt).getTime() / 1000)
}

/* ---------- Session lookup for every authenticated request ---------- */

/**
 * The live session behind an access token: { userId, role, passwordChangedAt } or
 * null. Cached in Redis as sess:{id} for one access-token lifetime, so most
 * requests skip the database; logout and revocation delete the key at once.
 */
async function findLiveSession(sessionId) {
  const cached = await cache.getJson(sessionKey(sessionId))
  if (cached) return cached
  const row = await sessions.findActive(sessionId)
  if (!row) return null
  const live = {
    userId: row.user_id,
    role: row.role_slug,
    passwordChangedAt: row.password_changed_at?.toISOString?.() ?? row.password_changed_at,
  }
  await cache.setJson(sessionKey(sessionId), live, ACCESS_TTL_SECONDS)
  return live
}

/* ---------- Login, refresh, logout ---------- */

/** Starts a session for `user`: sets the refresh cookie and returns { accessToken, expiresIn, sessionId }. */
async function startSession(res, user, { remember, userAgent, ip }) {
  const id = crypto.randomUUID()
  const lifetimeMs = remember ? env.JWT_REFRESH_EXPIRES_IN.ms : Math.min(SHORT_SESSION_MS, env.JWT_REFRESH_EXPIRES_IN.ms)
  const expiresAt = new Date(Date.now() + lifetimeMs)
  const refreshToken = signRefresh(user.id, id, expiresAt)

  await sessions.create({ id, userId: user.id, tokenHash: tokenHash(refreshToken), remember, userAgent, ip, expiresAt })

  res.clearCookie(env.COOKIE_ACCESS, { ...cookieBase, path: LEGACY_ACCESS_PATH })
  setRefreshCookie(res, refreshToken, { remember, expiresAt })
  return { ...signAccess(user.id, id), sessionId: id }
}

/** Ends sessions and forgets them in Redis. Returns the ids that were ended. */
async function revokeAllSessions(userId, { exceptSessionId = null } = {}) {
  const ids = await sessions.revokeAllForUser(userId, exceptSessionId)
  await cache.del(ids.map(sessionKey))
  return ids
}

/** Drops the cached copies of a user's sessions (after a role change), so the next request re-reads them. */
async function forgetCachedSessions(userId) {
  const ids = await sessions.liveIds(userId)
  await cache.del(ids.map(sessionKey))
}

// Tokens rotated in the last GRACE_SECONDS, kept in this process too, so the
// two-tabs case is handled even when Redis is off.
const recentRotations = new Map()

async function rememberRotation(hash, sessionId) {
  const until = Date.now() + GRACE_SECONDS * 1000
  recentRotations.set(hash.toString("hex"), { sessionId, until })
  for (const [key, value] of recentRotations) if (value.until < Date.now()) recentRotations.delete(key)
  await cache.setJson(graceKey(hash), sessionId, GRACE_SECONDS)
}

async function wasJustRotated(hash, sessionId) {
  const local = recentRotations.get(hash.toString("hex"))
  if (local && local.until > Date.now() && local.sessionId === sessionId) return true
  return (await cache.getJson(graceKey(hash))) === sessionId
}

const ended = (message, code) => new HttpError(401, message, { code })
const PLEASE_LOG_IN = "Your session has ended. Please log in again."

/**
 * POST /auth/refresh. Returns null when there's no refresh cookie (never logged
 * in), or { userId, sessionId, accessToken, expiresIn }. Throws 401 (and clears
 * the cookie) when the session can't continue; on token reuse it first revokes
 * every session of the user and calls `onReuse({ userId, sessions })`.
 */
async function refreshSession(req, res, { onReuse } = {}) {
  const token = req.cookies?.[env.COOKIE_REFRESH]
  if (typeof token !== "string" || !token) return null

  const fail = (message, code) => {
    clearAuthCookies(res)
    return ended(message, code)
  }

  let payload
  try {
    payload = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: [ALGORITHM] })
  } catch {
    throw fail(PLEASE_LOG_IN, "SESSION_EXPIRED")
  }
  if (payload.typ !== "refresh" || typeof payload.sid !== "string" || typeof payload.sub !== "string") {
    throw fail(PLEASE_LOG_IN, "SESSION_INVALID")
  }

  const row = await sessions.findById(payload.sid)
  if (!row || row.user_id !== payload.sub) throw fail(PLEASE_LOG_IN, "SESSION_INVALID")
  if (row.revoked_at) throw fail(PLEASE_LOG_IN, "SESSION_REVOKED")
  if (row.expires_at <= new Date()) throw fail(PLEASE_LOG_IN, "SESSION_EXPIRED")
  if (row.user_status !== "active" || !row.email_verified_at) throw fail(PLEASE_LOG_IN, "SESSION_INVALID")
  if (issuedBeforePasswordChange(payload.iat, row.password_changed_at)) {
    await sessions.revokeById(row.id)
    await cache.del(sessionKey(row.id))
    throw fail("Your password was changed. Please log in again.", "SESSION_REVOKED")
  }

  const hash = tokenHash(token)
  const accessOnly = () => ({ userId: row.user_id, sessionId: row.id, ...signAccess(row.user_id, row.id) })

  if (!hash.equals(row.token_hash)) {
    // An older token of this session. Rotated a moment ago by a parallel request (another tab)? Fine.
    if (await wasJustRotated(hash, row.id)) return accessOnly()
    // Otherwise a token that was already exchanged is being replayed: assume it was stolen.
    const revoked = await revokeAllSessions(row.user_id)
    await onReuse?.({ userId: row.user_id, sessions: revoked.length })
    throw fail("For your security we've logged you out on every device. Please log in again.", "SESSION_REUSED")
  }

  // Rotate: a new refresh token replaces the old one (same session, same end date).
  const next = signRefresh(row.user_id, row.id, row.expires_at)
  if (!(await sessions.rotate(row.id, hash, tokenHash(next)))) {
    // A parallel refresh rotated between our read and our update; its response sets the new cookie.
    return accessOnly()
  }
  await rememberRotation(hash, row.id)
  setRefreshCookie(res, next, { remember: Boolean(row.remember), expiresAt: row.expires_at })
  return accessOnly()
}

/**
 * Logout: ends the session behind the refresh cookie (even an expired one),
 * clears the cookie and deletes sess:{id} from Redis. Returns the user id, or null.
 */
async function endSession(req, res) {
  const token = req.cookies?.[env.COOKIE_REFRESH]
  let userId = null
  if (typeof token === "string" && token) {
    try {
      const payload = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: [ALGORITHM], ignoreExpiration: true })
      if (payload.typ === "refresh" && typeof payload.sid === "string") {
        const row = await sessions.findById(payload.sid)
        if (row && row.user_id === payload.sub && !row.revoked_at) {
          await sessions.revokeById(row.id)
          userId = row.user_id
        }
        await cache.del(sessionKey(payload.sid))
      }
    } catch {
      // Not one of our tokens: nothing to end, just clear the cookie.
    }
  }
  clearAuthCookies(res)
  return userId
}

/**
 * After a password change: a fresh refresh token for this device (so the
 * "issued before the change" check doesn't end it) and a new access token.
 */
async function reissueSession(res, userId, sessionId) {
  const row = await sessions.findById(sessionId)
  if (!row || row.revoked_at) return signAccess(userId, sessionId)
  const next = signRefresh(userId, sessionId, row.expires_at)
  await sessions.rotate(row.id, row.token_hash, tokenHash(next))
  await cache.del(sessionKey(sessionId)) // re-read with the new password_changed_at
  setRefreshCookie(res, next, { remember: Boolean(row.remember), expiresAt: row.expires_at })
  return signAccess(userId, sessionId)
}

module.exports = {
  startSession,
  refreshSession,
  endSession,
  reissueSession,
  revokeAllSessions,
  findLiveSession,
  issuedBeforePasswordChange,
  clearAuthCookies,
  forgetCachedSessions,
}
