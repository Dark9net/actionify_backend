/**
 * Reads the strings in backend/.env, checks them and turns them into typed
 * values (numbers, booleans, durations). Every other file imports this (or
 * dbconfig.js), never process.env, so a missing or bad value stops the server
 * at startup with one clear message.
 */
const path = require("node:path")
const dotenv = require("dotenv")

// .env sits in backend/, two levels up from src/config/.
dotenv.config({ path: path.resolve(__dirname, "../../.env"), quiet: true })

const problems = []

/** The trimmed value, or undefined when unset or blank. */
function read(name) {
  const value = process.env[name]
  return value === undefined || value.trim() === "" ? undefined : value.trim()
}

/** A value that must be set (blank counts as missing). */
function required(name) {
  const value = read(name)
  if (value === undefined) problems.push(`${name} is missing`)
  return value ?? ""
}

/** A value with a default when unset. */
function optional(name, fallback) {
  return read(name) ?? fallback
}

/** A whole number within [min, max], with a default when unset. */
function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = read(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`)
    return fallback
  }
  return value
}

/** true/false, 1/0, yes/no, with a default when unset. */
function bool(name, fallback) {
  const raw = read(name)
  if (raw === undefined) return fallback
  const value = raw.toLowerCase()
  if (["true", "1", "yes"].includes(value)) return true
  if (["false", "0", "no"].includes(value)) return false
  problems.push(`${name} must be true or false (got "${raw}")`)
  return fallback
}

/** One of a fixed set of values. */
function oneOf(name, allowed, fallback) {
  const value = optional(name, fallback)
  if (!allowed.includes(value)) problems.push(`${name} must be one of ${allowed.join(", ")} (got "${value}")`)
  return value
}

/** A signing secret: required, at least `min` characters. The value never appears in messages. */
function secret(name, min = 32) {
  const value = required(name)
  if (value && value.length < min) {
    problems.push(`${name} must be at least ${min} characters (has ${value.length}); generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
  }
  return value
}

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/**
 * A token lifetime such as "15m", "12h" or "30d". A unit is required: to the
 * JWT library a bare "60" means 60 milliseconds. Returns the text (for the JWT
 * library) and its length in ms (for cookie Max-Age).
 */
function duration(name, fallback) {
  const text = optional(name, fallback)
  const match = /^(\d+)\s*(s|m|h|d|w)$/.exec(text)
  if (!match || Number(match[1]) === 0) {
    problems.push(`${name} must be a number with a unit s, m, h, d or w, like "15m" or "30d" (got "${text}")`)
    return { text: fallback, ms: Number(/^\d+/.exec(fallback)[0]) * UNIT_MS[fallback.slice(-1)] }
  }
  return { text, ms: Number(match[1]) * UNIT_MS[match[2]] }
}

const UNIT_BYTES = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }

/** An amount of storage such as "10GB" or "1.5 TB" (1 GB = 1024 MB, as Cloudflare's dashboard counts). Returns bytes. */
function bytes(name, fallback) {
  const text = optional(name, fallback)
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i.exec(text)
  if (!match || Number(match[1]) === 0) {
    problems.push(`${name} must be an amount with a unit B, KB, MB, GB or TB, like "10GB" (got "${text}")`)
    const [, n, unit] = /^(\d+(?:\.\d+)?)\s*([A-Z]+)$/i.exec(fallback)
    return Math.round(Number(n) * UNIT_BYTES[unit.toUpperCase()])
  }
  return Math.round(Number(match[1]) * UNIT_BYTES[match[2].toUpperCase()])
}

/** A cookie name: the characters RFC 6265 allows in a token. */
function cookieName(name, fallback) {
  const value = optional(name, fallback)
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
    problems.push(`${name} has characters a cookie name can't contain (got "${value}")`)
  }
  return value
}

/* ---------- App ---------- */

const NODE_ENV = oneOf("NODE_ENV", ["development", "production"], "development")
const isProduction = NODE_ENV === "production"
const PORT = int("PORT", 5000, { min: 1, max: 65535 })

/* ---------- MySQL ---------- */

