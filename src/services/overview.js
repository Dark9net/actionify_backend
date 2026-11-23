/**
 * GET /api/v1/overview: the panel's Overview page in one answer, from the database.
 *
 * Each part is there only for roles that may see it (gallery codes, names and emails are not for
 * everyone): `media` with event.view (every staff role), `bookings` with booking.view, `clients` with
 * client.view. A part the role can't see is null. Payments come from /payments (payment.view) and the
 * bucket's own size from /storage/usage, as before.
 *
 * Days are the studio's own: `offset` is the browser's time zone in minutes east of UTC.
 */
const overview = require("../models/overview")
const bookings = require("../models/booking")
const { photoUrl } = require("./profile-photo")
const { refOf } = require("./bookings")

const DAY_MS = 24 * 60 * 60 * 1000
const CHART_DAYS = 14
const NEW_CLIENT_DAYS = 30
const NEEDS_PHOTOGRAPHER = 3 // the soonest confirmed bookings listed
const ON_SITE = 12 // the bookings under way listed

const n = (v) => Number(v ?? 0)
/** "YYYY-MM-DD" of a moment that is already shifted to the studio's time zone. */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
/** A UTC moment as MySQL's "YYYY-MM-DD HH:MM:SS.mmm". */
const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "")

/** The last 14 days, today last, each with what reached R2 that day (none: zeros). */
async function media({ offset, now }) {
  const local = now + offset * 60_000
  const todayStart = Date.parse(`${dayOf(local)}T00:00:00Z`) // the studio's midnight, on a UTC clock
  const firstDay = todayStart - (CHART_DAYS - 1) * DAY_MS
  const [totals, rows] = await Promise.all([
    overview.mediaTotals(),
    overview.uploadsByDay({ since: sqlTime(firstDay - offset * 60_000), offset }),
  ])
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const days = Array.from({ length: CHART_DAYS }, (_, i) => {
    const day = dayOf(firstDay + i * DAY_MS)
    const r = byDay.get(day)
    return { day, files: n(r?.files), photos: n(r?.photos), bytes: n(r?.bytes) }
  })
  const sum = (list, key) => list.reduce((a, d) => a + d[key], 0)
  const week = days.slice(-7)
  const lastWeek = days.slice(0, 7)
  return {
    files: n(totals.files),
    photos: n(totals.photos),
    videos: n(totals.videos),
    bytes: n(totals.bytes),
    events: n(totals.events),
    days,
    week: { files: sum(week, "files"), photos: sum(week, "photos"), bytes: sum(week, "bytes") },
    lastWeek: { files: sum(lastWeek, "files"), photos: sum(lastWeek, "photos"), bytes: sum(lastWeek, "bytes") },
  }
}

const bookingOf = (row, crew = []) => ({
  id: row.id,
  ref: refOf(row.id),
  name: row.client_name,
  type: row.event_type,
  date: row.event_day,
  time: row.start_hm,
  venue: row.venue,
  crewSize: row.crew,
  crew,
})

async function bookingsPart(today) {
  const [counts, confirmed, dispatched] = await Promise.all([
    overview.bookingCounts(today),
    overview.bookingsIn("confirmed", NEEDS_PHOTOGRAPHER),
    overview.bookingsIn("dispatched", ON_SITE),
  ])
  const crews = await bookings.crewOf(dispatched.map((b) => b.id))
  const onsite = await Promise.all(
    dispatched.map(async (b) =>
      bookingOf(b, await Promise.all((crews.get(b.id) ?? []).map(async ({ photoKey, ...m }) => ({ ...m, photo: await photoUrl(photoKey) })))),
    ),
  )
  return {
    all: n(counts.total) - n(counts.cancelled),
    requested: n(counts.requested),
    confirmed: n(counts.confirmed),
    dispatched: n(counts.dispatched),
    completed: n(counts.completed),
    cancelled: n(counts.cancelled),
    upcoming: n(counts.upcoming),
    crewOut: n(counts.crew_out),
    needPhotographer: confirmed.map((b) => bookingOf(b)),
    onsite,
  }
}

async function clientsPart(now) {
  const c = await overview.clientCounts(sqlTime(now - NEW_CLIENT_DAYS * DAY_MS))
  return { clients: n(c.clients), recent: n(c.recent), recentDays: NEW_CLIENT_DAYS }
}

async function get(req, { offset }) {
  const now = Date.now()
  const today = dayOf(now + offset * 60_000)
  const { can } = req.access
  const [mediaPart, bookingPart, clientPart] = await Promise.all([
    can("event.view") ? media({ offset, now }) : null,
    can("booking.view") ? bookingsPart(today) : null,
    can("client.view") ? clientsPart(now) : null,
  ])
  return { today, offset, media: mediaPart, bookings: bookingPart, clients: clientPart, at: new Date(now).toISOString() }
}

module.exports = { get }
