/**
 * Accounts: sign-up, email confirmation, sign-in, sessions, password reset and
 * change, the profile, and gallery codes on the sign-in page. Controllers
 * (controllers/auth.js) pass in validated input (validators/auth.js) and send
 * back what these return.
 *
 * Security, in one place:
 * - Passwords: bcrypt (PASSWORD_SALT_ROUND), re-hashed on sign-in when the cost goes up.
 * - No account enumeration: sign-in says only "email or password is incorrect" (an unknown
 *   email still runs bcrypt, so it takes as long); sign-up, "forgot password" and "resend"
 *   answer the same whether or not the address has an account, and email the owner instead.
 * - Lockout: MAX_FAILED_ATTEMPTS wrong passwords pause the account for LOCK_MINUTES (and the
 *   owner is emailed). A paused account says so only to someone who typed the right password.
 * - Email must be confirmed before signing in.
 * - Sessions (utils/session.js): short access JWT in memory, rotating refresh cookie
 *   (HttpOnly, SameSite=Lax, Secure in production) with reuse detection; a password reset or
 *   change ends every other session and emails the owner.
 * - Every outcome goes to the auth_events log (utils/audit.js).
 */
const crypto = require("node:crypto")
const bcrypt = require("bcrypt")
const env = require("../config/env")
const { withTransaction } = require("../config/dbconfig")
const users = require("../models/user")
const profilePhoto = require("./profile-photo")
const roles = require("../models/role")
const galleryCodes = require("./gallerycode")
const linkTokens = require("../utils/link-token")
const session = require("../utils/session")
const mail = require("../utils/mailer")
const { audit } = require("../utils/audit")
const { HttpError } = require("../utils/http-error")
const { CLIENT_ROLE } = require("../utils/roles")
const { passwordProblem } = require("../validators/auth")

const RESEND_COOLDOWN_MS = 60_000 // one confirmation or reset email a minute per account
// Compared against when the email is unknown, so a miss takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), env.PASSWORD_SALT_ROUND)

const invalidCredentials = () =>
  new HttpError(401, "That email and password don't match an account. Check them and try again.", { code: "INVALID_CREDENTIALS" })

/** A 400 that the sign-in page shows under one field. */
const fieldError = (field, message, code = "VALIDATION") =>
  new HttpError(400, message, { code, details: { field, errors: { [field]: message } } })

const deviceOf = (req) => ({ userAgent: req.get("user-agent"), ip: req.ip })

/* ---------- What the browser gets back ---------- */

async function publicUser(row) {
  const permissions = [...(await roles.permissionCodes(row.role_slug))].sort()
  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    mobile: row.mobile ?? null,
    photo: await profilePhoto.photoUrl(row.photo_key), // a signed link, renewed with each session refresh
    role: { slug: row.role_slug, name: row.role_name, isStaff: Boolean(row.role_is_staff) },
    permissions,
    lastLoginAt: row.last_login_at,
  }
}

/** The galleries a client account has added (from the code at sign-up, or opened while signed in). */
const galleriesOf = (userId) => galleryCodes.galleriesOf(userId)

async function sessionPayload(row, tokens) {
  return {
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    user: await publicUser(row),
    galleries: row.role_is_staff ? [] : await galleriesOf(row.id),
  }
}

/* ---------- Sign-up and email confirmation ---------- */

/** Sends a confirmation link unless one went out in the last minute. */
async function sendConfirmation(user) {
  if (await linkTokens.cooldownSeconds(user.id, "verify_email", RESEND_COOLDOWN_MS)) return false
  const token = await linkTokens.issue(user.id, "verify_email")
  void mail.deliver(mail.sendVerificationLinkEmail({ to: user.email, name: user.full_name, token }))
  return true
}

/**
 * The Create account tab. Always answers { email } (so it can't reveal who has an account):
 * a new address gets a confirmation link; an existing one gets a new link if it was never
 * confirmed, or a "you already have an account" email if it was.
 */