const DB_HOST = optional("MYSQL_HOST", "localhost")
const DB_PORT = int("MYSQL_PORT", 3306, { min: 1, max: 65535 })
const DB_USER = required("MYSQL_USERNAME")
// Must be present in .env; may be blank for a local server without a password (never in production).
const DB_PASSWORD = process.env.MYSQL_PASSWORD
if (DB_PASSWORD === undefined) problems.push("MYSQL_PASSWORD is missing (leave it blank for a local server without one)")
const DB_NAME = required("MYSQL_DATABASE")
if (DB_NAME && !/^[A-Za-z0-9_$]{1,64}$/.test(DB_NAME)) {
  problems.push(`MYSQL_DATABASE may only use letters, digits, _ and $ (got "${DB_NAME}")`)
}
const DB_CONNECTION_LIMIT = int("DB_CONNECTION_LIMIT", 10, { min: 1, max: 1000 })
const DB_SSL = bool("DB_SSL", false)
// mysql2 accepts "local", "Z" (UTC) or an offset like "+05:30"; zone names such as "UTC" are not supported.
const DB_TIMEZONE = optional("DB_TIMEZONE", "Z").replace(/^z$/, "Z")
if (!/^(local|Z|[+-](0\d|1[0-4]):[0-5]\d)$/.test(DB_TIMEZONE)) {
  problems.push(`DB_TIMEZONE must be "local", "Z" or an offset like "+05:30" (got "${DB_TIMEZONE}")`)
}
if (PORT === DB_PORT && ["localhost", "127.0.0.1", "::1"].includes(DB_HOST)) {
  problems.push(`PORT and MYSQL_PORT are both ${PORT}; the API and MySQL can't share a port on this machine`)
}

// DATABASE_URL (read by Prisma) repeats the MYSQL_* values. When it's set it must
// agree with them, so the app and Prisma can never talk to different databases.
const DATABASE_URL = optional("DATABASE_URL", "")
if (DATABASE_URL) {
  try {
    const url = new URL(DATABASE_URL)
    const differs = []
    if (url.protocol !== "mysql:") differs.push(`protocol (${url.protocol} instead of mysql:)`)
    if (url.hostname !== DB_HOST) differs.push("host (MYSQL_HOST)")
    if (Number(url.port || 3306) !== DB_PORT) differs.push("port (MYSQL_PORT)")
    if (decodeURIComponent(url.username) !== DB_USER) differs.push("user (MYSQL_USERNAME)")
    if (decodeURIComponent(url.password) !== (DB_PASSWORD ?? "")) differs.push("password (MYSQL_PASSWORD)")
    if (decodeURIComponent(url.pathname.slice(1)) !== DB_NAME) differs.push("database (MYSQL_DATABASE)")
    if (differs.length) problems.push(`DATABASE_URL doesn't match the MYSQL_* values: ${differs.join(", ")}`)
  } catch {
    problems.push("DATABASE_URL is not a valid URL (expected mysql://user:password@host:port/database)")
  }
}

/* ----------  auth ---------- */

const JWT_ACCESS_SECRET = secret("SECRET_KEY")
const JWT_REFRESH_SECRET = secret("REFRESH_TOKEN")
if (JWT_ACCESS_SECRET && JWT_ACCESS_SECRET === JWT_REFRESH_SECRET) {
  problems.push("SECRET_KEY and REFRESH_TOKEN must be different, or a refresh token would pass as an access token")
}

const JWT_ACCESS_EXPIRES_IN = duration("JWT_ACCESS_EXPIRES_IN", "15m")
const JWT_REFRESH_EXPIRES_IN = duration("JWT_REFRESH_EXPIRES_IN", "30d")
if (JWT_REFRESH_EXPIRES_IN.ms <= JWT_ACCESS_EXPIRES_IN.ms) {
  problems.push("JWT_REFRESH_EXPIRES_IN must be longer than JWT_ACCESS_EXPIRES_IN")
}

const LOGIN_MAX_FAILED_ATTEMPTS = int("MAX_FAILED_ATTEMPTS", 5, { min: 1, max: 20 })
const LOGIN_LOCK_MINUTES = int("LOCK_MINUTES", 30, { min: 1, max: 1440 })

const COOKIE_ACCESS = cookieName("ACCESS_COOKIE_NAME", "access")
const COOKIE_REFRESH = cookieName("REFRESH_COOKIE_NAME", "refresh")
const COOKIE_CSRF = cookieName("CSRF_COOKIE_NAME", "csrf")
const COOKIE_GALLERY = cookieName("GALLERY_COOKIE_NAME", "gallery")
if (new Set([COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_CSRF, COOKIE_GALLERY]).size !== 4) {
  problems.push("ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME and GALLERY_COOKIE_NAME must all be different")
}

