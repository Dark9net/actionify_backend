/**
 * Profile photos for staff accounts (photographer, editor, assistant, studio lead): set on the
 * panel's Settings page, shown on the Photographers page and in the header's profile button.
 *
 * - Only your own: the routes take no user id (PUT/DELETE /api/v1/auth/me/photo).
 * - The panel crops and shrinks the picture to a square before sending it; this side checks the
 *   bytes really are a JPEG, PNG or WebP (not what the browser says they are), at most MAX_BYTES and
 *   MAX_SIDE pixels a side.
 * - Kept on R2 under profiles/<user id>/<random>.<ext>: a new name each time, so a changed photo is
 *   never served from a cache; the one before is removed.
 * - Shown through short-lived signed links, like the gallery's photographs (the bucket stays private).
 */
const crypto = require("node:crypto")
const users = require("../models/user")
const { r2, putObject, removeObject, signedViewUrl } = require("../config/r2config")
const { inspect } = require("../utils/image")
const { HttpError } = require("../utils/http-error")
const { audit } = require("../utils/audit")

const MAX_BYTES = 2 * 1024 * 1024
const MAX_SIDE = 4096
const MIN_SIDE = 64
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }
const TYPES = Object.keys(EXT)

const photoError = (message, code = "PHOTO_INVALID", status = 400) =>
  new HttpError(status, message, { code, details: { field: "photo", errors: { photo: message } } })

/** A signed link to the photo, or null (none, or R2 isn't set up). */
async function photoUrl(key) {
  if (!key || !r2) return null
  try {
    return await signedViewUrl(key)
  } catch {
    return null
  }
}

/** Removes a photo that has been replaced or taken off; a failure only leaves a stray file. */
function forget(key) {
  if (!key || !r2) return
  removeObject(key).catch((err) => console.error(`Couldn't remove the old profile photo ${key}:`, err.message))
}

/** PUT /auth/me/photo : the picture as the request body. */
async function set(req, body) {
  if (!r2) throw photoError("Photo storage (R2) isn't set up yet, so photos can't be saved.", "R2_DISABLED", 503)
  if (!Buffer.isBuffer(body) || !body.length) throw photoError("Choose a JPEG, PNG or WebP picture.", "PHOTO_MISSING")
  if (body.length > MAX_BYTES) throw photoError("That picture is too big. Choose one under 2 MB.", "PHOTO_TOO_LARGE", 413)
  const image = inspect(body)
  if (!image) throw photoError("That file isn't a JPEG, PNG or WebP picture.")
  if (image.width > MAX_SIDE || image.height > MAX_SIDE) throw photoError(`That picture is too large. Use one at most ${MAX_SIDE} pixels a side.`)
  if (image.width < MIN_SIDE || image.height < MIN_SIDE) throw photoError(`That picture is too small. Use one at least ${MIN_SIDE} pixels a side.`)

  const user = await users.findById(req.user.id)
  const key = `profiles/${user.id}/${crypto.randomBytes(12).toString("hex")}.${EXT[image.type]}`
  await putObject(key, body, { contentType: image.type, cacheControl: "private, max-age=31536000, immutable" })
  await users.setPhotoKey(user.id, key)
  forget(user.photo_key)
  audit(req, "profile_photo_set", { userId: user.id, detail: { type: image.type, width: image.width, height: image.height, bytes: body.length } })
}

/** DELETE /auth/me/photo : back to initials. */
async function remove(req) {
  const user = await users.findById(req.user.id)
  if (!user.photo_key) return
  await users.setPhotoKey(user.id, null)
  forget(user.photo_key)
  audit(req, "profile_photo_remove", { userId: user.id })
}

module.exports = { set, remove, photoUrl, TYPES, MAX_BYTES }
