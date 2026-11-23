/**
 * The fixed catalogue of permissions and roles. The tables in schema.sql
 * (roles, permissions, role_permissions) are filled from here when the server
 * starts (models/role.js ensureCatalog), so this file is the one place to add a
 * permission or change what a role may do.
 *
 * There are no organizations: every account has exactly one role
 * (users.role_slug). Sign-up on the website makes a client; staff accounts are
 * made with `npm run user:create` or promoted by a studio lead.
 *
 * Slugs must match ^[a-z][a-z_]{1,29}$ (CHECK on roles.slug).
 */

/** [code, module, description]. Codes look like "access_code.manage" (see middleware/requireperm.js). */
const PERMISSIONS = [
  ["gallery.view_own", "galleries", "Open the galleries shared with this account"],
  ["panel.access", "panel", "Open the photographer panel"],
  ["event.view", "events", "See events and their folders"],
  ["event.manage", "events", "Create and rename events"],
  ["event.delete", "events", "Delete an event with every photo and video in it"],
  ["photo.upload", "photos", "Upload photos"],
  ["photo.manage", "photos", "Move, sort and remove photos"],
  ["access_code.view", "galleries", "See gallery codes"],
  ["access_code.manage", "galleries", "Create, extend and revoke gallery codes"],
  ["booking.view", "bookings", "See bookings"],
  ["booking.manage", "bookings", "Take bookings and send the team"],
  ["client.view", "clients", "See clients"],
  ["client.manage", "clients", "Add and edit clients"],
  ["payment.view", "payments", "See payments"],
  ["payment.manage", "payments", "Record and change payments"],
  ["team.view", "team", "See the team and who is free"],
  ["team.manage", "team", "Mark days off and change the team"],
  ["storage.view", "storage", "See storage use"],
  ["users.view", "users", "See every account and its role"],
  ["users.manage", "users", "Change roles and disable accounts"],
  ["audit.view", "users", "See the security log"],
]

const ALL = PERMISSIONS.map(([code]) => code)
const STAFF_BASE = ["panel.access", "event.view", "team.view", "storage.view"]

/**
 * The roles, lowest first. `rank` orders them: nobody can give a role ranked
 * above their own, or change someone ranked at or above them (users service).
 */
const SYSTEM_ROLES = [
  {
    slug: "client",
    name: "Client",
    rank: 10,
    isStaff: false,
    description: "Signed up on the website. Sees the galleries shared with them.",
    permissions: ["gallery.view_own"],
  },
  {
    slug: "assistant",
    name: "Assistant",
    rank: 20,
    isStaff: true,
    description: "Helps on the day: uploads photos and sees the bookings.",
    permissions: [...STAFF_BASE, "photo.upload", "booking.view"],
  },
  {
    slug: "editor",
    name: "Editor",
    rank: 30,
    isStaff: true,
    description: "Sorts and finishes the photos, and shares galleries.",
    permissions: [...STAFF_BASE, "photo.upload", "photo.manage", "event.delete", "access_code.view", "access_code.manage", "client.view"],
  },
  {
    slug: "photographer",
    name: "Photographer",
    rank: 40,
    isStaff: true,
    description: "Runs events end to end: events, photos, gallery codes, bookings and clients.",
    permissions: [
      ...STAFF_BASE,
      "event.manage",
      "event.delete",
      "photo.upload",
      "photo.manage",
      "access_code.view",
      "access_code.manage",
      "booking.view",
      "booking.manage",
      "client.view",
      "client.manage",
      "payment.view",
    ],
  },
  {
    slug: "studio_lead",
    name: "Studio lead",
    rank: 90,
    isStaff: true,
    description: "Runs the studio. Full access, including payments, roles and the security log.",
    permissions: ALL.filter((code) => code !== "gallery.view_own"),
  },
]

const CLIENT_ROLE = "client"
const BY_SLUG = new Map(SYSTEM_ROLES.map((role) => [role.slug, role]))

// Catch typos in the lists above when the server starts, not when someone is refused.
for (const role of SYSTEM_ROLES) {
  const unknown = role.permissions.filter((code) => !ALL.includes(code))
  if (unknown.length) throw new Error(`utils/roles.js: role "${role.slug}" has unknown permissions: ${unknown.join(", ")}`)
  if (!/^[a-z][a-z_]{1,29}$/.test(role.slug)) throw new Error(`utils/roles.js: "${role.slug}" isn't a valid role slug`)
}

/** The role's definition, or undefined. */
const roleOf = (slug) => BY_SLUG.get(slug)

module.exports = { PERMISSIONS, SYSTEM_ROLES, CLIENT_ROLE, roleOf }
