/**
 * Zod schemas for /api/v1/gallery-codes, and the shape of a gallery code itself:
 * 14 letters and digits in groups of 4, 4, 4 and 2 (ANNA-LEO1-JUNE-24), the same
 * as Frontend/src/lib/galleryCode.js.
 */
const { z } = require("zod")

const GROUPS = [4, 4, 4, 2]
const TOTAL = GROUPS.reduce((a, b) => a + b, 0) // 14
const CODE = new RegExp(`^${GROUPS.map((n) => `[A-Z0-9]{${n}}`).join("-")}$`)
const CODE_MESSAGE = "A gallery code has 14 letters and numbers in groups of 4, 4, 4 and 2, like ANNA-LEO1-JUNE-24."

/** What was typed or scanned, as a code: capitals, letters and digits only, the dashes put back in. */
function normaliseCode(value) {
  const clean = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (clean.length !== TOTAL) return clean
  const out = []
  let at = 0
  for (const n of GROUPS) {
    out.push(clean.slice(at, at + n))
    at += n
  }
  return out.join("-")
}

/** A gallery code field: required, normalised, the right shape. */
const code = z
  .string({ error: "Enter the code from your card or email." })
  .max(64, CODE_MESSAGE)
  .transform(normaliseCode)
  .pipe(z.string().min(1, "Enter the code from your card or email.").regex(CODE, CODE_MESSAGE))

/** The same, optional (sign-up): blank counts as not given. */
const optionalCode = z
  .string()
  .max(64, CODE_MESSAGE)
  .optional()
  .transform((v) => (v && v.trim() ? normaliseCode(v) : undefined))
  .pipe(z.string().regex(CODE, CODE_MESSAGE).optional())

/* ---------- Schemas, one per route ---------- */

/** POST /open: a code typed on the sign-in page, or read from a QR code. */
const openSchema = z.object({ code })

const idParam = z.string().uuid("That isn't a gallery code id.")

module.exports = { openSchema, idParam, code, optionalCode, normaliseCode, CODE, GROUPS }
