/**
 * The Clients page (services/clients.js): bookings with what their clients have been asked to pay
 * (bookings_payment), and the studio's settings (studio_settings). Every query takes `?` parameters.
 */
const { pool } = require("../config/dbconfig")

// per booking: what was asked and paid, from the payments that weren't cancelled or refunded
const PAYMENTS = `(SELECT booking_id,
         COUNT(*) AS requests,
         SUM(CASE WHEN status = 'paid' THEN amount_npr ELSE 0 END) AS paid,
         SUM(CASE WHEN status = 'requested' THEN amount_npr ELSE 0 END) AS due,
         MAX(status = 'paid' AND kind = 'advance') AS advance_paid,
         MAX(status = 'paid' AND kind = 'full') AS full_paid,
         MAX(created_at) AS last_request_at
    FROM bookings_payment WHERE status IN ('requested', 'paid') GROUP BY booking_id)`

const STATE = `CASE WHEN COALESCE(p.full_paid, 0) = 1 THEN 'paid'
                    WHEN COALESCE(p.advance_paid, 0) = 1 THEN 'advance'
                    WHEN COALESCE(p.due, 0) > 0 THEN 'requested'
                    ELSE 'none' END`

const ROW = `b.id, b.client_name, b.email, b.phone, b.event_type, DATE_FORMAT(b.event_date, '%Y-%m-%d') AS event_day,
  TIME_FORMAT(b.start_time, '%H:%i') AS start_hm, b.venue, b.status, b.user_id, b.created_at,
  COALESCE(p.requests, 0) AS requests, COALESCE(p.paid, 0) AS paid, COALESCE(p.due, 0) AS due,
  COALESCE(p.advance_paid, 0) AS advance_paid, COALESCE(p.full_paid, 0) AS full_paid, p.last_request_at,
  ${STATE} AS pay_state,
  e.id AS event_id, e.name AS event_name,
  (gc.id IS NOT NULL AND gc.revoked_at IS NULL AND (gc.expires_at IS NULL OR gc.expires_at > NOW(3))) AS code_live`
const FROM = `bookings b
  LEFT JOIN ${PAYMENTS} p ON p.booking_id = b.id
  LEFT JOIN events e ON e.booking_id = b.id
  LEFT JOIN gallery_codes gc ON gc.event_id = e.id`

/** "50%_off" → "50\%\_off": typed text is matched literally inside LIKE. */
const likeEscape = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`)

/** Up to `limit` bookings, newest first, after `cursor` ({ createdAt, id }), by payment state and search (active: not cancelled). */
async function page({ payment = "all", idPrefix, text, cursor, limit, active = false }) {
  const where = active ? ["b.status <> 'cancelled'"] : []
  const params = []
  if (payment !== "all") {
    where.push(payment === "requested" ? "COALESCE(p.due, 0) > 0" : `${STATE} = ?`)
    if (payment !== "requested") params.push(payment)
  }
  if (idPrefix || text) {
    const any = []
    if (idPrefix) {
      any.push("b.id LIKE ?")
      params.push(`${idPrefix}%`)
    }
    if (text) {
      const like = `%${likeEscape(text)}%`
      any.push("b.client_name LIKE ?", "b.email LIKE ?", "b.phone LIKE ?", "b.venue LIKE ?")
      params.push(like, like, like, like)
    }
    where.push(`(${any.join(" OR ")})`)
  }
  if (cursor) {
    where.push("(b.created_at < ? OR (b.created_at = ? AND b.id < ?))")
    params.push(cursor.createdAt, cursor.createdAt, cursor.id)
  }
  params.push(limit)
  const [rows] = await pool.query(
    `SELECT ${ROW} FROM ${FROM} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
    params,
  )
  return rows
}

/** One booking's row (after a payment changes). */
async function findRow(bookingId) {
  const [rows] = await pool.query(`SELECT ${ROW} FROM ${FROM} WHERE b.id = ? LIMIT 1`, [bookingId])
  return rows[0] ?? null
}

