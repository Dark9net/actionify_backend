/**
 * The Express app: middleware, routes and error handling. No listening and no
 * database connect here (that's server.js), so tests can import the app as is.
 *
 * The site and the API share one origin: in development Vite forwards /api to
 * this server (Frontend/vite.config.js); in production put both behind the same
 * domain (nginx/Caddy) and set TRUST_PROXY. No CORS headers are sent, so other
 * sites' scripts can't read any response.
 */
const express = require("express")
const helmet = require("helmet")
const cookieParser = require("cookie-parser")
const env = require("./config/env")
const { pingDB } = require("./config/dbconfig")
const { pingRedis } = require("./config/redis")
const { pingR2 } = require("./config/r2config")
const { requireCsrf } = require("./middleware/csrf")
const { HttpError } = require("./utils/http-error")

const app = express()

// Behind a reverse proxy, req.ip must be the client's (rate limits, lockouts, the security log).
app.set("trust proxy", env.TRUST_PROXY)
// Don't advertise the framework; helmet sets the safe default headers (HSTS, nosniff, frame-ancestors…).
app.disable("x-powered-by")
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-origin" } }))

// JSON bodies only, and small: nothing this API takes is bigger than a form.
app.use(express.json({ limit: "32kb" }))
// The refresh and CSRF cookies (both HttpOnly).
app.use(cookieParser())

/* ---------- Routes: /api/v1 ---------- */

const api = express.Router()

// Every POST/PUT/PATCH/DELETE must come from an allowed origin and carry the token from GET /api/v1/auth/csrf.
api.use(requireCsrf)

/** Liveness + database/Redis/R2 check for monitoring. */
api.get("/health", async (_req, res) => {
  const [database, redis, storage] = await Promise.all([pingDB(), pingRedis(), pingR2()])
  const healthy = database && redis !== "down" && storage !== "down"
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    database: database ? "up" : "down",
    redis, // "up", "down" or "disabled"
    storage, // R2: "up", "down" or "disabled"
    uptime: Math.round(process.uptime()),
  })
})

api.use("/auth", require("./routes/auth"))
api.use("/gallery-codes", require("./routes/gallerycode"))
api.use("/customer-gallery", require("./routes/customer-gallery"))
api.use("/access-codes", require("./routes/accesscode"))
api.use("/share-gallery", require("./routes/sharegallery"))
api.use("/events", require("./routes/events"))
api.use("/bookings", require("./routes/bookings"))
api.use("/team", require("./routes/team"))
api.use("/clients", require("./routes/clients"))
api.use("/payments", require("./routes/payments"))
api.use("/storage", require("./routes/R2storage"))
api.use("/users", require("./routes/users"))
api.use("/access", require("./routes/access"))
api.use("/overview", require("./routes/overview"))

app.use("/api/v1", api)

/* ---------- Not found + errors ---------- */

app.use((req, res) => {
  res.status(404).json({ ok: false, message: `No route for ${req.method} ${req.path}`, code: "NOT_FOUND" })
})

// Four arguments: Express treats this as the error handler.
app.use((err, req, res, _next) => {
  // Malformed or oversized JSON bodies come from the client, not the server.
  if (err.type === "entity.parse.failed") return res.status(400).json({ ok: false, message: "The request body is not valid JSON.", code: "BAD_JSON" })
  if (err.type === "entity.too.large") return res.status(413).json({ ok: false, message: "The request body is too large.", code: "TOO_LARGE" })

  // Errors made for the client: status, message, a code to branch on, public details.
  if (err instanceof HttpError) {
    return res.status(err.status).json({ ok: false, message: err.message, ...(err.code && { code: err.code }), ...err.details })
  }

  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500
  if (status >= 500) console.error(`${req.method} ${req.originalUrl} failed:`, err)

  // 5xx: a fixed message to the client in production; the details stay in the server log.
  const message =
    status >= 500 && env.IS_PRODUCTION
      ? "Something went wrong on our side. Please try again."
      : err.expose || status < 500
        ? err.message
        : `${err.name}: ${err.message}`
  res.status(status).json({ ok: false, message, code: status >= 500 ? "SERVER_ERROR" : "REQUEST_ERROR" })
})

module.exports = app
