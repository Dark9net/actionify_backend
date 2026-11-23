/**
 * What both sides of a gallery code share: guests opening one (services/gallerycode.js) and staff
 * managing them on the Access codes page (services/accesscode.js).
 */
const crypto = require("node:crypto")
const { lookupHash, open } = require("./crypto")
const { GROUPS } = require("../validators/gallerycode")

// no 0/O or 1/I: about 70 bits in 14 characters
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/** The searchable HMAC of a (normalised) code: gallery_codes.code_hash. */
const hashCode = (code) => lookupHash(`gallery-code:${code}`)

/** A fully random code in the 4-4-4-2 shape. */
const makeCode = () => GROUPS.map((n) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("")).join("-")

/** The code itself, decrypted; null when it was sealed with a key that has since changed. */
function readCode(row) {
  try {
    return open(row.code_enc)
  } catch {
    return null
  }
}

/** "active" | "expired" | "revoked" */
function codeState(row, now = new Date()) {
  if (row.revoked_at) return "revoked"
  if (row.expires_at && row.expires_at <= now) return "expired"
  return "active"
}

module.exports = { hashCode, makeCode, readCode, codeState }
