/**
 * Zod schemas for /api/v1/events/:eventId/media: the photographs and videos of one event, sent from
 * the panel's event folder (Frontend/src/pages/photographer_panel/photographer_pages/EventFolder.jsx)
 * straight to R2.
 */
const { z } = require("zod")
const { FORMATS, MAX_BYTES, MAX_SVG_BYTES, KINDS_TEXT, formatOf } = require("../utils/filecheck")

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/*
  What may go up is decided by utils/filecheck.js: by the extension here (the stored type comes from
  there, never from the browser), and by the file's own bytes once R2 has them (services/media.js).
*/
const KINDS = ["photo", "video", "audio", "graphic", "model"]
const MB = 1024 * 1024
const MAX_PREVIEW_BYTES = 2 * MB
const FILES_PER_REQUEST = 25
const PAGE_SIZE = 60
const LIMIT_TEXT = { photo: "200 MB", video: "200 GB", audio: "20 GB", graphic: "20 GB", model: "100 GB" }
const KIND_NAME = { photo: "photo", video: "video", audio: "audio file", graphic: "graphic", model: "3D model" }

/** "IMG_0412.JPG" → { ext: "jpg", kind: "photo", contentType: "image/jpeg" }, or null. */
const typeOf = formatOf

const id = (message) => z.string({ error: message }).regex(UUID, message)

/* ---------- The cursor: where the next page starts ---------- */

/** Files go by name (camera order), then id: base64url("<id>:<file name>"). */
const encodeCursor = (row) => Buffer.from(`${row.id}:${row.file_name}`).toString("base64url")

function decodeCursor(value) {
  const raw = Buffer.from(value, "base64url").toString("utf8")
  const rowId = raw.slice(0, 36)
  const name = raw.slice(37)
  if (raw[36] !== ":" || !UUID.test(rowId) || !name || name.length > 200) return null
  return { id: rowId, name }
}

const cursor = z
  .string()
  .max(400, "That page link is broken. Go back to the first page.")
  .regex(/^[A-Za-z0-9_-]+$/, "That page link is broken. Go back to the first page.")
  .transform((v, ctx) => {
    const out = decodeCursor(v)
    if (!out) {
      ctx.addIssue({ code: "custom", message: "That page link is broken. Go back to the first page." })
      return z.NEVER
    }
    return out
  })

/* ---------- Schemas, one per route ---------- */

/** GET / ?category=all|none|<id>&kind=all|photo|video&cursor=&limit= */
const listQuery = z.object({
  category: z
    .string()
    .default("all")
    .refine((v) => v === "all" || v === "none" || UUID.test(v), "Choose a category of this event."),
  kind: z.enum(["all", ...KINDS], { error: "Show all, photos, videos, audio, graphics or 3D models." }).default("all"),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(PAGE_SIZE),
})

/** GET /:mediaId ?download=1 */
const getQuery = z.object({
  download: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
})

/** One file the browser is about to send. */
const fileSchema = z
  .object({
    name: z
      .string({ error: "Every file needs its name." })
      .transform((v) => v.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").trim())
      .pipe(z.string().min(1, "Every file needs its name.").max(255, "A file name can be at most 255 characters.")),
    size: z.number({ error: "Every file needs its size." }).int().positive("That file is empty."),
    categoryId: z
      .string()
      .nullish()
      .transform((v) => v || null)
      .pipe(id("Choose a category of this event.").nullable()),
    lastModified: z
      .number()
      .int()
      .optional()
      .transform((v) => (v && v > Date.UTC(1990, 0, 1) && v < Date.now() + 86_400_000 ? new Date(v) : null)),
    // the size of the small JPEG preview the browser made of it, when it could (not for HEIC or RAW)
    previewSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PREVIEW_BYTES, "A preview can be at most 2 MB.")
      .nullish()
      .transform((v) => v ?? null),
  })
  .superRefine((file, ctx) => {
    const type = typeOf(file.name)
    if (!type) {
      ctx.addIssue({ code: "custom", path: ["name"], message: `${file.name} can't be uploaded: only ${KINDS_TEXT} go up.` })
      return
    }
    if (type.ext === "svg" && file.size > MAX_SVG_BYTES) {
      ctx.addIssue({ code: "custom", path: ["size"], message: `${file.name} is larger than 20 MB, the most one SVG can be.` })
    } else if (file.size > MAX_BYTES[type.kind]) {
      const what = KIND_NAME[type.kind]
      ctx.addIssue({ code: "custom", path: ["size"], message: `${file.name} is larger than ${LIMIT_TEXT[type.kind]}, the most one ${what} can be.` })
    }
  })
  .transform((file) => ({ ...file, ...typeOf(file.name) }))

/** POST / : the files to send; answers with one upload link each. */
const startSchema = z.object({
  files: z
    .array(fileSchema, { error: "Send the files to upload." })
    .min(1, "Send the files to upload.")
    .max(FILES_PER_REQUEST, `Send at most ${FILES_PER_REQUEST} files at once.`),
})

/** What the browser could read from the file; all optional. */
const dimension = z.number().int().min(1).max(100_000).nullish()

/** POST /:mediaId/complete : the file (and its preview, when one was sent) reached R2. */
const completeSchema = z.object({
  width: dimension,
  height: dimension,
  durationMs: z.number().int().min(0).max(24 * 3_600_000).nullish(),
})

/** POST /:mediaId/parts : links for these parts of a large file (numbers from 1). */
const PARTS_PER_REQUEST = 100
const partsSchema = z.object({
  parts: z
    .array(z.number().int().min(1).max(10_000), { error: "Name the parts to send." })
    .min(1, "Name the parts to send.")
    .max(PARTS_PER_REQUEST, `Ask for at most ${PARTS_PER_REQUEST} parts at once.`)
    .transform((list) => [...new Set(list)].sort((x, y) => x - y)),
})

const ids = z
  .array(id("Pick the files again."), { error: "Pick the files first." })
  .min(1, "Pick the files first.")
  .max(500, "Pick at most 500 files at once.")
  .transform((list) => [...new Set(list)])

/** PATCH / : move picked files to another category (null: Uncategorised). */
const moveSchema = z.object({
  ids,
  categoryId: z
    .string()
    .nullish()
    .transform((v) => v || null)
    .pipe(id("Choose a category of this event.").nullable()),
})

/** POST /remove : delete picked files from R2 and the event. */
const removeSchema = z.object({ ids })

const idParam = z.string().regex(UUID)

module.exports = {
  TYPES: FORMATS,
  KINDS,
  MAX_BYTES,
  MAX_PREVIEW_BYTES,
  PAGE_SIZE,
  typeOf,
  encodeCursor,
  cursor,
  listQuery,
  getQuery,
  startSchema,
  completeSchema,
  partsSchema,
  moveSchema,
  removeSchema,
  idParam,
}
