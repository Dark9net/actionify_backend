/**
 * Rate limits by IP and by email, counted in Redis (INCR on a key that expires
 * with the window), so limits hold across restarts and server instances.
 * Without Redis (REDIS_ENABLED=false, or Redis unreachable) the same counters
 * are kept in this process's memory instead.
 *
 *   router.post("/login", limit.login, validate(signInSchema), auth.login)
 *
 * Keys: rl:{name}:ip:{ip} and rl:{name}:email:{sha256(email)} (the address
 * itself is never stored). Over the limit: 429 RATE_LIMITED with Retry-After.
 * `failuresOnly`: a request that ends below 400 gives its count back, so only
 * failed attempts use up the allowance (e.g. wrong passwords).
 *
 * Behind a reverse proxy, set Express's "trust proxy" so req.ip is the client's.
 * (Per-account lockout after wrong passwords is separate: LOGIN_MAX_FAILED_ATTEMPTS.)
 */
const { redis } = require("../config/redis")
const { sha256 } = require("../utils/crypto")

const MINUTE = 60
const HOUR = 60 * MINUTE

/* ---------- Counter stores ---------- */

/** Redis: INCR, set the expiry only when the key is new (NX), read the time left. */
async function redisIncr(key, windowSeconds) {
  const [count, , ttl] = await redis.multi().incr(key).expire(key, windowSeconds, "NX").ttl(key).exec()
  return { count: Number(count), retryAfter: Math.max(1, Number(ttl)) }
}

async function redisDecr(key) {
  await redis.decr(key)
}

/** Fallback: the same counters in memory (lost on restart, not shared between instances). */
const memory = new Map()
let lastSweep = Date.now()

function memoryIncr(key, windowSeconds) {
  const now = Date.now()
  if (now - lastSweep > 60_000) {
    for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k)
    lastSweep = now
  }
  let entry = memory.get(key)
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowSeconds * 1000 }
    memory.set(key, entry)
  }
  entry.count += 1
  return { count: entry.count, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) }
}

function memoryDecr(key) {
  const entry = memory.get(key)
  if (entry && entry.count > 0) entry.count -= 1
}

let warned = false
async function incr(key, windowSeconds) {
  if (redis?.isReady) {
    try {
      return { ...(await redisIncr(key, windowSeconds)), store: "redis" }
    } catch (err) {
      if (!warned) console.warn(`Rate limit: Redis failed (${err.message}); counting in memory for now.`)
      warned = true
    }
  }
  return { ...memoryIncr(key, windowSeconds), store: "memory" }
}

async function decr(key, store) {
  if (store === "redis") await redisDecr(key).catch(() => {})
  else memoryDecr(key)
}

/* ---------- Middleware ---------- */

/** The email in the request body, normalised like the validators do (trimmed, lowercase). */
function emailOf(req) {
  const email = req.body?.email
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null
}

/**
 * @param {object} options
 * @param {string} options.name            key prefix, e.g. "login"
 * @param {number} options.windowSeconds   counting window
 * @param {number} options.perIp           attempts per IP in the window
 * @param {number} [options.perEmail]      attempts per email in the window (when the body has one)
 * @param {boolean} [options.failuresOnly] successful requests don't count
 */
function limiter({ name, windowSeconds, perIp, perEmail, failuresOnly = false }) {
  return async (req, res, next) => {
    const keys = [[`rl:${name}:ip:${req.ip}`, perIp]]
    const email = perEmail ? emailOf(req) : null
    if (email) keys.push([`rl:${name}:email:${sha256(email)}`, perEmail])

    const counted = []
    let retryAfter = 0
    for (const [key, max] of keys) {
      const { count, retryAfter: wait, store } = await incr(key, windowSeconds)
      counted.push([key, store])
      if (count > max) retryAfter = Math.max(retryAfter, wait)
    }

    if (retryAfter) {
      const minutes = Math.ceil(retryAfter / 60)
      res.set("Retry-After", String(retryAfter))
      return res.status(429).json({
        message: `Too many attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        code: "RATE_LIMITED",
        retryAfterSeconds: retryAfter,
      })
    }

    if (failuresOnly) {
      res.on("finish", () => {
        if (res.statusCode < 400) for (const [key, store] of counted) void decr(key, store)
      })
    }
    next()
  }
}

module.exports = {
  limiter,
  // Wrong passwords only, so a shared office or venue IP isn't blocked by normal use.
  login: limiter({ name: "login", windowSeconds: 15 * MINUTE, perIp: 20, perEmail: 8, failuresOnly: true }),
  signup: limiter({ name: "signup", windowSeconds: HOUR, perIp: 10, perEmail: 5 }),
  verifyEmail: limiter({ name: "verify-email", windowSeconds: 15 * MINUTE, perIp: 20 }),
  resendVerification: limiter({ name: "resend", windowSeconds: 15 * MINUTE, perIp: 5, perEmail: 3 }),
  // "Forgot password?": each request may send an email, so it's tight per inbox and per IP.
  reset: limiter({ name: "reset", windowSeconds: HOUR, perIp: 5, perEmail: 3 }),
  // The reset page: checking its link on load, then setting the password (no email in the body, so per IP).
  resetCheck: limiter({ name: "reset-check", windowSeconds: 15 * MINUTE, perIp: 30 }),
  resetPassword: limiter({ name: "reset-password", windowSeconds: 15 * MINUTE, perIp: 10 }),
  // Every page load refreshes once; this only stops a script hammering it.
  refresh: limiter({ name: "refresh", windowSeconds: 5 * MINUTE, perIp: 60 }),
  changePassword: limiter({ name: "change-password", windowSeconds: 15 * MINUTE, perIp: 10, failuresOnly: true }),
  // Gallery codes: a coarse net per IP. The real guard counts wrong codes and blocks the IP
  // (services/gallerycode.js, GALLERY_CODE_MAX_ATTEMPTS).
  openCode: limiter({ name: "open-code", windowSeconds: 15 * MINUTE, perIp: 30 }),
  // The dashboard checks in once a minute per open gallery.
  gallerySession: limiter({ name: "gallery-session", windowSeconds: 5 * MINUTE, perIp: 120 }),
  // The website's booking form: anyone may send one, so a few an hour per IP and per email.
  booking: limiter({ name: "booking", windowSeconds: HOUR, perIp: 10, perEmail: 5 }),
  // Staff writes: profile, gallery codes, roles.
  write: limiter({ name: "write", windowSeconds: 15 * MINUTE, perIp: 120 }),
  // Uploads: two calls per file (start, complete), one per 50 parts of a large file, and a wedding is a few thousand files.
  upload: limiter({ name: "upload", windowSeconds: 15 * MINUTE, perIp: 6000 }),
}
