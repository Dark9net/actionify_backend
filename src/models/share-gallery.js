/**
 * The reads behind sharing a gallery (services/sharegallery.js): who the event's client is and
 * how to reach them, and the name of the staff member sending it.
 */
const { pool } = require("../config/dbconfig")

/** The account named as the event's client (events.client_id). */
async function clientAccount(id, db = pool) {
  const [rows] = await db.execute(
    "SELECT id, full_name, email, email_verified_at, status FROM users WHERE id = ? LIMIT 1",
    [id],
  )
  return rows[0] ?? null
}

/** The booking the event was made for (events.booking_id), with the account it belongs to, if any. */
async function bookingContact(id, db = pool) {
  const [rows] = await db.execute(
    `SELECT b.id, b.client_name, b.email, b.user_id, u.email AS account_email, u.email_verified_at
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.id = ? LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

/** The staff member's name, for "sent by" in the email and the log. */
async function staffName(id, db = pool) {
  const [rows] = await db.execute("SELECT full_name FROM users WHERE id = ? LIMIT 1", [id])
  return rows[0]?.full_name ?? null
}

module.exports = { clientAccount, bookingContact, staffName }
