/**
 * The Payments page (services/payments.js): every row of bookings_payment with its booking, newest
 * first, and the money figures. Every query takes `?` parameters.
 */
const { pool } = require("../config/dbconfig")
const { PAYMENT_COLUMNS, PAYMENT_FROM, likeEscape } = require("./client")

const ROW = `${PAYMENT_COLUMNS},
  b.client_name, b.email AS client_email, b.phone AS client_phone, b.event_type,
  DATE_FORMAT(b.event_date, '%Y-%m-%d') AS event_day, b.venue, b.status AS booking_status`
const FROM = `${PAYMENT_FROM} JOIN bookings b ON b.id = p.booking_id`

/** Up to `limit` payments, newest asked first, after `cursor` ({ createdAt, id }), by status and search. */
async function page({ status = "all", idPrefix, text, cursor, limit }) {
  const where = []
  const params = []
  if (status !== "all") {
    where.push("p.status = ?")
    params.push(status)
  }
  if (idPrefix || text) {
    const any = []
    if (idPrefix) {
      any.push("b.id LIKE ?")
      params.push(`${idPrefix}%`)
    }
    if (text) {
      const like = `%${likeEscape(text)}%`
      any.push("b.client_name LIKE ?", "b.email LIKE ?", "b.phone LIKE ?", "p.note LIKE ?")
      params.push(like, like, like, like)
    }
    where.push(`(${any.join(" OR ")})`)
  }
  if (cursor) {
    where.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))")
    params.push(cursor.createdAt, cursor.createdAt, cursor.id)
  }
  params.push(limit)
  const [rows] = await pool.query(
    `SELECT ${ROW} FROM ${FROM} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
    params,
  )
  return rows
}

/** One payment with its booking. */
async function findRow(id) {
  const [rows] = await pool.query(`SELECT ${ROW} FROM ${FROM} WHERE p.id = ? LIMIT 1`, [id])
  return rows[0] ?? null
}

/**
 * The figures. `windows` are [from, to) pairs of Dates: money received (paid, by when it arrived)
 * in each, with the count; plus the count and sum in every status.
 */
async function summary(windows) {
  const sums = windows
    .map(
      (_w, i) => `COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= ? AND paid_at < ? THEN amount_npr END), 0) AS w${i}_npr,
                  COALESCE(SUM(status = 'paid' AND paid_at >= ? AND paid_at < ?), 0) AS w${i}_n`,
    )
    .join(",\n")
  const params = windows.flatMap(([from, to]) => [from, to, from, to])
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS all_n,
            ${["requested", "paid", "cancelled", "refunded"]
              .map((s) => `COALESCE(SUM(status = '${s}'), 0) AS ${s}_n, COALESCE(SUM(CASE WHEN status = '${s}' THEN amount_npr END), 0) AS ${s}_npr`)
              .join(",\n            ")}
            ${sums ? `, ${sums}` : ""}
       FROM bookings_payment`,
    params,
  )
  return row
}

module.exports = { page, findRow, summary }