/* ---------- Gallery codes (services/gallerycode.js) ---------- */

// Wrong codes from one IP within the window before that IP is blocked, and for how long.
const GALLERY_CODE_MAX_ATTEMPTS = int("GALLERY_CODE_MAX_ATTEMPTS", 5, { min: 1, max: 50 })
const GALLERY_CODE_WINDOW_MINUTES = int("GALLERY_CODE_WINDOW_MINUTES", 15, { min: 1, max: 1440 })
const GALLERY_CODE_BLOCK_MINUTES = int("GALLERY_CODE_BLOCK_MINUTES", 30, { min: 1, max: 10080 })
// How long a gallery stays open after its code was entered (24 hours): then the dashboard goes back
// to the sign-in page and asks for the code again, in this browser and on the client's account.
const GALLERY_SESSION_HOURS = int("GALLERY_SESSION_HOURS", 24, { min: 1, max: 720 })

/* ---------- Passwords ---------- */

// bcrypt cost factor: each +1 doubles the time per hash (12 is about 250 ms).
// Below 10 is too easy to brute-force; above 15 makes every login slow.
const PASSWORD_SALT_ROUND = int(read("PASSWORD_SALT_ROUNDS") ? "PASSWORD_SALT_ROUNDS" : "PASSWORD_SALT_ROUND", 12, { min: 10, max: 15 })

/* ---------- App links ---------- */

const APP_NAME = optional("APP_NAME", "Actionify")
// The client's address: links in emails (e.g. "Log in") open here.
const APP_URL = optional("APP_URL", "http://localhost:5173").replace(/\/+$/, "")
try {
  if (!/^https?:$/.test(new URL(APP_URL).protocol)) throw new Error()
} catch {
  problems.push(`APP_URL must be an http(s) address like "https://app.example.com" (got "${APP_URL}")`)
}

// The browser origins allowed to send POSTs (checked alongside the CSRF token): APP_URL's, plus
// any in ALLOWED_ORIGINS (comma separated). In development every http://localhost:<port> is allowed.
const ALLOWED_ORIGINS = [APP_URL, ...optional("ALLOWED_ORIGINS", "").split(",")]
  .map((o) => o.trim())
  .filter(Boolean)
  .map((o) => {
    try {
      return new URL(o).origin
    } catch {
      problems.push(`ALLOWED_ORIGINS has "${o}", which isn't an address like https://studio.example`)
      return null
    }
  })
  .filter(Boolean)

// Behind nginx, Caddy or a load balancer: how many proxies sit in front, so req.ip is the
// client's (rate limits and the security log depend on it). 0 when the API faces the internet.
const TRUST_PROXY = int("TRUST_PROXY", 0, { min: 0, max: 10 })

// Encrypts what's kept at rest (gallery codes). Without it a key is derived from SECRET_KEY; set it
// on its own so SECRET_KEY can be rotated without losing what's encrypted.
const DATA_KEY = read("DATA_KEY") ? secret("DATA_KEY") : ""

/* ---------- Email confirmation link ---------- */

// How long the link in the sign-up email works.
const EMAIL_VERIFY_EXPIRES_IN = duration("EMAIL_VERIFY_EXPIRES_IN", "24h")

/* ---------- Password reset link ---------- */

// How long the "Reset your password" link works. Short: whoever holds it can take over the account.
const PASSWORD_RESET_EXPIRES_IN = duration("PASSWORD_RESET_EXPIRES_IN", "1h")
if (PASSWORD_RESET_EXPIRES_IN.ms > 24 * 3_600_000) problems.push("PASSWORD_RESET_EXPIRES_IN can be at most 24h")

/* ---------- One-time codes (OTP: password reset, 2FA) ---------- */

// How long an emailed code works, and how many wrong guesses it allows before a new one is needed.
const OTP_EXPIRES_IN = duration("OTP_EXPIRES_IN", "10m")
const OTP_MAX_ATTEMPTS = int("OTP_MAX_ATTEMPTS", 5, { min: 1, max: 10 })
if (OTP_EXPIRES_IN.ms > 24 * 3_600_000) problems.push("OTP_EXPIRES_IN can be at most 24h (short codes must not live long)")

