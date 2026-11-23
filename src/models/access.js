/**
 * The Access page's queries (services/access.js): every row of users with its role, a page at a
 * time, the counts behind the filters, and deleting an account. Every query takes `?` parameters.
 * Role and status changes go through models/user.js (setRole, setStatus).
 */
const { pool } = require("../config/dbconfig")

const COLUMNS = `u.id, u.full_name, u.email, u.mobile, u.photo_key, u.role_slug, u.status, u.email_verified_at,
  u.last_login_at, u.created_at, r.name AS role_name, r.rank AS role_rank, r.is_staff AS role_is_staff`

/** "50%_off" → "50\%\_off": typed text is matched literally inside LIKE. */
const likeEscape = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`)

/**
 * Up to `limit` accounts, newest first (then id), after `cursor` ({ at, id }).
 * role / status: one slug, or undefined for every one; text: part of the name, email or mobile.
 */
async function page({ role, status, text, cursor, limit }) {
  const where = []
  const params = []
  if (role) {
    where.push("u.role_slug = ?")
    params.push(role)
  }
  if (status) {
    where.push("u.status = ?")
    params.push(status)
  }
  if (text) {
    const like = `%${likeEscape(text)}%`
    // mobiles are kept as +9779812345678: "981 234 5678" finds them too
    const digits = text.replace(/[\s()-]/g, "")
    where.push("(u.full_name LIKE ? OR u.email LIKE ? OR u.mobile LIKE ?)")
    params.push(like, like, `%${likeEscape(digits || text)}%`)
  }
  if (cursor) {
    where.push("(u.created_at < ? OR (u.created_at = ? AND u.id < ?))")
    params.push(cursor.at, cursor.at, cursor.id)
  }
  params.push(Number(limit))
  const [rows] = await pool.query(
    `SELECT ${COLUMNS}
       FROM users u JOIN roles r ON r.slug = u.role_slug
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ?`,
    params,
  )
  return rows
}

/** How many accounts have each status and each role: [{ status, role_slug, n }]. */
async function counts() {
  const [rows] = await pool.query("SELECT status, role_slug, COUNT(*) AS n FROM users GROUP BY status, role_slug")
  return rows.map((r) => ({ status: r.status, role: r.role_slug, n: Number(r.n) }))
}

/** Package payments made from the account (hire_payments keeps them: ON DELETE RESTRICT). */
async function paymentCount(id) {
  const [rows] = await pool.execute("SELECT COUNT(*) AS n FROM hire_payments WHERE user_id = ?", [id])
  return Number(rows[0]?.n ?? 0)
}

/**
 * Deletes the account. Its sessions, tokens, crew places, days off and gallery memberships go with
 * it (ON DELETE CASCADE); bookings, events, uploads, codes and the security log keep their rows
 * with the account taken off them (ON DELETE SET NULL). Returns true when a row was deleted.
 */
async function remove(id) {
  const [result] = await pool.execute("DELETE FROM users WHERE id = ?", [id])
  return result.affectedRows > 0
}

module.exports = { page, counts, paymentCount, remove }
