/**
 * Small JSON cache on the shared Redis client (config/redis.js).
 *
 * Never required for correctness: with Redis off (REDIS_ENABLED=false) or
 * unreachable, reads are misses and writes/deletes do nothing, so callers fall
 * back to the database. Failures are logged, never thrown.
 *
 * Keys used by the app:
 *   sess:{sessionId}       the live session behind an access token (middleware/auth.js)
 *   rt:grace:{tokenHash}   a just-rotated refresh token, accepted for a few seconds (utils/session.js)
 *   rl:*                   rate-limit counters (middleware/rate-limit.js)
 */
const { redis } = require("../config/redis")

const ready = () => Boolean(redis?.isReady)

function warn(action, key, err) {
  console.warn(`Redis ${action} ${key} failed: ${err.message}`)
}

/** The cached value, or undefined on a miss (or when Redis is unavailable). */
async function getJson(key) {
  if (!ready()) return undefined
  try {
    const raw = await redis.get(key)
    return raw === null ? undefined : JSON.parse(raw)
  } catch (err) {
    warn("GET", key, err)
    return undefined
  }
}

/** Stores `value` for `ttlSeconds`. */
async function setJson(key, value, ttlSeconds) {
  if (!ready()) return
  try {
    await redis.set(key, JSON.stringify(value), { EX: Math.max(1, Math.ceil(ttlSeconds)) })
  } catch (err) {
    warn("SET", key, err)
  }
}

/** Deletes one or more keys. */
async function del(...keys) {
  const list = keys.flat().filter(Boolean)
  if (!ready() || list.length === 0) return
  try {
    await redis.del(list)
  } catch (err) {
    warn("DEL", list.join(","), err)
  }
}

module.exports = { getJson, setJson, del, ready }