// The terms a new account accepts (stored on the user). Change it when the Terms page changes.
const TERMS_VERSION = optional("TERMS_VERSION", "2026-11-10")
if (TERMS_VERSION.length > 20) problems.push(`TERMS_VERSION must be at most 20 characters (got "${TERMS_VERSION}")`)

/* ---------- Mail (SMTP) ---------- */

// Without SMTP_HOST (development) emails are printed in the server console instead of sent.
const SMTP_HOST = optional("SMTP_HOST", "")
const SMTP_PORT = int("SMTP_PORT", 587, { min: 1, max: 65535 })
const SMTP_SECURE = bool("SMTP_SECURE", SMTP_PORT === 465) // true: TLS from the start (port 465)
const SMTP_USER = optional("SMTP_USER", "")
const SMTP_PASSWORD = optional("SMTP_PASSWORD", "")
// The sender. Mail servers check it, so with SMTP it must be an address the server
// may send as (usually SMTP_USER itself, which is the default). MAIL_FROM is an older alias.
const smtpUserIsAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(SMTP_USER)
const MAIL_FROM =
  read("SMTP_FROM") ??
  read("MAIL_FROM") ??
  (smtpUserIsAddress ? `"${APP_NAME}" <${SMTP_USER}>` : `"${APP_NAME}" <no-reply@localhost>`)
if (SMTP_HOST && /@localhost>?$/i.test(MAIL_FROM)) {
  problems.push(`SMTP_FROM must be a real sender address your mail server accepts, like "${APP_NAME} <no-reply@yourdomain.com>"`)
}

/* ---------- Redis ---------- */

// Off unless REDIS_ENABLED=true. When on, the server won't start without it (like MySQL).
const REDIS_ENABLED = bool("REDIS_ENABLED", false)
const REDIS_URL = optional("REDIS_URL", "redis://127.0.0.1:6379")
if (REDIS_ENABLED) {
  let url = null
  try {
    url = new URL(REDIS_URL)
  } catch {
    // reported below
  }
  // the path may only be a database number: redis://host:6379/0
  if (!url || !["redis:", "rediss:"].includes(url.protocol) || !url.hostname || !/^(\/\d*)?$/.test(url.pathname)) {
    problems.push("REDIS_URL must look like redis://host:6379 (or rediss:// for TLS)")
  }
}

/* ---------- Cloudflare R2 (config/r2config.js) ---------- */

// Photographs live in an R2 bucket, reached through its S3-compatible API. R2 stays off until a key
// is set: once any of R2_ACCOUNT_ID, R2_ACCESS_KEY or R2_SECRET_ACCESS_KEY has a value, all the
// values it needs are checked here. Keys come from Cloudflare > R2 > Manage API tokens.

/** The first of several names that has a value (older names in .env still work). A bare "https://" counts as blank. */
function firstOf(...names) {
  for (const name of names) {
    const value = read(name)
    if (value !== undefined && !/^https?:\/\/$/i.test(value)) return { name, value }
  }
  return { name: names[0], value: undefined }
}

const r2Account = firstOf("R2_ACCOUNT_ID")
const r2KeyId = firstOf("R2_ACCESS_KEY")
const r2Secret = firstOf("R2_SECRET_ACCESS_KEY")
const r2Endpoint = firstOf("CLOUDFLARE_S3_API_KEY")
const R2_ENABLED = [r2Account, r2KeyId, r2Secret].some((v) => v.value !== undefined)

const R2_ACCOUNT_ID = r2Account.value ?? ""
const R2_ACCESS_KEY_ID = r2KeyId.value ?? ""
const R2_SECRET_ACCESS_KEY = r2Secret.value ?? ""
const R2_BUCKET = optional("R2_BUCKET_NAME", "")
// Data kept in a jurisdiction lives behind its own endpoint: blank (default), "eu" or "fedramp".
const R2_JURISDICTION = oneOf("R2_JURISDICTION", ["", "eu", "fedramp"], "")
// How long a signed link to upload or view one photograph works (at most 7 days, S3's limit).
const R2_SIGNED_URL_EXPIRES_IN = duration("R2_SIGNED_URL_EXPIRES_IN", "15m")
if (R2_SIGNED_URL_EXPIRES_IN.ms > 7 * 86_400_000) problems.push("R2_SIGNED_URL_EXPIRES_IN can be at most 7d")

