/**
 * Zod schemas for /api/v1/auth, shaped after the sign-in page's forms
 * (Frontend/src/pages/auth): the same field names, and the same wording for
 * each problem, so a message from here can sit under the field it belongs to.
 *
 * middleware/validate.js runs them: the parsed result (trimmed, normalised,
 * unknown fields dropped) replaces req.body.
 */
const { z } = require("zod")
const { optionalCode } = require("./gallerycode")

// name@domain.tld, with no quotes, brackets, commas, semicolons or colons: those let a mailer read one
// address as another (or as several), so mail could go somewhere the account doesn't name.
const EMAIL = /^[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?\.)+(?:[\p{L}\p{M}]{2,}|xn--[a-z0-9-]+)$/u

/** Lower case, trimmed, one Unicode form: how every address is stored and compared. */
const normaliseEmail = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase()

// The passwords leaked most often; anything here is refused however long it is.
const COMMON = new Set(
  `password password1 password123 passw0rd 12345678 123456789 1234567890 11111111 00000000 qwertyui qwerty123
  qwertyuiop iloveyou sunshine princess football baseball welcome welcome1 abc12345 abcd1234 letmein1 trustno1
  dragon123 monkey123 admin123 administrator changeme photography photographer wedding2024 wedding2025 wedding2026
  actionify 1q2w3e4r 1qaz2wsx zaq12wsx asdfghjk asdf1234 superman batman123 starwars whatever`.split(/\s+/),
)

/**
 * Why a new password isn't good enough, or "" when it is. Shared by the schemas below and
 * the command-line user script.
 */
function passwordProblem(password, { email = "", name = "" } = {}) {
  if (!password) return "Choose a password."
  if (password.length < 8) return "Use at least 8 characters."
  // bcrypt only reads the first 72 bytes; anything after would be silently ignored.
  if (Buffer.byteLength(password, "utf8") > 72) return "Use at most 72 characters."
  const lower = password.toLowerCase()
  if (/^(.)\1+$/.test(password) || COMMON.has(lower)) return "That password is too easy to guess. Choose another."
  const local = normaliseEmail(email).split("@")[0]
  if (local.length >= 4 && lower.includes(local)) return "Don't use your email address in your password."
  const first = String(name).trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  if (first.length >= 4 && lower === first) return "Don't use your name as your password."
  return ""
}

/* ---------- Fields ---------- */

const email = z
  .string({ error: "Enter your email address." })
  .transform(normaliseEmail)
  .pipe(
    z
      .string()
      .min(1, "Enter your email address.")
      .max(254, "That email address is too long.")
      .regex(EMAIL, "Enter an email address like name@example.com."),
  )

/** A password being typed to sign in: never checked for strength, only bounded. */
const currentPassword = z.string({ error: "Enter your password." }).min(1, "Enter your password.").max(1024, "That password is too long.")

/** A new password: strength is checked with the rest of the form (it needs the email and name). */
const newPassword = z.string({ error: "Choose a password." }).max(1024, "Use at most 72 characters.")

const name = z
  .string({ error: "Enter your name." })
  .transform((v) => v.normalize("NFKC").replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(2, "Enter your name.")
      .max(100, "Use at most 100 characters for your name.")
      // no control characters or angle brackets (names are shown in emails and the panel)
      .regex(/^[^\p{Cc}\p{Cf}<>]+$/u, "Use letters, spaces and simple punctuation in your name."),
  )

/** The emailed link's token: 43 URL-safe characters (utils/link-token.js). */
const token = z
  .string({ error: "This link is not valid. Ask for a new one." })
  .regex(/^[A-Za-z0-9_-]{20,200}$/, "This link is not valid. Ask for a new one.")

/** Adds the strength problem (if any) to `password`, knowing the email and name. */
const strongPassword = (field = "password") => (data, ctx) => {
  const problem = passwordProblem(data[field], { email: data.email, name: data.name })
  if (problem) ctx.addIssue({ code: "custom", path: [field], message: problem })
}

/* ---------- Schemas, one per route ---------- */

/** POST /login: the Sign in tab. */
const signInSchema = z.object({
  email,
  password: currentPassword,
  remember: z.boolean().optional().default(false),
})

/** POST /signup: the Create account tab. The gallery code is optional. */
const signUpSchema = z
  .object({
    name,
    email,
    password: newPassword,
    code: optionalCode, // a gallery code (validators/gallerycode.js)
    terms: z.literal(true, { error: "Accept the terms of service to create an account." }),
  })
  .superRefine(strongPassword())

/** POST /forgot-password and /resend-verification. */
const emailSchema = z.object({ email })

/** POST /verify-email and /reset-password/check. */
const tokenSchema = z.object({ token })

/** POST /reset-password: the page the emailed link opens (the service checks again against the account's email and name). */
const resetPasswordSchema = z.object({ token, password: newPassword }).superRefine(strongPassword())

/** POST /change-password, signed in. */
const changePasswordSchema = z
  .object({ currentPassword, password: newPassword })
  .refine((d) => d.currentPassword !== d.password, { path: ["password"], message: "Choose a password you aren't using now." })
  .superRefine(strongPassword())

/**
 * A Nepal mobile number, as the users table keeps it: "+9779812345678". Typed as 9812345678,
 * 9779812345678 or +977 981-234 5678; blank removes it.
 */
const mobile = z
  .union([z.string().max(24, "Enter a mobile number like 9812345678."), z.null()])
  .transform((v) => {
    const digits = String(v ?? "").replace(/[\s().-]/g, "")
    if (!digits) return null
    if (/^9[78]\d{8}$/.test(digits)) return `+977${digits}`
    if (/^9779[78]\d{8}$/.test(digits)) return `+${digits}`
    return digits
  })
  .refine((v) => v === null || /^\+9779[78]\d{8}$/.test(v), "Enter a Nepal mobile number like 9812345678.")

/** PATCH /me: the profile on the panel's Settings page. The email and role aren't yours to change here. */
const updateMeSchema = z.object({ name, mobile: mobile.optional() })

module.exports = {
  signInSchema,
  signUpSchema,
  emailSchema,
  tokenSchema,
  resetPasswordSchema,
  changePasswordSchema,
  updateMeSchema,
  passwordProblem,
  normaliseEmail,
}
