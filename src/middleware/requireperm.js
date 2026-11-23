/**
 * Role-based permissions. Always place after requireAuth (middleware/auth.js),
 * which sets req.user = { id, sessionId, role }.
 *
 *   router.use(requireAuth, requireStaff)                                   // staff only
 *   router.post("/gallery-codes", requirePerm("access_code.manage"), …)     // needs every code listed
 *   router.get("/bookings", requireAnyPerm("booking.view", "booking.manage"), …) // needs one of them
 *   router.get("/audit", requireRole("studio_lead"), …)                     // by role (prefer permissions)
 *
 * A role's permissions come from role_permissions (filled from utils/roles.js),
 * looked up once per request and kept on req.access for controllers:
 *   { role, permissions, can(code) }      e.g. if (req.access.can("payment.manage")) …
 *
 * Errors: 403 FORBIDDEN (with `required`).
 */
const roles = require("../models/role")
const { roleOf } = require("../utils/roles")
const { HttpError } = require("../utils/http-error")

/** e.g. "access_code.manage", "panel.access" */
const PERMISSION_CODE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/** Works out what the signed-in user may do (once; later calls reuse req.access). */
async function loadAccess(req) {
  if (req.access) return req.access
  if (!req.user?.role) throw new Error("requirePerm/requireRole must come after requireAuth")
  const permissions = await roles.permissionCodes(req.user.role)
  req.access = Object.freeze({ role: req.user.role, permissions, can: (code) => permissions.has(code) })
  return req.access
}

function checkCodes(name, codes) {
  if (codes.length === 0) throw new Error(`${name}() needs at least one permission code`)
  for (const code of codes) {
    if (!PERMISSION_CODE.test(code)) throw new Error(`${name}(): "${code}" isn't a permission code like "event.view"`)
  }
}

const forbidden = (required) =>
  new HttpError(403, "Your role can't do this. Ask the studio lead for access.", { code: "FORBIDDEN", details: { required } })

/** Allows the request only if the user's role has every one of `codes`. */
function requirePerm(...codes) {
  checkCodes("requirePerm", codes)
  return async (req, _res, next) => {
    const { can } = await loadAccess(req)
    const missing = codes.filter((code) => !can(code))
    if (missing.length) return next(forbidden(missing))
    next()
  }
}

/** Allows the request if the user's role has at least one of `codes`. */
function requireAnyPerm(...codes) {
  checkCodes("requireAnyPerm", codes)
  return async (req, _res, next) => {
    const { can } = await loadAccess(req)
    if (!codes.some(can)) return next(forbidden(codes))
    next()
  }
}

/** Allows the request only for these role slugs. Prefer permissions where you can. */
function requireRole(...slugs) {
  if (slugs.length === 0) throw new Error("requireRole() needs at least one role")
  return (req, _res, next) => {
    if (!slugs.includes(req.user?.role)) return next(forbidden(slugs))
    next()
  }
}

/** Staff only: the photographer panel (panel.access). */
const requireStaff = requirePerm("panel.access")

/** True when the role is a staff role (from utils/roles.js). */
const isStaffRole = (slug) => Boolean(roleOf(slug)?.isStaff)

module.exports = { requirePerm, requireAnyPerm, requireRole, requireStaff, loadAccess, isStaffRole }
