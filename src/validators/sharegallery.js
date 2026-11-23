/**
 * Zod schemas for /api/v1/share-gallery: sharing an event's gallery from the panel's Uploads page
 * (Frontend/src/pages/photographer_panel/photographer_pages/ShareGallery.jsx): its code, its link,
 * its QR code, and an email to the client with all three and how to open the photos.
 */
const { z } = require("zod")

// the same rule as validators/auth.js: no quotes, brackets, commas, semicolons or colons in an address
const EMAIL = /^[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?\.)+(?:[\p{L}\p{M}]{2,}|xn--[a-z0-9-]+)$/u
const normaliseEmail = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase()
const clean = (v) => v.normalize("NFKC").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
// a short note from the studio: plain text, no control characters and no angle brackets (it goes in an email)
const SAFE_NOTE = /^[^\p{Cc}\p{Cf}<>]*$/u

/** :eventId in the path */
const eventParam = z.string().uuid("That isn't an event.")

/**
 * POST /:eventId/email : send the gallery to an address.
 *   email      where it goes (the client's own, or one typed in the window)
 *   confirmed  the staff member checked the address with the client. Required (true) when the
 *              address is the client's on record for the event: the window shows it and asks for
 *              that check before anything is sent. A typed address is checked by typing it twice.
 *   message    an optional line from the studio, put at the top of the email
 */
const shareEmailSchema = z.object({
  email: z
    .string({ error: "Enter the client's email address." })
    .transform(normaliseEmail)
    .pipe(
      z
        .string()
        .min(1, "Enter the client's email address.")
        .max(254, "That email address is too long.")
        .regex(EMAIL, "Enter an email address like name@example.com."),
    ),
  confirmed: z.boolean({ error: "Confirm the email address first." }).optional().default(false),
  message: z
    .string()
    .nullish()
    .transform((v) => {
      if (typeof v !== "string") return undefined
      // line breaks are kept (the note may have two short paragraphs); the rule below checks the rest
      const out = clean(v.replace(/\r\n?/g, "\n"))
      return out || undefined
    })
    .pipe(
      z
        .string()
        .max(400, "Keep the note under 400 characters.")
        .refine((v) => SAFE_NOTE.test(v.replace(/\n/g, " ")), "Use letters, numbers and simple punctuation.")
        .optional(),
    ),
})

module.exports = { eventParam, shareEmailSchema, normaliseEmail }
