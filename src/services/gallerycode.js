/**
 * Gallery codes: the code on a client's card or QR code (ANNA-LEO1-JUNE-24, 14 letters and
 * digits) that opens their gallery without an account.
 *
 * Opening a code makes the browser a client of that one gallery: a random token in an HttpOnly
 * cookie (GALLERY_COOKIE_NAME, sent only to /api/v1: these routes and /api/v1/customer-gallery, which
 * shows the gallery's photographs), with only its SHA-256 kept in gallery_code_sessions. The dashboard
 * checks in with it every minute.
 *
 * Security:
 * - Codes are found by an HMAC (code_hash) and kept AES-256-GCM encrypted (code_enc).
 * - Made-up codes are 14 characters from 32 letters and digits (no 0/O, 1/I): about 70 bits.
 * - Wrong codes are counted per IP in gallery_code_blocks: GALLERY_CODE_MAX_ATTEMPTS within
 *   GALLERY_CODE_WINDOW_MINUTES block that IP for GALLERY_CODE_BLOCK_MINUTES, on every route
 *   that takes a code (opening one, or signing up with one). A right code doesn't reset the
 *   count, so a known code can't be used to keep guessing. An expired code isn't a guess.
 * - max_users limits how many browsers view a gallery at the same time.
 * - Revoking a code ends every session it opened.
 */
const crypto = require("node:crypto")
const env = require("../config/env")
const { withTransaction } = require("../config/dbconfig")
const codes = require("../models/gallery-code")
const { sha256 } = require("../utils/crypto")
const { hashCode, readCode, codeState: state } = require("../utils/gallery-code")
const { HttpError } = require("../utils/http-error")
const { audit } = require("../utils/audit")
const { CLIENT_ROLE } = require("../utils/roles")

// /api/v1, so the photographs (/api/v1/customer-gallery) get the cookie too. It used to be sent only
// to /api/v1/gallery-codes: a cookie still there is moved over at the next check-in, then cleared.
const COOKIE_PATH = "/api/v1"
const LEGACY_COOKIE_PATH = "/api/v1/gallery-codes"

const hashToken = (token) => Buffer.from(sha256(token), "hex")

/** What a guest or client sees. */
const toGallery = (row, code) => ({
  id: row.id,
  code: code ?? readCode(row),
  eventName: row.event_name,
  label: row.label,
  expiresAt: row.expires_at,
})

/* ---------- Guessing: count wrong codes per IP, block after too many ---------- */

const ipOf = (req) => req.ip || "unknown"

function blocked(until) {
  const seconds = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 1000))
  const minutes = Math.ceil(seconds / 60)
  return new HttpError(
    429,
    `Too many wrong gallery codes. Codes are blocked on this connection for ${minutes} more minute${minutes === 1 ? "" : "s"}.`,
    { code: "GALLERY_CODE_BLOCKED", details: { retryAfterSeconds: seconds } },
  )
}

/** Refuses at once while the IP is blocked. */
async function guard(req) {
  const row = await codes.findBlock(ipOf(req))
  if (row?.blocked_until && row.blocked_until > new Date()) throw blocked(row.blocked_until)
}

/** A wrong code: count it, and block the IP when that was one too many. */
async function strike(req, field) {
  const { failures, blockedUntil } = await codes.recordFailure(ipOf(req), {
    max: env.GALLERY_CODE_MAX_ATTEMPTS,
    windowMinutes: env.GALLERY_CODE_WINDOW_MINUTES,
    blockMinutes: env.GALLERY_CODE_BLOCK_MINUTES,
  })
  if (blockedUntil && blockedUntil > new Date()) {
    audit(req, "gallery_code_blocked", { userId: req.user?.id, detail: { minutes: env.GALLERY_CODE_BLOCK_MINUTES } })
    return blocked(blockedUntil)
  }
  const left = Math.max(0, env.GALLERY_CODE_MAX_ATTEMPTS - failures)
  const message = `We couldn't find a gallery with that code. Check it against your card. ${left} ${left === 1 ? "try" : "tries"} left before codes are blocked for ${env.GALLERY_CODE_BLOCK_MINUTES} minutes.`
  return new HttpError(404, message, {
    code: "GALLERY_NOT_FOUND",
    details: { attemptsLeft: left, ...(field && { field, errors: { [field]: message } }) },
  })
}

/**
 * The code's row, if it opens. Checks the block first; a code that doesn't exist (or was revoked)
 * counts as a wrong guess. `code` is already normalised by the validator.
 */
