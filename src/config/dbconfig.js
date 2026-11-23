/**
 * MySQL connection: options built from the .env values in ./env.js, and the
 * one shared connection pool the whole server uses.
 *
 *   const { pool } = require("../config/dbconfig")
 *   const [rows] = await pool.execute("SELECT * FROM invoices WHERE id = ?", [id])
 *
 * Always pass values as `?` parameters, never by building SQL strings.
 */
const mysql = require("mysql2/promise")
const env = require("./env")

/** mysql://user:password@host:port/database, with the credentials URL-encoded. */
function databaseUrl() {
  if (env.DATABASE_URL) return env.DATABASE_URL
  const user = encodeURIComponent(env.DB_USER)
  const password = env.DB_PASSWORD ? `:${encodeURIComponent(env.DB_PASSWORD)}` : ""
  const ssl = env.DB_SSL ? "?sslaccept=strict" : ""
  return `mysql://${user}${password}@${env.DB_HOST}:${env.DB_PORT}/${encodeURIComponent(env.DB_NAME)}${ssl}`
}

// Prisma (and other tools) read DATABASE_URL; provide it when only the MYSQL_* values are set.
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = databaseUrl()

/** Options for mysql2's createPool(), all from .env. */
const dbConfig = Object.freeze({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: env.DB_CONNECTION_LIMIT,
  queueLimit: 0,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  timezone: env.DB_TIMEZONE,
  charset: "utf8mb4",
  // Money: DECIMAL and BIGINT come back as strings so no cents are lost to floating point.
  decimalNumbers: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  // DATE columns as "YYYY-MM-DD" (what the client sends and expects), not shifted Date objects.
  dateStrings: ["DATE"],
  ssl: env.DB_SSL ? { rejectUnauthorized: true } : undefined,
})

/** The shared pool. Connections open lazily on the first query. */
const pool = mysql.createPool(dbConfig)

// mysql2's `timezone` only converts JS Dates. Give each MySQL session the same
// zone so NOW() / CURRENT_TIMESTAMP and the dates the app sends agree.
const sessionTimeZone = env.DB_TIMEZONE === "Z" ? "+00:00" : env.DB_TIMEZONE === "local" ? null : env.DB_TIMEZONE
if (sessionTimeZone) {
  pool.on("connection", (conn) => {
    conn.query("SET time_zone = ?", [sessionTimeZone], (err) => {
      if (err) console.error("Couldn't set the MySQL session time zone:", err.message)
    })
  })
}

/**
 * Runs `fn(conn)` in a transaction: commits when it resolves, rolls back when it throws.
 *
 *   await withTransaction(async (conn) => { await conn.execute(...); await conn.execute(...) })
 */
async function withTransaction(fn) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (err) {
    await conn.rollback().catch(() => {})
    throw err
  } finally {
    conn.release()
  }
}

const RETRYABLE = new Set(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "PROTOCOL_CONNECTION_LOST", "ER_CON_COUNT_ERROR"])

/** Plain-language reason for a failed connection (never includes the password). */
function describe(err) {
  switch (err.code) {
    case "ECONNREFUSED":
      return `nothing is listening on ${env.DB_HOST}:${env.DB_PORT}; is MySQL running? (MYSQL_HOST, MYSQL_PORT)`
    case "ENOTFOUND":
      return `host "${env.DB_HOST}" not found (MYSQL_HOST)`
    case "ETIMEDOUT":
      return `timed out reaching ${env.DB_HOST}:${env.DB_PORT}`
    case "ER_ACCESS_DENIED_ERROR":
      return `user "${env.DB_USER}" was refused; check MYSQL_USERNAME and MYSQL_PASSWORD`
    case "ER_BAD_DB_ERROR":
      return `database "${env.DB_NAME}" doesn't exist; create it or fix MYSQL_DATABASE`
    case "ER_DBACCESS_DENIED_ERROR":
      return `user "${env.DB_USER}" has no access to database "${env.DB_NAME}"`
    default:
      return `${err.code ?? "error"}: ${err.message}`
  }
}

/**
 * Checks the database is reachable before the server accepts requests.
 * Retries connection errors a few times (MySQL may still be starting, e.g. in Docker);
 * wrong credentials or a missing database fail at once.
 */
async function connectDB({ attempts = 5, delayMs = 2_000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const conn = await pool.getConnection()
      try {
        const [[row]] = await conn.query("SELECT VERSION() AS version")
        return { version: row.version, host: env.DB_HOST, port: env.DB_PORT, database: env.DB_NAME }
      } finally {
        conn.release()
      }
    } catch (err) {
      const reason = describe(err)
      if (!RETRYABLE.has(err.code) || attempt >= attempts) {
        throw new Error(`Can't connect to MySQL: ${reason}`, { cause: err })
      }
      console.warn(`MySQL not ready (attempt ${attempt}/${attempts}): ${reason}; retrying in ${delayMs / 1000}s`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

/** True when a trivial query succeeds (for health checks). */
async function pingDB() {
  try {
    await pool.query("SELECT 1")
    return true
  } catch {
    return false
  }
}

/** Closes every pooled connection (on shutdown). */
function closeDB() {
  return pool.end()
}

module.exports = { pool, dbConfig, withTransaction, connectDB, pingDB, closeDB }
