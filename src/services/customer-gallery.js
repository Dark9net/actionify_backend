/**
 * The client's gallery (/api/v1/customer-gallery): the event a gallery code opens, and its
 * photographs and videos on R2.
 *
 * Who may see what:
 * - Only a browser holding an open gallery session (the HttpOnly cookie a gallery code or a QR link
 *   gave it; services/gallerycode.js liveSession) gets anything, and only as a client.
 * - The event comes from that session's code, never from the request: there is no event or file id
 *   to change, so one code shows one event and nothing else.
 * - The code must still be active and the 24-hour visit not over; a revoked or expired code ends the
 *   session at once.
 * - Files are reached through short-lived signed R2 links (R2_SIGNED_URL_EXPIRES_IN plus the 10-minute
 *   window, config/r2config.js); the page asks again before they run out (`linksUntil`).
 */
const QRCode = require("qrcode")
const env = require("../config/env")
const { r2, signedViewUrl } = require("../config/r2config")
const gallery = require("../models/customer-gallery")
const { liveSession } = require("./gallerycode")
const { linkFor } = require("./sharegallery")
const { readCode } = require("../utils/gallery-code")
const { SHOWN_IN_BROWSER } = require("../utils/filecheck")
const { encodeCursor, PAGE_SIZE } = require("../validators/customer-gallery")
const { HttpError } = require("../utils/http-error")

const QR_OPTIONS = { errorCorrectionLevel: "M", margin: 2, width: 480, color: { dark: "#1d1a16", light: "#ffffff" } }
// R2's links last at least this long from now (see config/r2config.js signedViewUrl)
const LINK_MS = env.R2_SIGNED_URL_EXPIRES_IN.ms

const n = (v) => Number(v ?? 0)

function requireStorage() {
  if (!r2) throw new HttpError(503, "The photographs can't be shown just now. Please try again later.", { code: "R2_DISABLED" })
}

/** The open gallery behind this browser, and its event (410 when the event is gone). */
async function openGallery(req, res) {
  const session = await liveSession(req, res)
  const event = session.event_id ? await gallery.findEvent(session.event_id) : null
  if (!event) throw new HttpError(410, "This gallery's event is no longer online. Ask the studio about your photographs.", { code: "GALLERY_GONE" })
  return { session, event }
}

const linksUntil = () => new Date(Date.now() + LINK_MS).toISOString()

/** The download name: the file's own name as it was uploaded. */
const downloadName = (row) => row.original_name || row.file_name

async function itemOf(row) {
  const viewable = SHOWN_IN_BROWSER.test(row.content_type)
  const previewUrl = row.preview_key ? await signedViewUrl(row.preview_key) : null
  const url = viewable ? await signedViewUrl(row.object_key) : null
  return {
    id: row.id,
    kind: row.kind,
    album: row.category_id ?? "none",
    name: downloadName(row),
    contentType: row.content_type,
    size: n(row.size_bytes),
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    // a photo's preview for the grid; the file itself to view (a RAW photo: its preview) and to save.
    // hasPreview false: previewUrl is the file itself (a video without a still: the page shows its first frame)
    hasPreview: Boolean(previewUrl),
    previewUrl: previewUrl ?? url,
    url: url ?? previewUrl,
    downloadUrl: await signedViewUrl(row.object_key, { downloadAs: downloadName(row) }),
  }
}

/**
 * GET / : the gallery's page: the event, its albums with their counts, the cover, the totals, the
 * code with its private link and QR code (to share), and when the visit ends.
 */
async function details(req, res) {
  requireStorage()
  const { session, event } = await openGallery(req, res)
  const [albums, totals, coverRow, crew] = await Promise.all([
    gallery.albums(event.id),
    gallery.totals(event.id),
    gallery.cover(event.id),
    gallery.crewNames(event.booking_id),
  ])
  const code = readCode(session)
  const link = code ? linkFor(code) : null
  const shown = albums.filter((a) => n(a.n) > 0).map((a) => ({ id: a.id, name: a.name, slug: a.slug, count: n(a.n) }))
  // files in no album are an album of their own, once there are albums to tell them from
  if (n(totals.loose) && shown.length) shown.push({ id: "none", name: "More", slug: "more", count: n(totals.loose) })
  const coverUrl = coverRow ? await signedViewUrl(coverRow.preview_key ?? coverRow.object_key) : null

  return {
    event: {
      name: event.name,
      slug: event.slug,
      kind: event.kind,
      date: event.event_day,
      venue: event.venue ?? "",
      client: event.client_name ?? null,
      photographers: crew.length ? crew : event.created_by_name ? [event.created_by_name] : [],
    },
    albums: shown,
    totals: { files: n(totals.files), photos: n(totals.photos), videos: n(totals.videos), bytes: n(totals.bytes) },
    cover: coverUrl,
    gallery: {
      code,
      label: session.label,
      expiresAt: session.expires_at, // the code itself: online until then (null: no end date)
      link,
      qr: link ? await QRCode.toDataURL(link, QR_OPTIONS) : null,
    },
    visit: { endsAt: session.session_expires_at },
    linksUntil: linksUntil(),
  }
}

/** GET /items?cursor= : one page of the photographs and videos, with their links. */
async function items(req, res, { cursor }) {
  requireStorage()
  const { event } = await openGallery(req, res)
  const rows = await gallery.page(event.id, { cursor, limit: PAGE_SIZE + 1 })
  const more = rows.length > PAGE_SIZE
  const shown = more ? rows.slice(0, PAGE_SIZE) : rows
  return {
    items: await Promise.all(shown.map(itemOf)),
    nextCursor: more ? encodeCursor(shown[shown.length - 1]) : null,
    linksUntil: linksUntil(),
  }
}

module.exports = { details, items }