async function signUp(req, { name, email, password, code }) {
  // Hash first, whatever happens next, so every answer takes about as long.
  const passwordHash = await bcrypt.hash(password, env.PASSWORD_SALT_ROUND)

  let gallery = null
  if (code) {
    // a wrong code counts towards blocking this IP, as on the code form (services/gallerycode.js)
    gallery = await galleryCodes.forSignup(req, code)
  }

  const existing = await users.findByEmail(email)
  if (existing) {
    if (existing.status !== "disabled" && !existing.email_verified_at) await sendConfirmation(existing)
    else if (existing.status !== "disabled") void mail.deliver(mail.sendAccountExistsEmail({ to: existing.email, name: existing.full_name }))
    audit(req, "signup_existing", { userId: existing.id, email })
    return { email }
  }

  const id = crypto.randomUUID()
  let token
  try {
    token = await withTransaction(async (conn) => {
      await users.create(
        // pending: signing in waits until a studio lead approves the account (services/users.js)
        { id, fullName: name, email, roleSlug: CLIENT_ROLE, status: "pending", passwordHash, termsVersion: env.TERMS_VERSION, termsAcceptedAt: new Date() },
        conn,
      )
      if (gallery) await galleryCodes.addMember(gallery.id, id, "signup", conn)
      return linkTokens.issue(id, "verify_email", conn)
    })
  } catch (err) {
    // Two sign-ups with the same address at once: the second one is "existing".
    if (err.code === "ER_DUP_ENTRY") return { email }
    throw err
  }
  void mail.deliver(mail.sendVerificationLinkEmail({ to: email, name, token }))
  audit(req, "signup", { userId: id, email, detail: { withCode: Boolean(gallery) } })
  return { email }
}

const LINK_EXPIRED = {
  verify_email: "This confirmation link has expired. Enter your email below and we'll send a new one.",
  reset_password: "This reset link has expired. Ask for a new one from the sign-in page.",
}
const LINK_INVALID = {
  verify_email: "This confirmation link has already been used or isn't valid. Try signing in.",
  reset_password: "This reset link has already been used or isn't valid. Ask for a new one from the sign-in page.",
}
const linkError = (purpose, reason) =>
  reason === "expired"
    ? new HttpError(400, LINK_EXPIRED[purpose], { code: "TOKEN_EXPIRED" })
    : new HttpError(400, LINK_INVALID[purpose], { code: "TOKEN_INVALID" })

/** The link in the sign-up email (/verify-email?token=…). */
async function verifyEmail(req, { token }) {
  const result = await withTransaction(async (conn) => {
    const r = await linkTokens.consume(token, "verify_email", conn)
    if (r.ok) await users.markVerified(r.userId, conn)
    return r
  })
  if (!result.ok) throw linkError("verify_email", result.reason)
  audit(req, "email_verified", { userId: result.userId })
  // pending: the page says the studio still has to approve the account
  return { email: result.email, pending: result.status === "pending" }
}

/** "Send the link again": the same answer whatever the address. */
async function resendVerification(req, { email }) {
  const user = await users.findByEmail(email)
  if (user && user.status !== "disabled" && !user.email_verified_at) await sendConfirmation(user)
  audit(req, "verify_resend", { userId: user?.id, email })
}

/* ---------- Sign-in, sessions, sign-out ---------- */

