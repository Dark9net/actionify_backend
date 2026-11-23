/**
 * Zod schemas for /api/v1/bookings: the website's booking form (Frontend/src/components/BookingForm.jsx,
 * in the booking sheet and on Hire Us) and the panel's Bookings page
 * (Frontend/src/pages/photographer_panel/photographer_pages/Bookings.jsx). The choices match the
 * bookings table's CHECK constraints and the form's lists in Frontend/src/data/content.js (hire).
 */
const { z } = require("zod")
const { day: teamDay } = require("./team")

const PAGE_SIZE = 10
const EVENT_TYPES = ["Wedding", "Concert or festival", "Conference or corporate event", "Sport", "Private celebration", "Something else"]
const COVERAGE = ["About 2 hours", "Half a day (about 4 hours)", "A full day (about 8 hours)", "More than one day", "Not sure yet"]
const STATUSES = ["requested", "confirmed", "dispatched", "completed", "cancelled"]
// "all": every booking still going ahead (cancelled ones have their own list)
const FILTERS = ["all", ...STATUSES]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86_400_000

const clean = (v) => v.normalize("NFKC").replace(/\s+/g, " ").trim()
const SAFE = /^[^\p{Cc}\p{Cf}<>]+$/u
// notes keep their line breaks and tabs; other control and format characters are refused
const LINE_BREAKS = new Set([9, 10, 13])
const FORMAT = /\p{Cf}/u
const safeNotes = (v) =>
  ![...v].some((ch) => {
    const c = ch.codePointAt(0)
    return (c < 32 && !LINE_BREAKS.has(c)) || c === 127 || FORMAT.test(ch)
  })

const text = (max, message, tooLong) =>
  z
    .string({ error: message })
    .transform(clean)
    .pipe(z.string().min(1, message).max(max, tooLong).regex(SAFE, "Use letters, numbers and simple punctuation."))

/** An optional field: missing, null or blank all mean "not given". */
const optional = (schema) =>
  z
    .union([z.string(), z.null()])
    .transform((v) => (typeof v === "string" && clean(v) ? v : undefined))
    .pipe(schema.optional())
    .optional()

/* ---------- The cursor: where the next page starts ---------- */

/** Rows go newest first by (created_at, id); a cursor is the last row's pair: base64url("<ms>.<id>"). */
const encodeCursor = (row) => Buffer.from(`${new Date(row.created_at).getTime()}.${row.id}`).toString("base64url")

function decodeCursor(value) {
  const raw = Buffer.from(value, "base64url").toString("utf8")
  const dot = raw.indexOf(".")
  const ms = Number(raw.slice(0, dot))
  const id = raw.slice(dot + 1)
  if (dot < 1 || !Number.isSafeInteger(ms) || ms < 0 || !UUID.test(id)) return null
  return { createdAt: new Date(ms), id }
}

const BROKEN = "That page link is broken. Go back to the first page."
const cursor = z
  .string()
  .max(120, BROKEN)
  .regex(/^[A-Za-z0-9_-]+$/, BROKEN)
  .transform((v, ctx) => {
    const out = decodeCursor(v)
    if (!out) {
      ctx.addIssue({ code: "custom", message: BROKEN })
      return z.NEVER
    }
    return out
  })

/* ---------- The booking itself ---------- */

const isoDay = (d) => d.toISOString().slice(0, 10)

// "2026-12-05": a real day, from yesterday (time zones) to three years ahead
const eventDate = z
  .string({ error: "Choose the date of the event." })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date of the event.")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && isoDay(new Date(`${v}T00:00:00Z`)) === v, "That date doesn't exist.")
  .refine((v) => v >= isoDay(new Date(Date.now() - DAY_MS)), "That date has passed. Choose today or later.")
  .refine((v) => v <= isoDay(new Date(Date.now() + 3 * 365 * DAY_MS)), "We take bookings up to three years ahead.")

const booking = z.object({
  name: text(100, "Enter your name.", "Keep the name under 100 characters."),
  email: z
    .string({ error: "Enter an email address so we can reply." })
    .trim()
    .toLowerCase()
    .min(1, "Enter an email address so we can reply.")
    .max(254, "That email address is too long.")
    .email("This email address looks incomplete."),
  phone: optional(z.string().trim().max(30, "Keep the phone number under 30 characters.").regex(/^[0-9+()\-.\s]{6,30}$/, "Use digits, spaces and + ( ) - only.")),
  type: z.enum(EVENT_TYPES, { error: "Choose the kind of event." }),
  date: eventDate,
  time: optional(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a start time like 14:30.")),
  venue: text(200, "Enter the venue or the city.", "Keep the venue under 200 characters."),
  coverage: optional(z.enum(COVERAGE, { error: "Choose one of the coverage options." })),
  // the form sends "1".."4"
  crew: z.coerce.number({ error: "Choose 1 to 4 photographers." }).int().min(1, "Choose 1 to 4 photographers.").max(4, "Choose 1 to 4 photographers.").default(1),
  notes: optional(z.string().trim().max(2000, "Keep the notes under 2,000 characters.").refine(safeNotes, "Remove the unusual characters from the notes.")),
})

/** POST / : a request from the website. `website` is a field people never see: a bot fills it in. */
const requestSchema = booking.extend({
  website: z.string().max(0, "Leave this field empty.").optional(),
})

/** POST /manual : a booking the studio took by phone or email (it starts confirmed). */
const manualSchema = booking

/** GET / ?status=&q=&cursor= : one page of PAGE_SIZE bookings. */
const listQuery = z.object({
  status: z.enum(FILTERS, { error: "Show all, requested, confirmed, dispatched, completed or cancelled bookings." }).default("all"),
  // part of the name, email, venue or phone, or a reference like BK-3F2A9C
  q: z
    .string()
    .max(80, "Search with at most 80 characters.")
    .optional()
    .transform((v) => (v && clean(v) ? clean(v) : undefined)),
  cursor: cursor.optional(),
})

/** PATCH /:id : move it on (or back); sending photographers names who goes. */
const updateSchema = z
  .object({
    status: z.enum(STATUSES, { error: "That isn't a booking status." }),
    crew: z
      .array(z.string().regex(UUID, "That isn't a photographer."), { error: "Choose who goes." })
      .min(1, "Choose at least one photographer.")
      .max(8, "Send at most 8 people.")
      .optional(),
  })
  .refine((d) => d.status !== "dispatched" || d.crew?.length, { message: "Choose at least one photographer.", path: ["crew"] })

const idParam = z.string().regex(UUID, "That isn't a booking id.")

/** GET /crew ?day= : today as the panel sees it, for who is off (validators/team.js). */
const crewQuery = z.object({ day: teamDay.optional() })

module.exports = {
  requestSchema,
  manualSchema,
  listQuery,
  updateSchema,
  crewQuery,
  idParam,
  encodeCursor,
  cursor,
  PAGE_SIZE,
  EVENT_TYPES,
  COVERAGE,
  STATUSES,
}