let R2_ENDPOINT = ""
if (R2_ENABLED) {
  if (!R2_ACCESS_KEY_ID) problems.push("R2_ACCESS_KEY is missing (the Access Key ID of the R2 API token)")
  else if (!/^[0-9a-f]{32}$/i.test(R2_ACCESS_KEY_ID)) {
    problems.push(`${r2KeyId.name} must be the token's Access Key ID: 32 letters and digits (has ${R2_ACCESS_KEY_ID.length}); the "Token value" is not it`)
  }
  if (!R2_SECRET_ACCESS_KEY) problems.push("R2_SECRET_ACCESS_KEY is missing (the Secret Access Key of the R2 API token)")
  else if (!/^[0-9a-f]{64}$/i.test(R2_SECRET_ACCESS_KEY)) {
    problems.push(`R2_SECRET_ACCESS_KEY must be the token's Secret Access Key: 64 letters and digits (has ${R2_SECRET_ACCESS_KEY.length})`)
  }
  if (R2_ACCOUNT_ID && !/^[0-9a-f]{32}$/i.test(R2_ACCOUNT_ID)) {
    problems.push(`R2_ACCOUNT_ID must be the 32-character Account ID shown on the R2 overview page (has ${R2_ACCOUNT_ID.length})`)
  }
  // Bucket names: 3-63 lowercase letters, digits and hyphens, starting and ending with a letter or digit.
  if (!R2_BUCKET) problems.push("R2_BUCKET_NAME is missing")
  else if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(R2_BUCKET)) {
    problems.push(`R2_BUCKET_NAME may only use lowercase letters, digits and hyphens, 3 to 63 of them (got "${R2_BUCKET}")`)
  }

  if (r2Endpoint.value) {
    // The dashboard's "S3 API" address ends with the bucket (…r2.cloudflarestorage.com/<bucket>):
    // that path is dropped, the client adds the bucket itself.
    try {
      const url = new URL(r2Endpoint.value)
      const urlPath = url.pathname.replace(/\/+$/, "")
      if (url.protocol !== "https:") problems.push(`${r2Endpoint.name} must start with https://`)
      else if (urlPath && urlPath !== `/${R2_BUCKET}`) problems.push(`${r2Endpoint.name} must be the address only, like https://<account id>.r2.cloudflarestorage.com (got the path "${urlPath}")`)
      else {
        const account = /^([0-9a-f]{32})\.(?:(?:eu|fedramp)\.)?r2\.cloudflarestorage\.com$/i.exec(url.hostname)?.[1]
        if (account && R2_ACCOUNT_ID && account.toLowerCase() !== R2_ACCOUNT_ID.toLowerCase()) {
          problems.push(`${r2Endpoint.name} is for another account than R2_ACCOUNT_ID`)
        }
        R2_ENDPOINT = url.origin
      }
    } catch {
      problems.push(`${r2Endpoint.name} is not an address like https://<account id>.r2.cloudflarestorage.com`)
    }
  } else if (R2_ACCOUNT_ID) {
    R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.${R2_JURISDICTION ? `${R2_JURISDICTION}.` : ""}r2.cloudflarestorage.com`
  } else {
    problems.push("R2_ACCOUNT_ID is missing (or set R2_ENDPOINT to the bucket's S3 API address)")
  }
}

/* ---------- R2 usage and plan (services/R2storage.js) ---------- */

// What R2 stores and how many operations it has served this month come from Cloudflare's GraphQL
// Analytics API, which the R2 S3 keys above can't read. It needs an API token of its own:
// Cloudflare > My Profile > API Tokens > Create Token > Custom, permission Account > Account
// Analytics > Read, for this account. Without one, the stored size is read from the bucket itself
// and operations are not shown.
const CLOUDFLARE_API_TOKEN = optional("CLOUDFLARE_API_TOKEN", "")
if (CLOUDFLARE_API_TOKEN && !/^[A-Za-z0-9_-]{30,}$/.test(CLOUDFLARE_API_TOKEN)) {
  problems.push(`CLOUDFLARE_API_TOKEN doesn't look like a Cloudflare API token (letters, digits, - and _, ${CLOUDFLARE_API_TOKEN.length} characters given)`)
}

