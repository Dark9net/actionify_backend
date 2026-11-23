/**
 * Zod schemas for /api/v1/events: the New event form on the panel's Uploads page
 * (Frontend/src/pages/photographer_panel/photographer_pages/NewEvent.jsx), the same fields and
 * the same choices (KINDS and STARTER_CATEGORIES match lib/seed.js there).
 */
const { z } = require("zod")

const KINDS = ["Wedding", "Concert", "Conference", "Sport", "Celebration"]

/** The categories a new event starts with when none are given, by its kind. */
const STARTER_CATEGORIES = {
  Wedding: ["Ceremony", "Portraits", "Reception"],
  Concert: ["Stage", "Crowd", "Backstage"],
  Conference: ["Keynotes", "Sessions", "Networking"],
  Sport: ["Start", "On course", "Finish"],
  Celebration: ["Arrivals", "Speeches", "Party"],
}

const MAX_CATEGORIES = 20
const DAY_MS = 86_400_000

/** A name as a folder name, the same as the panel's lib/format.js: "Anna & Léo" → "anna-leo". */
function slugify(value, max = 60) {
  return (
    String(value)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "untitled"
  )
}

const SAFE = /^[^\p{Cc}\p{Cf}<>]+$/u
const clean = (v) => v.normalize("NFKC").replace(/\s+/g, " ").trim()

/** Required text: tidied, 1..max characters, no control characters or angle brackets. */
const text = (max, message) =>
  z
    .string({ error: message })
    .transform(clean)
    .pipe(z.string().min(1, message).max(max, `Use at most ${max} characters.`).regex(SAFE, "Use letters, numbers and simple punctuation."))

/** The same, optional: blank or null counts as not given. */
const optionalText = (max) =>
  z
    .string()
    .nullish()
    .transform((v) => (v && clean(v) ? clean(v) : undefined))
    .pipe(z.string().max(max, `Use at most ${max} characters.`).regex(SAFE, "Use letters, numbers and simple punctuation.").optional())

/** An optional id: blank or null counts as not given. */
const optionalId = (message) =>
  z
    .string()
    .nullish()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .pipe(z.string().uuid(message).optional())

/** "2026-06-14": a real day, from 2000 to five years ahead. */
const day = z
  .string({ error: "Choose the day of the event." })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the day of the event.")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
  }, "That isn't a real date.")
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00Z`)
    return t >= Date.UTC(2000, 0, 1) && t <= Date.now() + 5 * 365 * DAY_MS
  }, "Choose a date between 2000 and five years from now.")

/**
 * "Categories": a list, or the form's comma-separated text. Blanks are dropped and repeats
 * (the same folder name) kept once; each becomes { name, slug }.
 */
const categories = z
  .preprocess(
    (v) => (typeof v === "string" ? v.split(",") : v ?? []),
    z.array(z.string({ error: "Each category is a name." }).max(200, "Keep each category under 40 characters."), {
      error: "List the categories, separated by commas.",
    }),
  )
  .transform((list, ctx) => {
    const out = []
    const seen = new Set()
    for (const raw of list) {
      const name = clean(raw)
      if (!name) continue
      if (name.length > 40) {
        ctx.addIssue({ code: "custom", message: `"${name.slice(0, 20)}…" is too long. Keep each category under 40 characters.` })
        return z.NEVER
      }
      if (!SAFE.test(name) || !/[\p{L}\p{N}]/u.test(name)) {
        ctx.addIssue({ code: "custom", message: "Each category needs letters or numbers, and no < or >." })
        return z.NEVER
      }
      const slug = slugify(name, 40)
      if (seen.has(slug)) continue
      seen.add(slug)
      out.push({ name, slug })
    }
    if (out.length > MAX_CATEGORIES) {
      ctx.addIssue({ code: "custom", message: `An event can start with at most ${MAX_CATEGORIES} categories.` })
      return z.NEVER
    }
    return out
  })

/* ---------- Schemas, one per route ---------- */

/** POST / : a new event (New event on the Uploads page). */
const createSchema = z.object({
  name: text(80, "Give the event a name. It becomes the folder and the gallery title."),
  date: day,
  kind: z.enum(KINDS, { error: "Choose the kind of event." }),
  venue: optionalText(200),
  bookingId: optionalId("That isn't a booking id."),
  clientId: optionalId("That isn't a client id."),
  // missing or empty: the kind's starting categories
  categories: categories.optional(),
  // the event's guest gallery code, made with it (one code per event; Access codes regenerates it)
  withCode: z.boolean({ error: "withCode is true or false." }).default(true),
})

/** PATCH /:id : a new name (the folder on R2 stays as it is). */
const renameSchema = z.object({
  name: text(80, "The event needs a name."),
})

/** A category's name (POST /:id/categories, PATCH /:id/categories/:categoryId). */
const categorySchema = z.object({
  name: text(40, "Give the category a name.").refine((v) => /[\p{L}\p{N}]/u.test(v), "Use letters or numbers in the name."),
})

/** DELETE /:id : the event's name typed again, to show it is the right event. */
const removeSchema = z.object({
  confirmName: z.string({ error: "Type the event's name to delete it." }).max(200, "Type the event's name to delete it."),
})

/** Categories one event can have, all told (a new event starts with at most MAX_CATEGORIES). */
const MAX_EVENT_CATEGORIES = 60

const idParam = z.string().uuid("That isn't an event id.")

module.exports = {
  createSchema,
  renameSchema,
  categorySchema,
  removeSchema,
  idParam,
  slugify,
  KINDS,
  STARTER_CATEGORIES,
  MAX_EVENT_CATEGORIES,
}
