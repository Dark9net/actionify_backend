/**
 * Redis connection: one shared client for the whole server, from REDIS_URL in .env.
 * Only created when REDIS_ENABLED=true; otherwise `redis` is null and the
 * functions below do nothing, so callers can fall back:
 *
 *   const { redis } = require("../config/redis")
 *   if (redis?.isReady) await redis.set("key", "value", { EX: 60 })
 *
 * At startup (connectRedis) a Redis that's still starting is retried a few
 * times; wrong credentials fail at once. Once running, a lost connection is
 * retried forever in the background (backoff up to 5 s), so a Redis restart
 * doesn't take the API down.
 */
const { createClient } = require("redis")
const env = require("./env")

/** host:port for messages (REDIS_URL may hold a password, which is never printed). */
const target = (() => {
  try {
    const url = new URL(env.REDIS_URL)
    return `${url.hostname}:${url.port || 6379}`
  } catch {
    return "REDIS_URL"
  }
})()

const STARTUP_ATTEMPTS = 5
const STARTUP_DELAY_MS = 2_000
const MAX_BACKOFF_MS = 5_000
/** Connection errors worth retrying at startup (Redis may still be starting). */
const RETRYABLE = new Set(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ECONNRESET", "EAI_AGAIN"])

/** True until the first successful connection: decides how failures are retried. */
let starting = true
/** Whether the last connection was ready, so an outage is logged once rather than on every retry. */
let wasReady = false

const redis = env.REDIS_ENABLED
  ? createClient({
      url: env.REDIS_URL,
      socket: {
        connectTimeout: 5_000,
        // Startup: a few tries, then give up (connectRedis reports why). Later: keep trying.
        reconnectStrategy: (retries, cause) => {
          if (starting) {
            if (!RETRYABLE.has(cause?.code) || retries >= STARTUP_ATTEMPTS - 1) return cause ?? new Error("Redis unavailable")
            console.warn(`Redis not ready (attempt ${retries + 1}/${STARTUP_ATTEMPTS}): ${describe(cause)}; retrying in ${STARTUP_DELAY_MS / 1000}s`)
            return STARTUP_DELAY_MS
          }
          return Math.min(2 ** retries * 100, MAX_BACKOFF_MS)
        },
      },
    })
  : null

/** Plain-language reason for a failed connection (never includes the password). */
function describe(err) {
  // node-redis wraps socket failures; the useful code is on the inner error.
  err = err?.socketError ?? err?.originalError ?? err
  const message = err?.message ?? String(err)
  switch (err?.code) {
    case "ECONNREFUSED":
      return `nothing is listening on ${target}; is Redis running? (REDIS_URL)`
    case "ENOTFOUND":
      return `host in REDIS_URL not found (${target})`
    case "ETIMEDOUT":
      return `timed out reaching ${target}`
  }
  if (/WRONGPASS|NOAUTH|invalid username-password/i.test(message)) return "Redis refused the username/password in REDIS_URL"
  if (/timeout/i.test(message)) return `timed out reaching ${target}`
  return `${err?.code ?? "error"}: ${message}`
}

if (redis) {
  // Without an "error" listener node-redis would crash the process on the first failure.
  redis.on("error", (err) => {
    if (starting) return // connectRedis reports startup failures
    if (wasReady) console.error(`Redis connection lost: ${describe(err)}; reconnecting…`)
    wasReady = false
  })
  redis.on("ready", () => {
    if (!starting && !wasReady) console.log(`Redis reconnected (${target})`)
    wasReady = true
  })
}

/**
 * Connects at startup. Resolves { enabled: false } when Redis is turned off, or
 * { enabled: true, version, target } once PING answers. Throws with a readable
 * reason otherwise.
 */
async function connectRedis() {
  if (!redis) return { enabled: false }
  try {
    await redis.connect()
    await redis.ping()
    const info = await redis.info("server")
    starting = false
    return { enabled: true, version: /redis_version:(\S+)/.exec(info)?.[1] ?? "unknown", target }
  } catch (err) {
    throw new Error(`Can't connect to Redis: ${describe(err)}`, { cause: err })
  }
}

/** "up", "down", or "disabled" (for health checks). */
async function pingRedis() {
  if (!redis) return "disabled"
  if (!redis.isReady) return "down"
  try {
    await redis.ping()
    return "up"
  } catch {
    return "down"
  }
}

/** Closes the connection on shutdown: waits for sent commands, or drops it if it never connected. */
async function closeRedis() {
  if (!redis?.isOpen) return
  starting = false
  if (redis.isReady) await redis.close()
  else redis.destroy()
}

module.exports = { redis, connectRedis, pingRedis, closeRedis }