// What the plan includes each month. R2 has no hard limit: past these it bills per use. The
// defaults are R2's free tier (Standard storage): 10 GB-month, 1 million Class A operations
// (writes, lists) and 10 million Class B operations (reads).
const R2_PLAN_STORAGE_BYTES = bytes("R2_PLAN_STORAGE", "10GB")
const R2_PLAN_CLASS_A = int("R2_PLAN_CLASS_A", 1_000_000, { min: 1 })
const R2_PLAN_CLASS_B = int("R2_PLAN_CLASS_B", 10_000_000, { min: 1 })
// The day of the month the Cloudflare bill starts (UTC). Usage counts from it.
const R2_BILLING_DAY = int("R2_BILLING_DAY", 1, { min: 1, max: 28 })
// How long one answer from Cloudflare is reused (analytics trail a few minutes behind anyway).
const R2_USAGE_CACHE = duration("R2_USAGE_CACHE", "5m")
if (R2_USAGE_CACHE.ms < 60_000) problems.push("R2_USAGE_CACHE must be at least 1m")

/* ---------- Production-only rules ---------- */

if (isProduction) {
  if (!DB_PASSWORD) problems.push("MYSQL_PASSWORD can't be blank in production")
  if (DB_USER === "root") problems.push("MYSQL_USERNAME can't be root in production; create a user with access to this database only")
  if (!SMTP_HOST) problems.push("SMTP_HOST is required in production, or verification codes are never sent")
  if (!APP_URL.startsWith("https://")) problems.push("APP_URL must start with https:// in production")
}

if (problems.length) {
  throw new Error(`Invalid environment in backend/.env:\n${problems.map((p) => `  - ${p}`).join("\n")}`)
}

module.exports = Object.freeze({
  NODE_ENV,
  IS_PRODUCTION: isProduction,
  PORT,

  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD: DB_PASSWORD ?? "",
  DB_NAME,
  DB_CONNECTION_LIMIT,
  DB_SSL,
  DB_TIMEZONE,
  DATABASE_URL,

  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  /** Text for the JWT library ("15m") and length in ms (cookie Max-Age). */
  JWT_ACCESS_EXPIRES_IN: Object.freeze(JWT_ACCESS_EXPIRES_IN),
  JWT_REFRESH_EXPIRES_IN: Object.freeze(JWT_REFRESH_EXPIRES_IN),
  LOGIN_MAX_FAILED_ATTEMPTS,
  LOGIN_LOCK_MINUTES,
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  COOKIE_CSRF,
  COOKIE_GALLERY,
  GALLERY_CODE_MAX_ATTEMPTS,
  GALLERY_CODE_WINDOW_MINUTES,
  GALLERY_CODE_BLOCK_MINUTES,
  GALLERY_SESSION_HOURS,

  PASSWORD_SALT_ROUND,

  EMAIL_VERIFY_EXPIRES_IN: Object.freeze(EMAIL_VERIFY_EXPIRES_IN),
  PASSWORD_RESET_EXPIRES_IN: Object.freeze(PASSWORD_RESET_EXPIRES_IN),
  OTP_EXPIRES_IN: Object.freeze(OTP_EXPIRES_IN),
  OTP_MAX_ATTEMPTS,
  TERMS_VERSION,

  APP_NAME,
  APP_URL,
  ALLOWED_ORIGINS: Object.freeze([...new Set(ALLOWED_ORIGINS)]),
  TRUST_PROXY,
  DATA_KEY,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASSWORD,
  MAIL_FROM,

  REDIS_ENABLED,
  REDIS_URL,

  /** False until R2 keys are set in .env; config/r2config.js then has no client. */
  R2_ENABLED,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_JURISDICTION,
  /** https://<account id>.r2.cloudflarestorage.com (origin only; the bucket isn't in it). */
  R2_ENDPOINT,
  R2_SIGNED_URL_EXPIRES_IN: Object.freeze(R2_SIGNED_URL_EXPIRES_IN),

  /** Reads R2's usage from Cloudflare's GraphQL Analytics API (blank: read from the bucket instead). */
  CLOUDFLARE_API_TOKEN,
  /** What the plan includes each month (defaults: R2's free tier). */
  R2_PLAN_STORAGE_BYTES,
  R2_PLAN_CLASS_A,
  R2_PLAN_CLASS_B,
  R2_BILLING_DAY,
  R2_USAGE_CACHE: Object.freeze(R2_USAGE_CACHE),
})
