/**
 * Zod schemas for /api/v1/clients: the panel's Clients page
 * (Frontend/src/pages/photographer_panel/photographer_pages/Clients.jsx). Every row is a booking, with
 * what its client has been asked to pay and has paid (bookings_payment).
 */
const { z } = require("zod")
const { cursor, encodeCursor, PAGE_SIZE } = require("./bookings")

// none: nothing asked yet; requested: a request not paid yet; advance: an advance paid, not the full
// payment; paid: the full payment received
const PAY_STATES = ["none", "requested", "advance", "paid"]
const KINDS = ["advance", "full"]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NPR = 10_000_000

const clean = (v) => v.normalize("NFKC").replace(/\s+/g, " ").trim()

/** GET / ?payment=&q=&cursor= : one page of PAGE_SIZE bookings, newest first. */
const listQuery = z.object({
  payment: z.enum(["all", ...PAY_STATES], { error: "Show all, none, requested, advance or paid." }).default("all"),
  // part of the name, email, phone or venue, or a reference like BK-3F2A9C
  q: z
    .string()
    .max(80, "Search with at most 80 characters.")
    .optional()
    .transform((v) => (v && clean(v) ? clean(v) : undefined)),
  cursor: cursor.optional(),
})

/** POST /:bookingId/payments : ask the client to pay. amount: rupees, up to 2 decimals ("25,000" is fine). */
const requestSchema = z.object({
  amount: z
    .union([z.number(), z.string()], { error: "Enter the amount in rupees." })
    .transform((v) => (typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : v))
    .pipe(
      z
        .number({ error: "Enter the amount in rupees." })
        .refine(Number.isFinite, "Enter the amount in rupees.")
        .refine((v) => v >= 1, "Enter at least NRs. 1.")
        .refine((v) => v <= MAX_NPR, "Enter at most NRs. 1,00,00,000.")
        .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "Use at most 2 decimals (paisa).")
        .transform((v) => Math.round(v * 100) / 100),
    ),
  kind: z.enum(KINDS, { error: "Choose advance or full payment." }),
  note: z
    .string()
    .max(300, "Keep the note under 300 characters.")
    .optional()
    .transform((v) => (v && clean(v) ? clean(v) : undefined))
    .refine((v) => !v || /^[^\p{Cc}\p{Cf}<>]+$/u.test(v), "Use letters, numbers and simple punctuation in the note."),
})

/** PATCH /:bookingId/payments/:paymentId : received, cancelled, refunded, or (undo) back. */
const paymentStatusSchema = z.object({
  status: z.enum(["requested", "paid", "cancelled", "refunded"], { error: "A payment is requested, paid, cancelled or refunded." }),
})

const idParam = (what) => z.string().regex(UUID, `That isn't a ${what} id.`)

module.exports = { listQuery, requestSchema, paymentStatusSchema, idParam, encodeCursor, PAGE_SIZE, PAY_STATES, KINDS }