async function resolve(req, code, { field } = {}) {
  await guard(req)
  const row = await codes.findByHash(hashCode(code))
  const s = row ? state(row) : "missing"
  if (s === "active") return row
  audit(req, "gallery_open_fail", { userId: req.user?.id, detail: { reason: s } })
  if (s === "expired") {
    const message = "This gallery code has expired. Ask the studio for a new one."
    throw new HttpError(410, message, { code: "GALLERY_EXPIRED", details: field ? { field, errors: { [field]: message } } : undefined })
  }
  throw await strike(req, field)
}

/* ---------- The gallery session (the browser as a client of one gallery) ---------- */

const cookieOptions = (maxAge) => ({
  httpOnly: true,
  secure: env.IS_PRODUCTION,
  sameSite: "lax",
  path: COOKIE_PATH,
  ...(maxAge !== undefined && { maxAge }),
})

function clearCookie(res) {
  res.clearCookie(env.COOKIE_GALLERY, cookieOptions())
  res.clearCookie(env.COOKIE_GALLERY, { ...cookieOptions(), path: LEGACY_COOKIE_PATH })
}

/** Sets this browser's gallery cookie until the visit ends (and drops one left at the old path). */
function setCookie(res, token, expiresAt) {
  res.cookie(env.COOKIE_GALLERY, token, cookieOptions(Math.max(0, new Date(expiresAt).getTime() - Date.now())))
  res.clearCookie(env.COOKIE_GALLERY, { ...cookieOptions(), path: LEGACY_COOKIE_PATH })
}

/** The live session behind this browser's cookie, or null. */
async function currentSession(req) {
  const token = req.cookies?.[env.COOKIE_GALLERY]
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null
  return codes.findSession(hashToken(token))
}

const payload = (row, code, expiresAt) => ({
  role: CLIENT_ROLE, // whoever holds the code views the gallery as a client (the session row says so too)
  gallery: toGallery(row, code),
  session: { expiresAt },
})

const HOUR_MS = 3_600_000
/** The end of a gallery visit that starts now: GALLERY_SESSION_HOURS (24) after the code was entered. */
const visitEnd = (from = Date.now()) => new Date(new Date(from).getTime() + env.GALLERY_SESSION_HOURS * HOUR_MS)

/**
 * Starts (or keeps) this browser's session on the gallery, within its max_users. The same
 * browser opening the same gallery again keeps its seat instead of taking another (and its end).
 * Every session is a client's (role 'client'). via: 'code' (typed, scanned, a QR link) or
 * 'account'; until: when it ends (24 hours after the code was entered).
 */
async function startSession(req, res, row, { code, userId = null, via = "code", until = visitEnd() } = {}) {
  const existing = await currentSession(req)
  if (existing && existing.id === row.id) {
    await codes.touchSession(existing.session_id)
    return payload(row, code, existing.session_expires_at)
  }
  if (existing) await codes.endSession(existing.session_id) // another gallery: this browser moves on

  const token = crypto.randomBytes(32).toString("base64url")
  const expiresAt = until
  await withTransaction(async (conn) => {
    const locked = await codes.lockById(row.id, conn)
    if (!locked || state(locked) !== "active") throw new HttpError(410, "This gallery code no longer works.", { code: "GALLERY_EXPIRED" })
    if (locked.max_users) {
      const live = await codes.liveSeats(row.id, conn)
      if (live >= locked.max_users) {
        audit(req, "gallery_full", { userId, detail: { codeId: row.id, maxUsers: locked.max_users } })
        throw new HttpError(
          409,
          `This gallery is already open on ${locked.max_users} device${locked.max_users === 1 ? "" : "s"}, the most its code allows. Try again in a few minutes, or ask the studio for more.`,
          { code: "GALLERY_FULL", details: { maxUsers: locked.max_users } },
        )
      }
    }
    await codes.createSession(
      { id: crypto.randomUUID(), codeId: row.id, userId, role: CLIENT_ROLE, via, tokenHash: hashToken(token), ip: req.ip, userAgent: req.get("user-agent"), expiresAt },
      conn,
    )
    await codes.recordOpen(row.id, conn)
  })
  setCookie(res, token, expiresAt)
  return payload(row, code, expiresAt)
}

/** POST /open: a code typed or scanned. A signed-in client also keeps the gallery on their account. */
async function openByCode(req, res, { code }) {
  const row = await resolve(req, code, { field: "code" })
  const clientId = req.user?.role === CLIENT_ROLE ? req.user.id : null
  if (clientId) await codes.addMember(row.id, clientId, "code")
  const out = await startSession(req, res, row, { code, userId: clientId })
  audit(req, "gallery_open", { userId: req.user?.id, detail: { codeId: row.id } })
  return out
}

