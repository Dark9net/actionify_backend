/** auth_events: the security log (written through utils/audit.js). */
const { pool } = require("../config/dbconfig")

async function create({ userId = null, email = null, event, ip = null, userAgent = null, detail = null }) {
  await pool.execute("INSERT INTO auth_events (user_id, email, event, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?, ?)", [
    userId,
    email ? String(email).slice(0, 254) : null,
    event,
    ip,
    userAgent ? String(userAgent).slice(0, 512) : null,
    detail ? JSON.stringify(detail) : null,
  ])
}

/** The newest events, optionally for one user (for studio leads). */
async function list({ userId = null, limit = 100 } = {}) {
  const [rows] = await pool.query(
    `SELECT e.id, e.user_id, e.email, e.event, e.ip, e.user_agent, e.detail, e.at, u.full_name
       FROM auth_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE (? IS NULL OR e.user_id = ?)
      ORDER BY e.id DESC LIMIT ?`,
    [userId, userId, Number(limit)],
  )
  return rows
}

module.exports = { create, list }
