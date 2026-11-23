/**
 * The Photographers page: every photographer and editor account, and where each one is now.
 *
 *   onsite    out on a booking that is dispatched (Bookings, Send photographers)
 *   off       marked off for the day (they aren't offered when sending photographers)
 *   free      ready to send
 *   inactive  the account is waiting for approval or disabled
 *
 * Read a page at a time: PAGE_SIZE people by name, with a cursor for the next page (keyset on
 * full_name and id, so a page never skips or repeats anyone as accounts are added).
 */
const team = require("../models/team")
const { encodeCursor, PAGE_SIZE, TEAM_ROLES } = require("../validators/team")
const { refOf } = require("./bookings")
const { roleOf } = require("../utils/roles")
const { photoUrl } = require("./profile-photo")
const { HttpError } = require("../utils/http-error")
const { audit } = require("../utils/audit")

const rolesFor = (role) => (role && role !== "all" ? [role] : TEAM_ROLES)

const stateOf = (row) => (row.onsite_booking_id ? "onsite" : row.status !== "active" ? "inactive" : Number(row.off_today) ? "off" : "free")

const bookingOf = (b) =>
  b ? { id: b.id, ref: refOf(b.id), client: b.client_name, type: b.event_type, date: b.event_day, time: b.start_hm, venue: b.venue } : null

/** One card on the page. */
const toPublic = async (row, booked) => ({
  id: row.id,
  name: row.full_name,
  photo: await photoUrl(row.photo_key), // their own, from Settings; null: initials
  email: row.email,
  mobile: row.mobile ?? null,
  role: { slug: row.role_slug, name: roleOf(row.role_slug)?.name ?? row.role_slug },
  account: row.status, // active | pending | disabled
  state: stateOf(row),
  offToday: Boolean(Number(row.off_today)),
  onsite: bookingOf(booked.get(row.onsite_booking_id)),
  lastEvent: bookingOf(booked.get(row.last_booking_id)),
  completed: Number(row.completed),
  lastLoginAt: row.last_login_at,
  joinedAt: row.created_at,
})

/** GET / : one page. Asks for one row more than a page, only to know whether another follows. */
async function list({ status, role, q, day, cursor }) {
  const rows = await team.page({ roles: rolesFor(role), status, text: q, day, cursor, limit: PAGE_SIZE + 1 })
  const more = rows.length > PAGE_SIZE
  const shown = more ? rows.slice(0, PAGE_SIZE) : rows
  const booked = await team.bookingsByIds([...new Set(shown.flatMap((r) => [r.onsite_booking_id, r.last_booking_id]).filter(Boolean))])
  return {
    members: await Promise.all(shown.map((r) => toPublic(r, booked))),
    pageSize: PAGE_SIZE,
    nextCursor: more ? encodeCursor(shown[shown.length - 1]) : null,
  }
}

/** GET /summary : the figures and the tab counts. */
async function summary({ day }) {
  const s = await team.summary({ roles: TEAM_ROLES, day })
  const n = (v) => Number(v ?? 0)
  return {
    all: n(s.total),
    photographers: n(s.photographers),
    editors: n(s.editors),
    free: n(s.free),
    onsite: n(s.onsite),
    off: n(s.off),
    inactive: n(s.inactive),
  }
}

/**
 * PATCH /:id/off : off for the day, or back. Anyone may mark themselves; marking someone else needs
 * team.manage (the studio lead). → the member's card
 */
async function setOff(req, id, { off, day }) {
  if (id !== req.user.id && !req.access.can("team.manage")) {
    throw new HttpError(403, "You can only mark yourself off. Ask the studio lead to change someone else.", { code: "FORBIDDEN" })
  }
  const member = await team.findMember(id, TEAM_ROLES)
  if (!member) throw new HttpError(404, "That person isn't on the team.", { code: "NOT_FOUND" })
  await team.setOff(id, day, off, req.user.id)
  audit(req, off ? "team_day_off" : "team_day_back", { userId: id, detail: { day, by: req.user.id } })
  const [row] = await team.page({ roles: TEAM_ROLES, status: "all", day, id, limit: 1 })
  const booked = await team.bookingsByIds([row.onsite_booking_id, row.last_booking_id].filter(Boolean))
  return toPublic(row, booked)
}

module.exports = { list, summary, setOff }