/**
 * The gallery this browser holds open, checked: a live session on an active code, viewed as a client.
 * Otherwise the session ends, the cookie goes, and 401 GALLERY_SESSION_ENDED or 410 GALLERY_EXPIRED.
 * Shared with services/customer-gallery.js, which shows that gallery's photographs and nothing else.
 */
async function liveSession(req, res) {
  const row = await currentSession(req)
  if (!row) {
    clearCookie(res)
    throw new HttpError(401, "Open your gallery with its code.", { code: "GALLERY_SESSION_ENDED" })
  }
  if (state(row) !== "active") {
    await codes.endSession(row.session_id)
    clearCookie(res)
    throw new HttpError(410, "This gallery code no longer works. Ask the studio for a new one.", { code: "GALLERY_EXPIRED" })
  }
  // a gallery is only ever viewed as a client
  if (row.session_role !== CLIENT_ROLE) {
    await codes.endSession(row.session_id)
    clearCookie(res)
    throw new HttpError(401, "Open your gallery with its code.", { code: "GALLERY_SESSION_ENDED" })
  }
  return row
}

/** GET /session: is this browser still in its gallery? Also the minute-by-minute check-in. */
async function checkSession(req, res) {
  const row = await liveSession(req, res)
  await codes.touchSession(row.session_id)
  setCookie(res, req.cookies[env.COOKIE_GALLERY], row.session_expires_at) // a cookie at the old path moves to /api/v1
  return payload(row, undefined, row.session_expires_at)
}

/** POST /leave: frees the seat and forgets the gallery on this browser. */
async function leave(req, res) {
  const row = await currentSession(req)
  if (row) await codes.endSession(row.session_id)
  clearCookie(res)
}

/** GET /mine: the galleries a signed-in client account holds. */
async function mine(req) {
  return (await codes.openForUser(req.user.id)).map((row) => toGallery(row)).filter((g) => g.code)
}

/**
 * POST /:id/enter: a signed-in client opens one of their galleries in this browser (staff may open
 * any, to check it). A client may do so only within the 24 hours after they last entered its code
 * (anywhere), and the visit ends when those 24 hours do. Never entered on the account: 403
 * GALLERY_CODE_REQUIRED; entered more than 24 hours ago: 403 GALLERY_VISIT_ENDED. Either way the code
 * is asked for again. Staff checking a gallery get a visit of their own.
 */
async function enter(req, res, id, { canPreview }) {
  const row = await codes.findById(id)
  const client = req.user.role === CLIENT_ROLE
  const allowed = row && (canPreview || (client && (await codes.isMember(id, req.user.id))))
  if (!allowed) throw new HttpError(404, "That gallery isn't on your account.", { code: "NOT_FOUND" })
  if (state(row) !== "active") throw new HttpError(410, "This gallery code no longer works. Ask the studio for a new one.", { code: "GALLERY_EXPIRED" })
  let until = visitEnd()
  if (!canPreview) {
    const entered = await codes.lastCodeOpen(id, req.user.id)
    // never entered on this account (the studio linked it): the code first
    if (!entered) {
      throw new HttpError(403, `Enter your gallery code to open this gallery. It stays open for ${env.GALLERY_SESSION_HOURS} hours each time.`, {
        code: "GALLERY_CODE_REQUIRED",
      })
    }
    until = visitEnd(entered)
    if (until.getTime() <= Date.now()) {
      throw new HttpError(403, `Your ${env.GALLERY_SESSION_HOURS} hours with this gallery are up. Enter its gallery code again to keep viewing.`, {
        code: "GALLERY_VISIT_ENDED",
      })
    }
  }
  const out = await startSession(req, res, row, { userId: req.user.id, via: "account", until })
  audit(req, "gallery_open", { userId: req.user.id, detail: { codeId: id, via: "account" } })
  return out
}

/** Sign-up with a code: the code must open (a wrong one counts as a guess); returns its row. */
const forSignup = (req, code) => resolve(req, code, { field: "code" })
const addMember = (codeId, userId, via, db) => codes.addMember(codeId, userId, via, db)
const galleriesOf = (userId) => codes.openForUser(userId).then((rows) => rows.map((row) => toGallery(row)).filter((g) => g.code))

module.exports = {
  openByCode,
  checkSession,
  liveSession,
  leave,
  mine,
  enter,
  forSignup,
  addMember,
  galleriesOf,
}
