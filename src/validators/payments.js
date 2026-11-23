/**
 * Zod schemas for /api/v1/payments: the panel's Payments page
 * (Frontend/src/pages/photographer_panel/photographer_pages/Payments.jsx). Every row is one payment
 * (bookings_payment), in Nepalese rupees.
 */
const { z } = require("zod")
const { cursor, encodeCursor, PAGE_SIZE } = require("./bookings")
const { requestSchema, idParam, KINDS } = require("./clients")

const STATUSES = ["requested", "paid", "cancelled", "refunded"]
const METHODS = ["cash", "bank", "esewa", "khalti", "fonepay"]
// Nepal Standard Time (UTC+05:45): the studio's clock, when the browser doesn't say
const STUDIO_OFFSET = 345

const clean = (v) => v.normalize("NFKC").replace(/\s+/g, " ").trim()

const search = z
  .string()
  .max(80, "Search with at most 80 characters.")
  .optional()
  .transform((v) => (v && clean(v) ? clean(v) : undefined))

/** GET / ?status=&q=&cursor=&limit= : one page of PAGE_SIZE payments (or `limit`, fewer), newest first. */
const listQuery = z.object({
  status: z.enum(["all", ...STATUSES], { error: "Show all, requested, paid, cancelled or refunded payments." }).default("all"),
  // the client's name, email or phone, the note, or a booking reference like BK-3F2A9C
  q: search,
  cursor: cursor.optional(),
  // a shorter page, such as the Overview's three latest payments
  limit: z.coerce
    .number({ error: "limit is a number." })
    .int("limit is a whole number.")
    .min(1, "limit is at least 1.")
    .max(PAGE_SIZE, `limit is at most ${PAGE_SIZE}.`)
    .optional(),
})

/**
 * GET /summary ?tz= : tz is the browser's offset from UTC in minutes (Nepal: 345), so "this month"
 * and "the last 30 days" follow the studio's clock, not the server's.
 */
const summaryQuery = z.object({
  tz: z.coerce
    .number({ error: "Send the time zone offset in minutes." })
    .int("Send the time zone offset in whole minutes.")
    .min(-720, "That isn't a time zone offset.")
    .max(840, "That isn't a time zone offset.")
    .default(STUDIO_OFFSET),
})

/** GET /bookings ?q= : the bookings a payment can be recorded for (not cancelled), for the picker. */
const bookingsQuery = z.object({ q: search })

/**
 * POST / : a payment already received, recorded by hand (cash on the day, a bank transfer). No email.
 * amount, kind and note as in a request from Clients.
 */
const recordSchema = requestSchema.extend({
  bookingId: idParam("booking"),
  method: z.enum(METHODS, { error: "Choose how it was paid: cash, bank transfer, eSewa, Khalti or Fonepay." }),
})

/** PATCH /:paymentId : received, cancelled, refunded, or back (undo). */
const statusSchema = z.object({
  status: z.enum(STATUSES, { error: "A payment is requested, paid, cancelled or refunded." }),
})

module.exports = { listQuery, summaryQuery, bookingsQuery, recordSchema, statusSchema, idParam, encodeCursor, PAGE_SIZE, STATUSES, METHODS, KINDS }
