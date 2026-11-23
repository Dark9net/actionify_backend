/**
 * users: accounts and their role. Every query takes `?` parameters. Pass `db`
 * (a connection from withTransaction) to run inside a transaction.
 */
const { pool } = require("../config/dbconfig")

const COLUMNS = `u.id, u.full_name, u.email, u.mobile, u.photo_key, u.role_slug, u.password_hash, u.email_verified_at, u.status,
  u.failed_logins, u.locked_until, u.password_changed_at, u.last_login_at, u.created_at,
  r.name AS role_name, r.rank AS role_rank, r.is_staff AS role_is_staff`
const FROM = "users u JOIN roles r ON r.slug = u.role_slug"

async function findByEmail(email, db = pool) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM ${FROM} WHERE u.email = ? LIMIT 1`, [email])
  return rows[0] ?? null
}

async function findById(id, db = pool) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM ${FROM} WHERE u.id = ? LIMIT 1`, [id])
  return rows[0] ?? null
}

/** Locks the row until the transaction ends (password changes, role changes). */
async function findByIdForUpdate(id, db) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM ${FROM} WHERE u.id = ? LIMIT 1 FOR UPDATE`, [id])
  return rows[0] ?? null
}

async function create(
  { id, fullName, email, roleSlug = "client", status = "pending", passwordHash, termsVersion = null, termsAcceptedAt = null, emailVerifiedAt = null },
  db = pool,
) {
  await db.execute(
    `INSERT INTO users (id, full_name, email, role_slug, status, password_hash, terms_version, terms_accepted_at, email_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, fullName, email, roleSlug, status, passwordHash, termsVersion, termsAcceptedAt, emailVerifiedAt],
  )
}

async function markVerified(id, db = pool) {
  await db.execute("UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW(3)) WHERE id = ?", [id])
}

/**
 * One more wrong password, in one statement so parallel attempts all count. Locks the account
 * for `lockMinutes` once `max` is reached. Returns { failedLogins, lockedUntil }.
 */
async function recordFailedLogin(id, max, lockMinutes, db = pool) {
  await db.execute(
    `UPDATE users
        SET locked_until = IF(failed_logins + 1 >= ?, NOW(3) + INTERVAL ? MINUTE, locked_until),
            failed_logins = IF(failed_logins + 1 >= ?, 0, failed_logins + 1)
      WHERE id = ?`,
    [max, lockMinutes, max, id],
  )
  const [rows] = await db.execute("SELECT failed_logins, locked_until FROM users WHERE id = ?", [id])
  return { failedLogins: rows[0]?.failed_logins ?? 0, lockedUntil: rows[0]?.locked_until ?? null }
}

async function recordLogin(id, db = pool) {
  await db.execute("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW(3) WHERE id = ?", [id])
}

/** A new password: every token issued before now stops working (password_changed_at). */
async function setPassword(id, passwordHash, db = pool) {
  await db.execute(
    "UPDATE users SET password_hash = ?, password_changed_at = NOW(3), failed_logins = 0, locked_until = NULL WHERE id = ?",
    [passwordHash, id],
  )
}

/** The same password, re-hashed at a higher bcrypt cost (sessions stay valid). */
async function upgradeHash(id, passwordHash, db = pool) {
  await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, id])
}

async function updateName(id, fullName, db = pool) {
  await db.execute("UPDATE users SET full_name = ? WHERE id = ?", [fullName, id])
}

/** "+9779812345678", or null to remove it. */
async function setMobile(id, mobile, db = pool) {
  await db.execute("UPDATE users SET mobile = ? WHERE id = ?", [mobile, id])
}

/** The profile photo's key on R2, or null to take it off. */
async function setPhotoKey(id, key, db = pool) {
  await db.execute("UPDATE users SET photo_key = ? WHERE id = ?", [key, id])
}

async function setRole(id, roleSlug, db = pool) {
  await db.execute("UPDATE users SET role_slug = ? WHERE id = ?", [roleSlug, id])
}

async function setStatus(id, status, db = pool) {
  await db.execute("UPDATE users SET status = ? WHERE id = ?", [status, id])
}

/** Everyone, newest first (Users list for studio leads). */
async function list({ limit = 200, offset = 0 } = {}) {
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role_slug, u.status, u.email_verified_at, u.last_login_at, u.created_at,
            r.name AS role_name, r.rank AS role_rank, r.is_staff AS role_is_staff
       FROM ${FROM} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    [Number(limit), Number(offset)],
  )
  return rows
}

module.exports = {
  findByEmail,
  findById,
  findByIdForUpdate,
  create,
  markVerified,
  recordFailedLogin,
  recordLogin,
  setPassword,
  upgradeHash,
  updateName,
  setMobile,
  setPhotoKey,
  setRole,
  setStatus,
  list,
}
