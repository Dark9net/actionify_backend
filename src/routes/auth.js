/**
 * /api/v1/auth: what the sign-in page (Frontend/src/pages/auth) talks to.
 *
 *   GET   /csrf                  token for the X-CSRF-Token header (every POST/PATCH needs it)
 *   POST  /signup                { name, email, password, code?, terms }  → 202 (always the same answer)
 *   POST  /verify-email          { token }            the emailed link: /verify-email?token=…
 *   POST  /resend-verification   { email }            → 202
 *   POST  /login                 { email, password, remember? } → { accessToken, expiresIn, user, galleries }
 *   POST  /refresh               (refresh cookie)     → { accessToken, expiresIn, user, galleries } | 204
 *   POST  /logout                this device
 *   POST  /logout-all            every device                         (Authorization: Bearer)
 *   GET   /me                    → { user, galleries }                (Bearer)
 *   PATCH /me                    { name, mobile? }                    (Bearer)
 *   PUT   /me/photo              the picture as the body (image/jpeg, image/png or image/webp, ≤ 2 MB)
 *                                → { user, galleries }   your own profile photo only (Bearer, staff)
 *   DELETE /me/photo             back to initials → { user, galleries }  (Bearer, staff)
 *   POST  /change-password       { currentPassword, password }        (Bearer)
 *   POST  /forgot-password       { email }            → 202, emails /reset-password?token=…
 *   POST  /reset-password/check  { token }            → { email } | 400 TOKEN_EXPIRED / TOKEN_INVALID
 *   POST  /reset-password        { token, password }  → signs out every device
 *   (gallery codes: routes/gallerycode.js)
 *
 * Order per route: rate limit (IP + email) → session → zod validator → controller.
 */
const express = require("express")
const auth = require("../controllers/auth")
const { requireAuth } = require("../middleware/auth")
const { requireStaff } = require("../middleware/requireperm")
const profilePhoto = require("../services/profile-photo")
const { csrfToken } = require("../middleware/csrf")
const limit = require("../middleware/rate-limit")
const { validate } = require("../middleware/validate")
const v = require("../validators/auth")

const router = express.Router()

// Nothing from here belongs in a cache (tokens, who is signed in).
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store")
  next()
})

router.get("/csrf", csrfToken)
router.post("/signup", limit.signup, validate(v.signUpSchema), auth.signUp)
router.post("/verify-email", limit.verifyEmail, validate(v.tokenSchema), auth.verifyEmail)
router.post("/resend-verification", limit.resendVerification, validate(v.emailSchema), auth.resendVerification)
router.post("/login", limit.login, validate(v.signInSchema), auth.signIn)
router.post("/refresh", limit.refresh, auth.refresh)
router.post("/logout", auth.signOut)
router.post("/logout-all", requireAuth, auth.signOutEverywhere)
router.get("/me", requireAuth, auth.me)
router.patch("/me", limit.write, requireAuth, validate(v.updateMeSchema), auth.updateMe)
// the picture itself is the body: read only once the session and role are checked
const photoBody = express.raw({ type: profilePhoto.TYPES, limit: profilePhoto.MAX_BYTES })
router.put("/me/photo", limit.write, requireAuth, requireStaff, photoBody, auth.setPhoto)
router.delete("/me/photo", limit.write, requireAuth, requireStaff, auth.removePhoto)
router.post("/change-password", limit.changePassword, requireAuth, validate(v.changePasswordSchema), auth.changePassword)
router.post("/forgot-password", limit.reset, validate(v.emailSchema), auth.forgotPassword)
router.post("/reset-password/check", limit.resetCheck, validate(v.tokenSchema), auth.checkResetToken)
router.post("/reset-password", limit.resetPassword, validate(v.resetPasswordSchema), auth.resetPassword)

module.exports = router