async function signIn(req, res, { email, password, remember }) {
  const user = await users.findByEmail(email)
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH)
    audit(req, "login_fail", { email, detail: { reason: "unknown_email" } })
    throw invalidCredentials()
  }

  const right = await bcrypt.compare(password, user.password_hash)
  const lockedFor = user.locked_until ? user.locked_until.getTime() - Date.now() : 0
  if (lockedFor > 0) {
    audit(req, "login_locked", { userId: user.id, email })
    // Only someone who knows the password learns that the account is paused.
    if (!right) throw invalidCredentials()
    const minutes = Math.ceil(lockedFor / 60_000)
    throw new HttpError(
      423,
      `Too many wrong passwords, so signing in is paused for ${minutes} more minute${minutes === 1 ? "" : "s"}. Or choose "Forgot password?" to set a new one.`,
      { code: "ACCOUNT_LOCKED", details: { retryAfterSeconds: Math.ceil(lockedFor / 1000) } },
    )
  }

  if (!right) {
    const { lockedUntil } = await users.recordFailedLogin(user.id, env.LOGIN_MAX_FAILED_ATTEMPTS, env.LOGIN_LOCK_MINUTES)
    audit(req, "login_fail", { userId: user.id, email, detail: { reason: "wrong_password" } })
    if (lockedUntil && lockedUntil > new Date()) {
      audit(req, "account_locked", { userId: user.id, detail: { minutes: env.LOGIN_LOCK_MINUTES } })
      void mail.deliver(mail.sendAccountLockedEmail({ to: user.email, name: user.full_name, minutes: env.LOGIN_LOCK_MINUTES }))
    }
    throw invalidCredentials()
  }

  if (user.status === "disabled") {
    audit(req, "login_blocked", { userId: user.id, detail: { status: user.status } })
    throw new HttpError(403, "This account has been turned off. Contact the studio if you think that's a mistake.", { code: "ACCOUNT_DISABLED" })
  }

  if (!user.email_verified_at) {
    const sent = await sendConfirmation(user)
    audit(req, "login_unverified", { userId: user.id })
    throw new HttpError(
      403,
      sent
        ? `Confirm your email address first. We've sent a new link to ${user.email}.`
        : `Confirm your email address first: open the link we sent to ${user.email} a moment ago.`,
      { code: "EMAIL_NOT_VERIFIED" },
    )
  }

  // Signed up and confirmed, but the studio hasn't approved the account yet.
  if (user.status !== "active") {
    audit(req, "login_pending", { userId: user.id })
    throw new HttpError(
      403,
      "Your account is waiting for verification from the studio. We'll email you as soon as it's approved.",
      { code: "ACCOUNT_PENDING" },
    )
  }

  // The cost factor went up since this hash was made: store a stronger one while we have the password.
  if (bcrypt.getRounds(user.password_hash) < env.PASSWORD_SALT_ROUND) {
    await users.upgradeHash(user.id, await bcrypt.hash(password, env.PASSWORD_SALT_ROUND))
  }

  await users.recordLogin(user.id)
  const tokens = await session.startSession(res, user, { remember, ...deviceOf(req) })
  audit(req, "login_ok", { userId: user.id, detail: { sessionId: tokens.sessionId, remember } })
  return sessionPayload(await users.findById(user.id), tokens)
}

/** A new access token from the refresh cookie (every page load). null: nobody is signed in. */
async function refresh(req, res) {
  const out = await session.refreshSession(req, res, {
    onReuse: ({ userId, sessions }) => audit(req, "refresh_reuse", { userId, detail: { sessions } }),
  })
  if (!out) return null
  const user = await users.findById(out.userId)
  if (!user) {
    session.clearAuthCookies(res)
    throw new HttpError(401, "Your session has ended. Please sign in again.", { code: "SESSION_INVALID" })
  }
  return sessionPayload(user, out)
}

async function signOut(req, res) {
  const userId = await session.endSession(req, res)
  if (userId) audit(req, "logout", { userId })
}

async function signOutEverywhere(req, res) {
  const ended = await session.revokeAllSessions(req.user.id)
  session.clearAuthCookies(res)
  audit(req, "logout_all", { userId: req.user.id, detail: { sessions: ended.length } })
}

/* ---------- The signed-in account ---------- */

async function me(req) {
  const user = await users.findById(req.user.id)
  if (!user) throw new HttpError(401, "Your session has ended. Please sign in again.", { code: "UNAUTHENTICATED" })
  return { user: await publicUser(user), galleries: user.role_is_staff ? [] : await galleriesOf(user.id) }
}

