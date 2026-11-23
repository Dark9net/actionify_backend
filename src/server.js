/**
 * Entry point: checks the .env values, connects to MySQL and Redis (when
 * REDIS_ENABLED=true), checks the R2 bucket (once its keys are set), then starts the HTTP server. Shuts down cleanly on Ctrl+C
 * or a stop signal (finishes open requests, then closes MySQL and Redis).
 *
 *   npm start        # node src/server.js
 *   npm run dev      # restarts on file changes
 */
const env = require("./config/env") // throws first if .env is invalid
const { connectDB, closeDB } = require("./config/dbconfig")
const { connectRedis, closeRedis } = require("./config/redis")
const { connectR2, closeR2 } = require("./config/r2config")
const { verifyMailer } = require("./config/mail")
const { ensureCatalog } = require("./models/role")
const app = require("./app")

async function start() {
  const db = await connectDB()
  console.log(`MySQL ${db.version} connected: ${db.database} on ${db.host}:${db.port}`)

  // Roles and permissions come from utils/roles.js. Without them role checks refuse everything,
  // but the server still starts so the problem can be read in the log.
  await ensureCatalog().then(
    () => console.log("Roles and permissions: up to date"),
    (err) => console.error(`Roles and permissions could not be seeded (${err.code ?? err.message}); check the roles tables from schema.sql.`),
  )

  const cache = await connectRedis()
  console.log(cache.enabled ? `Redis ${cache.version} connected on ${cache.target}` : "Redis: off (REDIS_ENABLED isn't true)")

  // Photo storage. A wrong key or bucket is reported but doesn't stop the API (logins, bookings and
  // codes don't need it); uploads answer "storage isn't set up" until it's fixed.
  await connectR2().then(
    (r2) => console.log(r2.enabled ? `R2: bucket ${r2.target} ready` : "R2: off (no R2 keys in .env yet)"),
    (err) => console.error(`${err.message}; photographs can't be uploaded or viewed until it's fixed.`),
  )

  // A broken SMTP login is reported but doesn't stop the API (codes can be resent later).
  const mail = await verifyMailer()
  if (mail.mode === "console") console.log("Mail: SMTP_HOST not set; emails (with their links) are printed here instead.")
  else if (mail.ok) console.log(`Mail: SMTP ready (${env.SMTP_HOST}:${env.SMTP_PORT})`)
  else console.error(`Mail: SMTP check failed (${mail.reason}); codes can't be emailed until it's fixed.`)

  const server = app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}/api/v1 (${env.NODE_ENV})`)
  })

  server.on("error", async (err) => {
    console.error(err.code === "EADDRINUSE" ? `Port ${env.PORT} is already in use (PORT in .env).` : err)
    await Promise.allSettled([closeDB(), closeRedis()])
    process.exit(1)
  })

  let stopping = false
  async function shutdown(signal) {
    if (stopping) return
    stopping = true
    console.log(`${signal} received: closing the server…`)
    // Force exit if open connections don't finish in time.
    const timer = setTimeout(() => {
      console.error("Shutdown took too long; exiting.")
      process.exit(1)
    }, 10_000)
    timer.unref()

    server.close(async () => {
      await closeDB().catch((err) => console.error("Error closing MySQL pool:", err))
      await closeRedis().catch((err) => console.error("Error closing Redis:", err))
      closeR2()
      console.log("Server, database and Redis closed.")
      process.exit(0)
    })
    server.closeIdleConnections()
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason)
})

start().catch(async (err) => {
  console.error(err.message)
  await Promise.allSettled([closeDB(), closeRedis()])
  process.exit(1)
})
