/**
 * roles, permissions, role_permissions. ensureCatalog() copies utils/roles.js
 * into the tables at startup; permissionCodes() is what requirePerm checks.
 */
const { pool, withTransaction } = require("../config/dbconfig")
const { PERMISSIONS, SYSTEM_ROLES } = require("../utils/roles")

/** Upserts every permission and role, and sets each role's permissions to exactly its list. */
async function ensureCatalog() {
  await withTransaction(async (conn) => {
    for (const [code, module, description] of PERMISSIONS) {
      await conn.execute(
        `INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE module = VALUES(module), description = VALUES(description)`,
        [code, module, description],
      )
    }
    for (const role of SYSTEM_ROLES) {
      await conn.execute(
        `INSERT INTO roles (slug, name, description, \`rank\`, is_staff, is_system) VALUES (?, ?, ?, ?, ?, TRUE)
         ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), \`rank\` = VALUES(\`rank\`),
                                 is_staff = VALUES(is_staff), is_system = TRUE`,
        [role.slug, role.name, role.description, role.rank, role.isStaff],
      )
      await conn.execute("DELETE FROM role_permissions WHERE role_slug = ?", [role.slug])
      const placeholders = role.permissions.map(() => "?").join(", ")
      await conn.execute(
        `INSERT INTO role_permissions (role_slug, permission_id)
         SELECT ?, id FROM permissions WHERE code IN (${placeholders})`,
        [role.slug, ...role.permissions],
      )
    }
  })
  cache.clear()
}

// Permissions change only when the server restarts with a new utils/roles.js, so a short
// in-process cache saves a query on every request.
const cache = new Map()
const TTL_MS = 60_000

/** The permission codes of a role, as a Set. */
async function permissionCodes(roleSlug) {
  const hit = cache.get(roleSlug)
  if (hit && hit.until > Date.now()) return hit.codes
  const [rows] = await pool.execute(
    `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_slug = ?`,
    [roleSlug],
  )
  const codes = new Set(rows.map((r) => r.code))
  cache.set(roleSlug, { codes, until: Date.now() + TTL_MS })
  return codes
}

async function find(slug) {
  const [rows] = await pool.execute("SELECT slug, name, description, `rank`, is_staff FROM roles WHERE slug = ?", [slug])
  return rows[0] ?? null
}

async function list() {
  const [rows] = await pool.query("SELECT slug, name, description, `rank`, is_staff FROM roles ORDER BY `rank`")
  return rows
}

module.exports = { ensureCatalog, permissionCodes, find, list }