async function updateMe(req, { name, mobile }) {
  await users.updateName(req.user.id, name)
  // undefined: not sent, left as it is; null: removed
  if (mobile !== undefined) await users.setMobile(req.user.id, mobile)
  audit(req, "profile_update", { userId: req.user.id })
  return me(req)
}

/** PUT /me/photo : your own profile photo (the request body is the picture). → { user, galleries } */
async function setPhoto(req, body) {
  await profilePhoto.set(req, body)
  return me(req)
}

/** DELETE /me/photo : back to your initials. → { user, galleries } */
async function removePhoto(req) {
  await profilePhoto.remove(req)
  return me(req)
}

async function changePassword(req, res, { currentPassword, password }) {
  const user = await users.findById(req.user.id)
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    audit(req, "password_change_fail", { userId: user.id })
    throw fieldError("currentPassword", "That isn't your current password.")
  }
  const problem = passwordProblem(password, { email: user.email, name: user.full_name })
  if (problem) throw fieldError("password", problem)

  await users.setPassword(user.id, await bcrypt.hash(password, env.PASSWORD_SALT_ROUND))
  const ended = await session.revokeAllSessions(user.id, { exceptSessionId: req.user.sessionId })
  const tokens = await session.reissueSession(res, user.id, req.user.sessionId)
  audit(req, "password_change", { userId: user.id, detail: { otherSessionsEnded: ended.length } })
  void mail.deliver(mail.sendPasswordChangedEmail({ to: user.email, name: user.full_name }))
  return tokens
}

/* ---------- Forgot password ---------- */

/** "Forgot password?": the same answer whatever the address; a link goes out only to a real account. */
async function forgotPassword(req, { email }) {
  const user = await users.findByEmail(email)
  if (user && user.status !== "disabled") {
    if (!(await linkTokens.cooldownSeconds(user.id, "reset_password", RESEND_COOLDOWN_MS))) {
      const token = await linkTokens.issue(user.id, "reset_password")
      void mail.deliver(mail.sendPasswordResetEmail({ to: user.email, name: user.full_name, token }))
    }
    audit(req, "reset_request", { userId: user.id })
  } else {
    audit(req, "reset_request", { email, detail: { known: false } })
  }
}

/** The reset page checks its link before asking for a password. */
async function checkResetToken({ token }) {
  const result = await linkTokens.inspect(token, "reset_password")
  if (!result.ok) throw linkError("reset_password", result.reason)
  return { email: result.email }
}

async function resetPassword(req, res, { token, password }) {
  const passwordHash = await bcrypt.hash(password, env.PASSWORD_SALT_ROUND)
  const result = await withTransaction(async (conn) => {
    const r = await linkTokens.consume(token, "reset_password", conn)
    if (!r.ok) return r
    const user = await users.findByIdForUpdate(r.userId, conn)
    // Thrown inside the transaction, so the link stays usable for a second try.
    const problem = passwordProblem(password, { email: user.email, name: user.full_name })
    if (problem) throw fieldError("password", problem)
    if (await bcrypt.compare(password, user.password_hash)) throw fieldError("password", "Choose a password you haven't used here before.")
    await users.setPassword(user.id, passwordHash, conn)
    await users.markVerified(user.id, conn) // the link proves the inbox is theirs
    return { ok: true, user }
  })
  if (!result.ok) throw linkError("reset_password", result.reason)

  const { user } = result
  const ended = await session.revokeAllSessions(user.id)
  session.clearAuthCookies(res)
  audit(req, "password_reset", { userId: user.id, detail: { sessionsEnded: ended.length } })
  void mail.deliver(mail.sendPasswordChangedEmail({ to: user.email, name: user.full_name }))
  return { email: user.email }
}

module.exports = {
  signUp,
  verifyEmail,
  resendVerification,
  signIn,
  refresh,
  signOut,
  signOutEverywhere,
  me,
  updateMe,
  setPhoto,
  removePhoto,
  changePassword,
  forgotPassword,
  checkResetToken,
  resetPassword,
}