/** The figures over every booking: clients, money paid and due, and the count in each payment state. */
async function summary() {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS bookings,
            COUNT(DISTINCT CASE WHEN b.status <> 'cancelled' THEN b.email END) AS clients,
            COALESCE(SUM(b.status IN ('requested', 'confirmed', 'dispatched') AND b.event_date >= CURRENT_DATE), 0) AS ahead,
            COALESCE(SUM(COALESCE(p.paid, 0)), 0) AS paid_npr,
            COALESCE(SUM(COALESCE(p.due, 0)), 0) AS due_npr,
            COALESCE(SUM(${STATE} = 'none'), 0) AS state_none,
            COALESCE(SUM(COALESCE(p.due, 0) > 0), 0) AS state_requested,
            COALESCE(SUM(${STATE} = 'advance'), 0) AS state_advance,
            COALESCE(SUM(${STATE} = 'paid'), 0) AS state_paid
       FROM bookings b LEFT JOIN ${PAYMENTS} p ON p.booking_id = b.id`,
  )
  return row
}

/** The booking a payment is for: { id, client_name, email, event_type, event_day, venue, status }. */
async function findBooking(id) {
  const [rows] = await pool.query(
    `SELECT id, client_name, email, event_type, DATE_FORMAT(event_date, '%Y-%m-%d') AS event_day, venue, status
       FROM bookings WHERE id = ? LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

const PAYMENT_COLUMNS = `p.id, p.booking_id, p.kind, p.amount_npr, p.status, p.method, p.note, p.email_to, p.emailed_at,
  p.requested_by, r.full_name AS requested_by_name, p.paid_at, p.paid_by, pb.full_name AS paid_by_name,
  p.refunded_at, p.refunded_by, rb.full_name AS refunded_by_name, p.created_at`
const PAYMENT_FROM = `bookings_payment p
  LEFT JOIN users r ON r.id = p.requested_by
  LEFT JOIN users pb ON pb.id = p.paid_by
  LEFT JOIN users rb ON rb.id = p.refunded_by`

/** A booking's payments, newest first. */
async function payments(bookingId) {
  const [rows] = await pool.query(`SELECT ${PAYMENT_COLUMNS} FROM ${PAYMENT_FROM} WHERE p.booking_id = ? ORDER BY p.created_at DESC, p.id DESC`, [
    bookingId,
  ])
  return rows
}

async function findPayment(bookingId, paymentId) {
  const [rows] = await pool.query(`SELECT ${PAYMENT_COLUMNS} FROM ${PAYMENT_FROM} WHERE p.id = ? AND p.booking_id = ? LIMIT 1`, [paymentId, bookingId])
  return rows[0] ?? null
}

/** A request (emailed next), or with `paidBy` a payment already received (recorded by hand, with its method). */
async function createPayment({ id, bookingId, kind, amount, note, emailTo = null, requestedBy, paidBy, method }) {
  const paid = Boolean(paidBy)
  await pool.execute(
    `INSERT INTO bookings_payment (id, booking_id, kind, amount_npr, status, method, note, email_to, requested_by, paid_at, paid_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${paid ? "NOW(3)" : "NULL"}, ?)`,
    [id, bookingId, kind, amount.toFixed(2), paid ? "paid" : "requested", method ?? null, note ?? null, emailTo, requestedBy ?? null, paid ? paidBy : null],
  )
}

async function markEmailed(id) {
  await pool.execute("UPDATE bookings_payment SET emailed_at = NOW(3) WHERE id = ?", [id])
}

/**
 * The new status, and who did it when: paid records the receiver (a refund undone keeps the first
 * one); refunded keeps them and records the refunder; requested or cancelled clears both.
 */
async function setPaymentStatus(id, status, by) {
  const sets = ["status = ?"]
  const params = [status]
  if (status === "paid" || status === "refunded") {
    sets.push("paid_at = COALESCE(paid_at, NOW(3))", "paid_by = COALESCE(paid_by, ?)")
    params.push(by ?? null)
  } else sets.push("paid_at = NULL", "paid_by = NULL")
  if (status === "refunded") {
    sets.push("refunded_at = NOW(3)", "refunded_by = ?")
    params.push(by ?? null)
  } else sets.push("refunded_at = NULL", "refunded_by = NULL")
  params.push(id)
  await pool.execute(`UPDATE bookings_payment SET ${sets.join(", ")} WHERE id = ?`, params)
}

/* ---------- Studio settings ---------- */

async function getSetting(name) {
  const [rows] = await pool.query(
    "SELECT s.value, s.updated_at, u.full_name AS updated_by_name FROM studio_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.name = ?",
    [name],
  )
  return rows[0] ?? null
}

async function setSetting(name, value, by) {
  await pool.execute(
    `INSERT INTO studio_settings (name, value, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
    [name, value, by ?? null],
  )
}

module.exports = {
  page,
  findRow,
  summary,
  findBooking,
  payments,
  findPayment,
  createPayment,
  PAYMENT_COLUMNS,
  PAYMENT_FROM,
  likeEscape,
  markEmailed,
  setPaymentStatus,
  getSetting,
  setSetting,
}
