/**
 * /api/v1/auth: the HTTP side of services/auth.js. Every body arrives already
 * checked by validators/auth.js (middleware/validate.js).
 */
const auth = require("../services/auth")

async function signUp(req, res) {
  const { email } = await auth.signUp(req, req.body)
  res.status(202).json({
    ok: true,
    email,
    message: "We've sent a link to confirm your email. Then wait for the verification from the admin side.",
  })
}

async function verifyEmail(req, res) {
  res.json({ ok: true, ...(await auth.verifyEmail(req, req.body)) })
}

async function resendVerification(req, res) {
  await auth.resendVerification(req, req.body)
  res.status(202).json({ ok: true, message: "If that address needs confirming, a new link is on its way." })
}

async function signIn(req, res) {
  res.json({ ok: true, ...(await auth.signIn(req, res, req.body)) })
}

async function refresh(req, res) {
  const out = await auth.refresh(req, res)
  if (!out) return res.status(204).end() // nobody signed in on this browser
  res.json({ ok: true, ...out })
}

async function signOut(req, res) {
  await auth.signOut(req, res)
  res.json({ ok: true })
}

async function signOutEverywhere(req, res) {
  await auth.signOutEverywhere(req, res)
  res.json({ ok: true })
}

async function me(req, res) {
  res.json({ ok: true, ...(await auth.me(req)) })
}

async function updateMe(req, res) {
  res.json({ ok: true, ...(await auth.updateMe(req, req.body)) })
}

async function setPhoto(req, res) {
  res.json({ ok: true, ...(await auth.setPhoto(req, req.body)) })
}

async function removePhoto(req, res) {
  res.json({ ok: true, ...(await auth.removePhoto(req)) })
}

async function changePassword(req, res) {
  res.json({ ok: true, ...(await auth.changePassword(req, res, req.body)) })
}

async function forgotPassword(req, res) {
  await auth.forgotPassword(req, req.body)
  res.status(202).json({ ok: true, message: "If an account uses that address, a reset link is on its way." })
}

async function checkResetToken(req, res) {
  res.json({ ok: true, ...(await auth.checkResetToken(req.body)) })
}

async function resetPassword(req, res) {
  res.json({ ok: true, ...(await auth.resetPassword(req, res, req.body)) })
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
